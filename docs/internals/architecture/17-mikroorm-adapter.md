# 17 — MikroORM Adapter

`@kavo/mikroorm` implements `RepositoryAdapter` (= `EntityReader` +
`EntityWriter`) over a MikroORM `EntityManager` and feeds core's metadata
seam from MikroORM's own `MetadataStorage`. Core scope matches
`@kavo/typeorm` (doc 09): CRUD with hard delete, filtering (incl. `NOT`
and relation paths), sorting, pagination, optional counting, soft
delete/restore/purge (doc 11), and relation loading (doc 12).
`@mikro-orm/core` is a peerDependency; `@kavo/core` never imports it.

Where this adapter sits between the other two SQL adapters is worth stating
up front, because nearly every design choice below follows from it:
MikroORM has **TypeORM's entity model** (real decorated runtime classes
carrying their own metadata) and **Prisma's query surface** (a declarative
`FilterQuery` object that nests relation paths natively, not a SQL string
builder). So the metadata seam mirrors `@kavo/typeorm` and the translation
seam mirrors `@kavo/prisma`.

## 1. Entities are their own identity — no marker classes

A MikroORM `@Entity()` class is a real runtime class, so this adapter gets
an entity's `ClassRef` identity for free exactly as `@kavo/typeorm` does.
There is no counterpart to ADR-0017's marker classes (which exist because
Prisma erases its models at compile time) and none to ADR-0018 (which
records that a Mongoose model _is_ the identity): the class the caller
passes to `createCrud` is the class MikroORM registered, matched by name
through `orm.getMetadata()`.

`createInfrastructure(orm)` therefore takes nothing but the ORM instance —
no `entities` list, no datamodel — and neither does `createMikroOrmKavo`.
An entity MikroORM never registered is refused at bootstrap with
`KAVO_CONFIG_INVALID` rather than failing per request.

### Metadata mapping

| Core `EntityMetadata` | MikroORM source                                               |
| --------------------- | ------------------------------------------------------------- |
| `name`                | `meta.className`                                              |
| `idField`             | `meta.primaryKeys[0]` — more than one is refused              |
| `fields`              | properties with `kind: "scalar"` or `"embedded"`              |
| `relations`           | properties with any other `kind` (`m:1`, `1:1`, `1:m`, `m:n`) |
| `softDeleteField`     | always `null` — see §5                                        |

Five details are less obvious than the table suggests:

**Field kind comes from `runtimeType`, not the column type.** MikroORM
normalizes `runtimeType` to the JavaScript type a property actually holds,
which is what core must coerce toward. A `decimal` column surfaces as
`string` there and is reported as `string` — reading `number` off the column
type instead would corrupt values past 2⁵³. The declared `type` is consulted
only as a fallback, for the custom types whose `runtimeType` is `"any"` and
therefore narrows nothing (`JsonType`).

**`BigIntType`'s default mode changed in MikroORM v7.** Declaring a column
with the `"bigint"` shorthand now hands JavaScript a native `bigint` by
default (previously it was a precision-safe string). A native `bigint` is
still reported as `FieldKind` `"number"` here, and — worse — is not
JSON-serializable at all. An app with a `bigint` column must construct the
type explicitly with string mode to keep the old, safe behavior:
`@Property({ type: new BigIntType("string") })`.

**Generated is a union of four independent flags.** MikroORM has no single
"the caller cannot write this" marker, so `generated` is true for an
auto-increment or database-generated column, a property with an
`onCreate`/`onUpdate` hook (the equivalent of TypeORM's
`@CreateDateColumn`/`@UpdateDateColumn`), an optimistic-lock
`version: true`, and `persist: false`.

**A relation target is resolved from `targetMeta`, never by calling the
declaration.** MikroORM accepts two spellings, and they do not arrive the
same: `@ManyToOne(() => Owner)` leaves `property.entity` a thunk resolving to
the class, while `@ManyToOne((): any => "Owner")` leaves it a thunk resolving
to a plain **string**. As of MikroORM v7 the by-name form's thunk return type
no longer includes `string` (`EntityName<T>` is class/`EntitySchema` only),
so `any` is what makes it type-check — the string still works at runtime. The by-name spelling is not
exotic — it is what keeps a bidirectional relation's import cycle off the
runtime graph, so it is exactly what a codebase with a `no-circular`
dependency rule (this one included, see doc 02 §3) reaches for. Calling
`property.entity()` and getting back a string would therefore break for half
the codebases using this adapter. `targetMeta` is what both spellings have
in common; a metadata-storage lookup by entity name backs it up, and the
declared thunk is the last resort. Resolution is deferred until the thunk core holds is
actually called, because a bidirectional relation's target may not be
registered yet when this entity's metadata is derived.

