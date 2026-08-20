# 15 — Mongoose Adapter

`@kavo/mongoose` implements `RepositoryAdapter` (= `EntityReader` +
`EntityWriter`) over a Mongoose model and feeds core's metadata seam from
the model's `Schema`. Core scope matches `@kavo/typeorm` (doc 09) and
`@kavo/prisma` (doc 14): CRUD with hard delete, filtering, sorting,
pagination, optional counting, soft delete/restore/purge (doc 11), and
relation loading (doc 12). `mongoose` is a peerDependency; `@kavo/core`
never imports it, and `@kavo/mongoose`'s own `src` imports no Mongoose
value either — every shape it needs is described structurally in
`mongoose-like.ts` and reached through one runtime guard.

This is the first adapter over a **document** store rather than a
relational one, and the three places that shows are §1 (identity and
`ObjectId`), §2 (no joins) and §3 (populate).

## 1. Models are entity identities; `ObjectId` converts at the boundary (ADR-0018)

A Mongoose model is a real constructor, so it already satisfies core's
`ClassRef` identity — there are **no marker classes** and **no `entities`
list** here, unlike `@kavo/prisma` (ADR-0017).
`createInfrastructure(connection)` takes anything with a `models`
record (`mongoose`, `mongoose.connection`, or a `createConnection()`
handle), which is both the relation-target registry and the reason nothing
has to be declared twice:

```ts
const User = mongoose.model("User", userSchema);
const kavo = createMongooseKavo(mongoose.connection);
const users = kavo.createCrud(User); // that is the whole wiring
```

Because a model's function `name` is the useless string `"model"`, every
name comes from `modelName`. An entity that is not a model is caught at
runtime by `asModel` with a `ConfigurationException` — no type-level check
can distinguish the two.

MongoDB's `_id` is an `ObjectId`, which core's `EntityId = string | number`
does not admit. Rather than widen core for one ORM, the conversion happens
here: **every `ObjectId` leaving the adapter becomes its hex string**, and
the walk recurses because populated relations carry their own `_id`s. The
inbound direction needs no code — Mongoose casts values against the schema,
so this package never constructs an `ObjectId` and never imports `bson`.
Full rationale, including why a malformed id is a 404, in ADR-0018.

`buildEntityMetadata` reads `schema.paths`: `_id` as the id field, scalar
fields with `FieldKind` + nullability + generated flags, enum members, and
relation descriptors (`includable: false` always). Notable derivations:

| Schema declaration                    | Derived as                                      |
| ------------------------------------- | ----------------------------------------------- |
| `_id` (`auto: true`)                  | field, `kind: "string"`, `generated: true`      |
| `timestamps: true` (or renamed)       | fields, `generated: true`                       |
| `default: Date.now` (a function)      | `generated: true` — computed per write          |
| `default: "active"` / `default: null` | `generated: false` — a writable fallback        |
| `[String]`, `[Number]`                | field, kind from the element, `nullable: false` |
| `Mixed`, subdocument, `Map`, `Buffer` | field, `kind: "json"`                           |
| `{ type: ObjectId, ref: "X" }`        | relation, `cardinality: "one"`                  |
| `[{ type: ObjectId, ref: "X" }]`      | relation, `cardinality: "many"`                 |
| `ObjectId` with no `ref`              | field, `kind: "string"` — not a relation        |
| `refPath` / a function `ref`          | field — the target is per-document, so there is |
|                                       | no single entity for the registry to point at   |
| `{ address: { city: String } }`       | one `json` field named `address` — see below    |
| `__v` (the version key)               | **excluded entirely** — see below               |
| `select: false` on any path           | **excluded entirely** — see below               |

**A `ref` path is registered twice — as a relation _and_ as a field.**
Unlike SQL, where `blogId` and `blog` are separate properties, Mongoose
stores the reference under the relation's own name, so the ref path _is_
the foreign key. Registering it as a field too is what puts the reference
id on the default filter/sort/select allowlists, since core derives those
from `metadata.fields` alone — without it `?filter[author][eq]=<id>` is a
400 and there is no way to ask "which books does this author have?".