**The single-table-inheritance discriminator is reported generated.** With
`@Entity({ discriminatorColumn: "species" })` on a base and
`discriminatorValue` on each subtype, MikroORM synthesizes a `species`
property on every subtype's metadata. It is write-only bookkeeping: MikroORM
sets it from the subtype being persisted, never hydrates it onto a loaded
entity, and never emits it from `toObject` — so it cannot reach a response
whatever Kavo does, matching `@kavo/typeorm`, where the discriminator has no
entity property at all. What the flag stops is the _inbound_ direction. Left
un-generated it would join the writable projection, and a client sending
`species: "cat"` when creating a Dog would write a row that entity's own
repository can no longer load. Note the column is read from the inheritance
**root**'s metadata: MikroORM records `discriminatorColumn` only there,
while the property itself is inherited by every subtype — and a subtype is
what a caller passes to `createCrud`.

**Embeddable child properties are dropped.** An `@Embedded()` property
contributes both the object-valued parent (`kind: "embedded"`) and one
child per inner column, carrying an `embedded: [parent, child]`
back-reference and a name that is an implementation detail (`address~city`
when stored as an object, `billing_city` when inlined). Only the parent is
addressable on the wire, so the children are filtered out rather than
leaked into derived DTOs or any allowlist. The parent is reported as `json`.

## 2. Query translation (Filter AST → MikroORM `FilterQuery`)

The translator is a pure function over core's AST — no query-builder state,
no join aliases, no parameter numbering — because MikroORM nests relation
paths natively and adds the join itself. A dotted field simply nests one
level deeper, the same shape `@kavo/prisma`'s translator produces.

| AST operator  | MikroORM                                     |
| ------------- | -------------------------------------------- |
| `EQ` / `NE`   | `$eq` / `$ne` (`$ne: null` is `IS NOT NULL`) |
| `GT`…`LTE`    | `$gt`, `$gte`, `$lt`, `$lte`                 |
| `IN`/`NOT_IN` | `$in` / `$nin`                               |
| `LIKE`        | `$like`                                      |
| `ILIKE`       | `$ilike`, or `$like` — see below             |
| `BETWEEN`     | `{ $gte, $lte }`                             |
| `IS_NULL`     | `$eq: null`                                  |
| `IS_NOT_NULL` | `$ne: null`                                  |
| `AND`/`OR`    | `$and` / `$or`                               |
| `NOT`         | `$not` over the group's single child         |

Every comparison is wrapped in an explicit operator (`{ $eq: v }`, never
the bare `{ field: v }` shorthand). Core coerces filter values to scalars
upstream, so this is defence in depth — but an object arriving through the
shorthand would be spliced in as _operators_, and the boundary's job is to
be safe on its own terms.

Falling through the operator switch is impossible: the union is proven
total at build time with `assertNever`, and a forged AST raises
`PersistenceException` (500) rather than silently dropping the predicate
and widening the result set.

**The degenerate empty groups need care.** MikroORM rejects an empty
`$and`/`$or` outright, and `$not: {}` negates _no condition at all_, which
it renders as match-everything — the exact opposite of what an empty `OR`
or `NOT` means. An empty `$in` on the primary key is the one spelling
MikroORM turns into a genuine contradiction on every driver, so that is how
"matches nothing" is written. (Core's parser enforces group arity, so these
only guard hand-built ASTs passed programmatically.)

**`ILIKE` is a declared capability, not a detected one.** `$ilike` works on
PostgreSQL and nowhere else — SQLite, MySQL, and MongoDB receive the token
verbatim and fail with a syntax error. MikroORM's `Platform` exposes
nothing to detect this from, so it is
`MikroOrmInfrastructureOptions.caseInsensitiveFilters`, the same posture
`@kavo/prisma` takes for `mode: "insensitive"`.

It defaults to **`false`**, where `@kavo/prisma`'s equivalent defaults to
`true`. The defaults differ because the failure modes are not symmetric
here: declaring it off on PostgreSQL costs case-insensitivity, while
leaving it on anywhere else makes every `ILIKE` query throw. On SQLite the
default is not even a loss — SQLite's own `LIKE` is already ASCII
case-insensitive.

## 3. Includes: `populate`, and no join/batch split

Core resolves `IncludeNode.strategy` to `join` or `batch` (doc 12), and
this adapter **ignores that split**, exactly as `@kavo/prisma` does. It
does act on `key` (issue #364): the edge is dropped from the `populate`
paths and its bare FK — how MikroORM returns an un-populated to-one — is
rewritten to `{ <pk>: value }` / `null` in `pruneIncluded`.

`@kavo/typeorm` translates the split because it drives a raw SQL query
builder, where a to-many `JOIN` multiplies root rows and separate batched
queries are how that trap is avoided. MikroORM resolves `populate` with its
own queries and applies `limit`/`offset` to the root regardless of load
strategy, so a to-many include never disturbs pagination here — there is
nothing left for the distinction to control. MikroORM's own `strategy`
option is per-query rather than per-relation anyway, so it could not
express a mixed include tree even if it were wanted.

The include tree is flattened to MikroORM's dotted `populate` paths
(`["articles", "articles.notes"]`).

**Soft-deleted related rows are pruned in memory, not in the query** — the
one place this adapter does something the other two do in SQL, and it is
forced. `populateWhere` looks like the right tool and is a trap at more than
one level: a nested condition
(`{ articles: { deletedAt: null, notes: { deletedAt: null } } }`) is read by
MikroORM as a relation-path predicate on the **parent**, so an article whose
notes are all deleted — or which simply has none — is dropped from the
blog's collection entirely instead of arriving with `notes: []`. The dotted
spelling (`{ "articles.notes": … }`) MikroORM rejects outright, and the
parent-only spelling silently leaves every deeper level unscoped. So the
adapter populates everything and walks the loaded tree, which is correct at
any depth.

The rule itself is unchanged from the other adapters: soft-deleted related
rows are excluded from every include, to-one and to-many alike, and a root
`withDeleted` never widens an included relation — the prune runs regardless
of the root's scope. The same walk also guarantees every included relation
is _present_ (`[]` for a to-many, `null` for a to-one), because core's
serializer reads an absent key as "never hydrated" and skips it.

The cost is that soft-deleted related rows are fetched and then discarded.
Soft-deleted _roots_ are still excluded in SQL by `scopeToLive`, which is
where the volume is; the alternatives here are wrong rather than merely
slower.

## 4. The EntityManager is forked per operation

MikroORM is a Unit-of-Work ORM: an `EntityManager` owns an identity map
caching every entity it has loaded. Holding one across requests would serve
stale rows and leak one caller's entities into another's, so **every
adapter method starts from `orm.em.fork()`** — the same scope a
request-scoped `RequestContext` gives a hand-written MikroORM application.
That is also why `createInfrastructure` takes the `MikroORM` instance
rather than an `EntityManager`: it needs something to fork _from_.

Rows are converted to plain objects at the boundary with
`wrap(entity).toObject()`. This is required, not cosmetic: a to-many
relation is a `Collection<T>`, not an array, and core's `DefaultSerializer`
branches on `Array.isArray` to decide whether an included relation is a
list or a single row — a `Collection` would fall down the single-row path
and serialize its internal fields. `@kavo/mongoose` converts documents at
the same seam for the same reason.

Two consequences of `toObject()` are behavior, not implementation detail:
an unpopulated relation collapses to its primary key (harmless — core emits
a relation key only for an included node), and **MikroORM's own property
options apply before core sees the row**, so a
`@Property({ hidden: true })` is dropped and a custom `serializer` runs
first. The ORM's declaration wins there, even over a Kavo DTO that names
the property.

Writes go through the Unit of Work — `em.create` / `wrap(entity).assign`
then `flush` — so lifecycle hooks, `onUpdate` properties, and relation
diffing behave as they would in a hand-written application. `update` and
`patch` share one load-merge-flush primitive; the _shape_ of the payload
differs because the DTO layer differs, not the persistence mechanics. The
row is loaded first regardless, to turn a missing id into a 404, so the
merge costs no extra query. The soft-delete marker writes and the hard
deletes use `nativeUpdate`/`nativeDelete`, whose affected-row count is what
turns a repeat delete into a 404 rather than a silent success.

Core's deserializer narrows a relation value to `{ id }` (ADR-0014), while
MikroORM associates by the bare primary-key value and would read a nested
`{ id }` as a request to _create_ a new entity — so relation values are
unwrapped to the bare key before reaching `create`/`assign`.

## 5. Soft delete is always configured, never detected

`softDeleteField` is always `null` on this adapter's metadata. MikroORM
declares no delete-date column: its soft-delete pattern is a user-defined
`@Filter`, which is a query concern rather than a column declaration, so
there is nothing for the metadata seam to detect — the same position
`@kavo/prisma` and `@kavo/mongoose` are in, and unlike `@kavo/typeorm`,
whose `@DeleteDateColumn` the seam reports.

**That is not the same as "soft delete is off until you configure it."**
`softDelete` defaults to `{ field: "deletedAt", strategy: "auto" }`, and
`resolveSoftDelete` matches the configured _name_ against the entity's own
columns before falling back to `softDeleteField`. So an entity carrying a
plain `deletedAt` property is soft-deletable with no config whatsoever. What
reporting `null` used to cost is narrower and sharper: the adapter cannot
mark the marker column generated, so `DefaultDeserializer` excludes it from
the derived writable projection by name instead — see §7.

There is consequently one marker shape to handle rather than TypeORM's two:
the marker is always an ordinary property, so the `IS NULL` /
`IS NOT NULL` predicate is always spelled out, for all three scopes
(default, `withDeleted`, `onlyDeleted`).

**Do not also enable a MikroORM `@Filter` for soft delete.** Kavo owns the
scoping through `softDelete.field`; a default-on MikroORM filter would AND
a second predicate onto every query and quietly defeat `withDeleted`. Use
one or the other.

## 6. Error-mapping table

| MikroORM condition                                                                                     | Exception                           |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `UniqueConstraintViolationException`                                                                   | `ConflictException` (409)           |
| `ForeignKeyConstraintViolationException` from an insert/update                                         | `UnresolvedRelationException` (422) |
| `ForeignKeyConstraintViolationException` from a delete (`context.operation` is `deleteOne`/`purgeOne`) | `ConflictException` (409)           |
| `DeadlockException` / `LockWaitTimeoutException`                                                       | `TransactionException`, retryable   |
| anything else                                                                                          | `PersistenceException` (500)        |

MikroORM does not name the FK direction, so the two `ForeignKeyConstraintViolationException`
causes are told apart by `context.operation` (issue #365).

The same rows `@kavo/typeorm`'s table has (doc 06), reached
differently. MikroORM normalizes each driver's native error into its own
exception hierarchy before it surfaces, so this adapter matches on those
classes rather than recognizing Postgres SQLSTATEs, MySQL errnos, and
SQLite extended codes itself. Every driver MikroORM supports is covered by
that normalization; anything it does not recognize falls through to
`PersistenceException`, and the original error always travels as `cause`.

Note the line the table draws: unique violations and foreign-key violations
that block `deleteOne`/`purgeOne` are conflicts; an insert/update foreign-key
violation is an unresolved relation instead. A
`NotNullConstraintViolationException` or `CheckConstraintViolationException`
is not the caller's to resolve, so it stays a 500 — the same boundary
`@kavo/typeorm` draws when its SQLite message sniff declines to match a `NOT
NULL` failure.

A soft-deleted row still occupies its unique indexes, so re-creating "the
same" row after a soft delete raises a 409 — the honest answer, since the
value _is_ taken. Kavo never rewrites indexes; the fix is a partial unique
index scoped to live rows.

## 7. Adapter-specific caveats

**`LIKE` escapes are driver-dependent.** MikroORM offers no way to attach
an `ESCAPE` clause to a `LIKE`, so the query grammar's `\` escape for a
literal `%`/`_` (doc 05) is honored only by drivers that default to
backslash — PostgreSQL and MySQL do; SQLite has no default escape
character, so `filter[name][like]=100\%` matches the literal text `100\`
followed by anything rather than the string `100%`. `@kavo/typeorm` emits
`ESCAPE '\'` explicitly and does not have this gap.

**The soft-delete marker and the primary key are excluded from the derived
writable projection by name, not just by `generated`.** Because nothing
declares the marker column, it is an ordinary non-generated property, and
`@PrimaryKey() id: string = v4()` — the idiomatic UUID spelling — carries
none of MikroORM's generated flags either. `DefaultDeserializer` excludes
`metadata.idField` and the resolved `softDelete.field` from its derived
default regardless of `generated`, so a client cannot rewrite a row's
identity or soft-delete/revive it through a plain `PATCH`/`PUT` when the
entity has no explicit write DTO. `mergeAndFlush` additionally strips both
keys from the payload before `assign`, as defence in depth against an
explicit write DTO that names either field: `create` may still assign a
caller-chosen id (a legitimate use for a non-auto-increment key), but an
`update`/`patch` against an _existing_ row never reassigns its id or its
soft-delete state, whatever the registered DTO declares. The one thing this
does not do is let a `PATCH` revive a soft-deleted row even if a DTO wanted
to — writes stay scoped to the live set, so a soft-deleted row 404s on
`PUT`/`PATCH` regardless.

`@kavo/prisma` and `@kavo/mongoose` are in the same position for the same
reason (`@kavo/typeorm` escapes the marker half only because
`@DeleteDateColumn` is detectable and therefore markable) and get the same
fix, since the derivation lives once in `@kavo/core`.

**A `hidden` or `lazy` property is dropped from the seam entirely.** Not
just from responses: excluding it from `fields` is what keeps it off the
_default allowlist_, because a column that is invisible in the body but
filterable in the database is a blind extraction oracle
(`filter[passwordHash][like]=a%` answered by the row count). The trade is
the one `@kavo/mongoose` documents for `select: false` (doc 15 §1): Kavo
does not manage such a property at all — not readable, writable, filterable,
or sortable — so write it through a custom operation or the ORM directly.

**`findOne` by query goes through `em.find` with `limit: 1`.** MikroORM's
entity validator rejects `em.findOne` with an empty `where` outright, while
`em.find` accepts it — and an unfiltered query is a legitimate shape here,
since `EntityReader.findOne`'s contract is "first match of the query, or
`null`" and a query with no filter matches everything. Routing through
`em.find` keeps that contract without an empty-where special case; the two
are otherwise the same query. (No generated route reaches this — the standard
`findOne` operation is by id — but a custom handler calling
`service.engine.execute` does.)

**Composite primary keys are refused** at bootstrap, matching every other
adapter — single-identifier entities are a v6 scope decision, not a
MikroORM limitation.

**No transactions.** `TransactionManager` is unimplemented here, as it is
across every Kavo adapter today — see the `@remarks` on that interface in
`@kavo/core`. This is parity with `@kavo/typeorm`, which also never reads
`context.transaction`, not a gap specific to this adapter.

**`@mikro-orm/core` v6 only.** The peer range is `^6.0.0`. MikroORM v7
removed decorators entirely in favour of `defineEntity`/`EntitySchema`,
which changes how an entity's `ClassRef` identity is obtained — the premise
§1 rests on — so v7 is not claimed until it is actually tested.

## 8. Performance posture

Counting is a dedicated `em.count` issued against `query.filter` — never
`readFilter(query)`, since `total` is the size of the whole match set, not
of what remains after the cursor — only when `query.count` is true, so
`total: null` costs zero queries; never fetch-then-length. `findMany`'s
own `em.find` filters by `readFilter(query)` instead: under cursor
pagination it AND-s the keyset predicate onto the client filter and
composes through the same declarative `FilterQuery` nesting as any other
filter (§2) — no join aliases, no adapter-side branching — and it is the
identity function under offset pagination (ADR-0021). The read narrows
with `isCursorPagination` before touching `.offset` — a `CursorPagination`
carries none — and passes `offset: 0` on a cursor page, since the keyset
predicate already excludes everything before it; `limit` bounds the page
either way, applied by MikroORM independently of `populate`, so relation
loading never multiplies the rows pagination counts. Metadata derivation
and adapter construction are cached per entity at bootstrap, not repeated
per request. The per-operation `em.fork()` is cheap — it allocates a
manager and an empty identity map, it does not touch the connection pool.

## 9. The reference application

`examples/nest-mikroorm` serves the **same Pet domain** as
`examples/nest-typeorm` — single-table inheritance, an `Owner` relation both
ways, a one-to-one `Address`, a many-to-many `Tag` edge — through
`@Kavo`-generated Nest routes over this adapter. Running one domain under two
SQL adapters is the point: where the two apps behave identically, the seam is
carrying its weight; where they differ (soft delete declared rather than
inferred, relation paths filterable rather than refused), the difference is
real and documented above.

Its e2e suite runs twice from one set of assertions — in-memory SQLite with
no Docker, and a Testcontainers Postgres. The Postgres run is the only place
`caseInsensitiveFilters: true` is exercised, which is what keeps §2's claim
about the `false` default honest rather than merely asserted.