It does **not** put the raw id in responses: `DefaultSerializer` skips any
projected key that is also a relation name, emitting the edge only when it
is included (doc 04 §5). So an un-included `author` is absent rather than
showing its id, where `@kavo/typeorm` would show `authorId`. That
asymmetry is core's to resolve — an adapter cannot reach it — and it is
the one place a document store's single-name FK does not map cleanly onto
core's two-property model.

**Nested object literals are collapsed to their root.** Mongoose flattens
`{ address: { city: String } }` into the paths `address.city`,
`address.zip` — dotted names that are _not_ keys of the document core
receives. Registered verbatim they would describe fields that never match:
the serializer's `key in source` test fails and the whole nested object
vanishes from every response, while the deserializer drops it from every
write. So the nesting is collapsed into one `json` field named `address`,
which is exactly the shape a single-nested sub-schema (`instance:
"Embedded"`) already produces — both spellings of "a nested object" end up
described identically.

Mongoose's `__v` is storage bookkeeping the caller never declared, so it
stays out of the entity description. Because the default serializer
projects onto `metadata.fields` (doc 04 §5), excluding it there is also
what keeps it out of every derived DTO and every response.

**`select: false` is excluded for the same reason, and it matters more.**
That flag is Mongoose's own "never return this" — the idiomatic home of a
password hash or an API key — so such a path is left out of the entity
description entirely rather than merely hidden from responses. Hiding
alone leaks it two ways. Reads are `lean`, so Mongoose applies the
projection and the value is absent from the body, but the _predicate_ still
runs in the database: an allowlisted `filter[apiKey][like]=sk_live_9%` is a
blind, character-at-a-time extraction oracle for a value that never appears
in any response. And `create` returns the hydrated document Mongoose built,
where a query projection does not apply at all, so a `POST` would echo a
server-generated secret that no `GET` ever returns.

The cost is that Kavo does not manage the path at all — it is not readable,
writable, filterable, or sortable. An app that needs to _write_ one (a
password at registration) does so through a custom operation or the model
directly, which is the right default once the schema has declared the value
un-returnable. `@kavo/typeorm` has the same blind spot for
`@Column({ select: false })`; the exposure is higher here only because
`select: false` is standard Mongoose practice rather than a rarity.

**Arbitrary-precision numerics cross the wire as numbers.** `BigInt` and
`Decimal128` paths are declared `kind: "number"`, and the mapping layer
converts them to match — a hydrated document's `toObject()` yields a real
`bigint`, which `JSON.stringify` refuses outright, and a `Decimal128`
would otherwise serialize as `{"$numberDecimal":"1.50"}`. The cost is JS
number precision (a `Decimal128` beyond ~15 significant digits rounds);
surfacing them as strings instead would keep the precision but break
filtering, since MongoDB compares numerically across its numeric BSON
types and not against a string.

`EntityMetadata.softDeleteField` is always `null` — Mongoose declares no
`@DeleteDateColumn` equivalent — so soft delete is always explicit
`softDelete.field` configuration for this adapter, never auto-detected.
Same position as `@kavo/prisma`.

## 2. Query translation (Filter AST → MongoDB query document)

`translateFilter` maps `AND`/`OR` onto `$and`/`$or` and `NOT` onto `$nor`.
An empty `$and`/`$or` is rejected by MongoDB outright, so each connective's
identity is spelled explicitly for hand-built ASTs the parser would not
produce.

Two properties are load-bearing:

**Every comparison is wrapped in an explicit operator** — `{ field: { $eq:
v } }`, never the bare `{ field: v }` shorthand. Under the shorthand an
object-valued filter would be spliced in as _operators_: `{ "$ne": null }`
is the classic NoSQL injection payload that turns an equality check into
"match everything". Core coerces filter values to scalars upstream, so this
is defence in depth rather than the only guard — and in practice the
attempt then also fails Mongoose's own cast, surfacing as a 400.

**`LIKE`/`ILIKE` regex-escape the caller's pattern.** MongoDB has no `LIKE`,
so these become `$regex`. The pattern is translated character by character
per the wire grammar (doc 05): `%` → `.*`, `_` → `.`, `\%`/`\_` → the
literal character, and **everything else is regex-escaped**. The result is
anchored, because SQL `LIKE` matches the whole value. So the only pattern
syntax a caller can reach is the `%`/`_`/`\` the grammar grants them — a
filter value of `(a|b)` matches that literal seven-character string.
`ILIKE` adds the `i` option; unlike Prisma (doc 14 §2) there is no
connector caveat, since `$regex` is case-insensitive everywhere.

`$regex` is emitted as a **string source plus `$options`** rather than a
`RegExp` instance, which keeps a translated filter plain comparable data
and is what lets the translator be unit-tested with no database.

**Relation paths are refused, not translated.** MongoDB resolves a dotted
path _inside_ a document, never across a `ref`. `{ "address.city": … }` is
a first-class query because `address` is an embedded subdocument, and it
passes straight through; `{ "author.name": … }` is not a join — `author`
holds an `ObjectId`, so the path would quietly match nothing. Since a
dropped predicate is the one thing an adapter must never do, a filter or
sort rooted at a relation raises `KAVO_QUERY_UNSUPPORTED_PARAM` (400).
Reaching it always means a relation path was explicitly allowlisted, since
core's default allowlists hold scalar fields only. `$lookup` would lift
this restriction and is the natural follow-up.

**Document-store null semantics.** `{ $eq: null }` matches a stored `null`
_and_ an absent field, and `$ne`/`$nor` match documents where the field is
missing. This differs from SQL's three-valued logic, where `NOT (col =
'x')` excludes `NULL` rows. Absent-means-no-value is the right reading in a
document store, so it is kept rather than emulated away.

## 3. Includes: populate, and no join/batch split

`@kavo/typeorm` translates `IncludeNode.strategy` (`join` vs. `batch`)
because it drives a SQL query builder, where a to-many `JOIN` multiplies
root rows and breaks core's pagination-correctness rule (doc 12).
Mongoose's `populate` has no such failure mode: it issues its own query per
edge and stitches in memory, to-one and to-many alike, so an include never
disturbs root pagination. This adapter therefore **ignores
`IncludeNode.strategy`** and maps every node the same way — same conclusion
as `@kavo/prisma`, reached for the same reason.

Soft-deleted related documents are excluded with `match`, which behaves
correctly on both cardinalities: a to-one edge comes back `null`, a to-many
entry is filtered out of the array. A root `withDeleted` is the root's own
opt-in and never widens an included relation (doc 12's rule).

Note that Mongoose models a to-many edge as an **array of refs on the
parent**, the mirror image of a SQL foreign key on the child. The relation
descriptors core sees are identical either way. Mongoose's _virtual_
populate (`schema.virtual(…, { ref, localField, foreignField })`) is the
other idiomatic spelling and is **not** supported: virtuals are absent from
`schema.paths`, so the metadata seam cannot see them. That is the main
known gap in this adapter's relation coverage.

## 4. Reads are lean; writes are single-round-trip where they can be

Every read passes `lean: true`. Hydrated Mongoose documents carry getters,
virtuals and change tracking that core has no use for and the serializer
would have to strip; lean reads return plain objects, which
`toPlainDocument` then walks for `ObjectId`s.

`update`/`patch` are one `findOneAndUpdate` against the **live** scope, so a
soft-deleted document is invisible to writes exactly as it is to reads, a
missing one is reported without a separate existence check, and there is no
read-then-write gap for a concurrent delete.

`delete` and `restore` keep that same property: the state predicate
(`deletedAt` null / not-null) rides **in** the `findOneAndUpdate` filter, so
the transition is atomic and two concurrent deletes cannot both succeed.
They read only when the write matched nothing — and then only to tell
"already deleted" (409) from "never existed" (404), which are different
answers that only the stored marker distinguishes. The read no longer
_decides_ the write; it explains a miss. `purge` is the one that reads
first, because it must confirm the marker before removing a document
permanently.

An empty `$set` is skipped rather than sent, since MongoDB rejects it and
"nothing to write" is not an error.

## 5. Pagination & count strategy

`findMany` filters by `readFilter(query)` rather than `query.filter`:
under cursor pagination it AND-s the keyset predicate onto the client
filter, translated by the same `translateFilter` as any other AST node —
the `GT`/`LT`/`GTE`/`LTE` comparisons `keysetExpression` builds become
`$gt`/`$lt`/`$gte`/`$lte`, and its `OR`-of-`AND` shape becomes `$or`/`$and`
per §2 — and it is the identity function under offset pagination
(ADR-0021). The read narrows with `isCursorPagination` before touching
`.offset` — a `CursorPagination` carries none — and passes `skip: 0` on a
cursor page, since the keyset predicate already excludes the rows before
it; `limit: pagination.limit` bounds the page either way.

`count()` is a dedicated `countDocuments()` call built from `query.filter`
— not `readFilter(query)`, since `total` is the size of the whole match
set, not of what remains after the cursor — never fetch-then-length: the
engine only calls `count` when `pagination.count` is true, so
`total: null` costs zero extra queries.

## 6. Error-mapping table

`mapDriverError` discriminates on `error.name` and the numeric server
`code`, both read structurally. The original error always travels as
`cause`:

| Driver condition                         | Exception                                  |
| ---------------------------------------- | ------------------------------------------ |
| `CastError` on the id path, id addressed | `NotFoundException`                        |
| `CastError` anywhere else                | `QueryValidationException` (400)           |
| duplicate key (`11000`/`11001`)          | `ConflictException`                        |
| write conflict (`112`)                   | `TransactionException` (`retryable: true`) |
| anything else                            | `PersistenceException` with `cause`        |

The id-addressed qualifier matters. `GET /books/not-an-objectid` names a
document that cannot exist, so it answers 404 (ADR-0018) — but `_id` is on
core's default filter allowlist, so `GET /books?filter[_id][eq]=not-an-
objectid` raises the _same_ `CastError` on the _same_ path, and answering
404 there would claim the collection endpoint itself is missing. Only
`findOneById` and the id-addressed writes opt into the 404 reading;
`findOne`/`findMany`/`count`/`create` treat a cast failure as the 400 it
is.

Mongoose's `ValidationError` is deliberately **not** mapped. Doc 06 scopes
every catalogued 400 to query grammar, allowlists and limits; there is no
request-body validation code, and minting one from inside an adapter would
be an adapter widening core's error contract from the outside. Both other
adapters leave the equivalent not-null violation unmapped for the same
reason. A dedicated body-validation code is the clean fix and belongs in
core.

**Soft delete and unique indexes.** Same caveat as the other adapters: a
soft-deleted document still occupies its unique indexes, so re-creating
"the same" document after a soft delete raises `11000` — a 409, which is
the honest answer since the value _is_ taken. The fix is a partial unique
index scoped to live documents (`partialFilterExpression: { deletedAt:
null }`).

## 7. Attachment points for later work

- **Transactions:** no `TransactionManager`. MongoDB sessions require a
  replica set, and `@kavo/prisma` ships none either (doc 14 §6) — the seam
  stays unbuilt across all three adapters.
- **`$lookup`:** would lift the relation-path restriction in §2 and enable
  sorting by a related field. The rejection is deliberately loud so that
  adding it later is a capability gain, not a bug fix.
- **Virtual populate:** see §3 — needs a metadata source beyond
  `schema.paths`.
- **Un-included reference ids:** see §1 — also a core-side change.
- **Projections:** `query.fields` is applied by core's serializer, not
  pushed down as a MongoDB projection. Correct today, and a clear
  optimization later; the same is true of `@kavo/prisma`.
- **Composite primary keys:** out of scope, same as the other adapters.

## 8. Performance posture

Filters translate to MongoDB's own indexed-field operators. No N+1:
`populate` batches each edge into one query, and `maxLimit` clamps upstream.
One caveat worth naming — an unanchored `LIKE` pattern (`%x%`) compiles to
a leading-wildcard regex, which MongoDB cannot serve from an index; that is
inherent to substring search and is why filterable fields are allowlisted.

Integration tests run the real engine→adapter stack against a real MongoDB
via `mongodb-memory-server` (`tests/adapter.spec.ts`,
`tests/soft-delete.spec.ts`, `tests/includes.spec.ts`), with metadata,
filter translation and error mapping covered by database-free unit suites
and the `ClassRef` claim pinned by a compile-only
`tests/types/model-as-class-ref.test-d.ts`.
