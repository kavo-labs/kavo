# 14 — Prisma Adapter

`@kavo/prisma` implements `RepositoryAdapter` (= `EntityReader` +
`EntityWriter`) over a Prisma Client model delegate and feeds core's
metadata seam from Prisma's DMMF. Core scope matches `@kavo/typeorm`
(doc 09): CRUD with hard delete, filtering (incl. `NOT` and relation
paths), sorting, pagination, optional counting, soft delete/restore/purge
(doc 11), and relation loading (doc 12). `@prisma/client` is a
peerDependency; `@kavo/core` never imports it, and `@kavo/prisma`'s own
`src` imports no Prisma type either — see §1.

## 1. Marker classes and the metadata seam (ADR-0017)

Prisma generates no runtime class for a model — its output is TypeScript
types, erased at compile time — so this adapter cannot get an entity's
`ClassRef` identity for free the way `@kavo/typeorm` does from
`@Entity()` classes. Callers declare one empty **marker class** per
model, matched to Prisma's DMMF by name (`class Author {}` ↔
`model Author { … }`), and register every marker class with
`createInfrastructure`'s `entities` list — the registry a relation's
target model name resolves back to its class through, since Prisma
supplies no such registry either. Full rationale in ADR-0017.

`buildEntityMetadata(datamodel, Entity, entities)` reads Prisma's DMMF
structurally (a locally-defined subset type, not an import from
`@prisma/client` or `@prisma/generator-helper` — this keeps
`@kavo/prisma`'s own build free of a `prisma generate` dependency): id
field (exactly one `isId` field — composite keys rejected at bootstrap,
same posture as `@kavo/typeorm`), scalar fields with `FieldKind` +
nullability + generated flags, enum members, and relation descriptors
(`includable: false` always). `EntityMetadata.softDeleteField` is always
`null` — Prisma declares no delete-marker column the way
`@DeleteDateColumn` does, so soft delete is always explicit
`softDelete.field` configuration for this adapter, never auto-detected.

## 2. Query translation (Filter AST → Prisma `where`)

`translateFilter`: `AND`/`OR`/`NOT` groups map directly onto Prisma's own
`AND`/`OR`/`NOT` combinators. Unlike `@kavo/typeorm`'s translator this
needs no query-builder state — no join aliases, no parameter numbering —
because Prisma's `where` already nests relation paths natively
(`{ author: { name: { equals: "Ada" } } }`), so a relation-path condition
(`author.name`) just nests the same translation one level deeper instead
of adding a join. `LIKE`/`ILIKE` map onto `startsWith`/`endsWith`/
`contains`/`equals` by wildcard position, since Prisma has no raw pattern
operator.

Two of those translations need more than the AST to be correct, which is
why `FilterTranslatorOptions` carries the queried `model` and a
`PrismaRelationGraph` alongside the connector setting:

**Relation-path cardinality.** Prisma accepts the bare nested form only on
a **to-one** relation; on a list it requires a `some`/`every`/`none`
wrapper and rejects the bare shape with `Unknown argument`. The grammar
already implies which one: doc 05 §3 defines a relation-path filter as
restricting _root_ rows, so a to-many segment nests under `some` —
`filter[posts.title][eq]=x` is `{ posts: { some: { title: … } } }`, the
same semantics `@kavo/typeorm` gets for free from a `LEFT JOIN` plus a
`WHERE` on the joined column. Each segment of a multi-hop path is
classified independently (`author.posts.title` wraps only the second),
which is why the graph covers the whole datamodel rather than one entity:
`EntityMetadata.relations` describes the queried entity alone, and the
second hop belongs to another model. The graph is derived once from the
DMMF at bootstrap (`buildRelationGraph`, called by `createInfrastructure`)
and passed as plain data, so `translateFilter` stays a pure function. A
segment that resolves to no relation raises
`KAVO_QUERY_UNSUPPORTED_PARAM` (400) rather than emitting a `where` the
engine will reject — core's default allowlists hold scalars only, so
reaching it means a relation path was allowlisted by hand.

**The empty `NOT` group.** `NOT` is variadic and means `NOT(AND(children))`
(doc 05 §1), but the zero-child case cannot be spelled that way here:
Prisma **drops** a `NOT` whose operand carries no condition, so
`{ NOT: { AND: [] } }` matches every row instead of none. The empty
disjunction `{ OR: [] }` is the contradiction Prisma does honor, and is
what the translator emits — verified against a real engine in
`tests/adapter.spec.ts`, which pins all three degenerate groups.

**`ILIKE` and connector support.** Prisma's case-insensitive filter
(`mode: "insensitive"`) is Postgres/MongoDB-only; MySQL, SQLite, and SQL
Server reject the argument. There is no reliable way to detect the
connector from the DMMF at runtime, so `caseInsensitiveFilters` is an
explicit, caller-declared setting on `PrismaInfrastructureOptions`
(default `true`) rather than a guess. Set `false` for `ILIKE` to degrade
to the same translation as `LIKE` on an unsupported connector — a no-op
on SQLite in particular, since SQLite's own `LIKE` is already ASCII
case-insensitive.

## 3. Includes: no join/batch split

`@kavo/typeorm` translates `IncludeNode.strategy` (`join` vs. `batch`)
because it drives a raw SQL query builder, where a to-many `JOIN`
multiplies root rows and a separate batched query is how core's
pagination-correctness rule (doc 12) avoids that. Prisma's `include` has
no such failure mode: it always resolves relations as its own internally
batched queries, to-one or to-many alike, never a row-multiplying join —
so a to-many include never disturbs root pagination regardless of which
strategy core resolved. `PrismaRepositoryAdapter` therefore _ignores_
`IncludeNode.strategy` entirely and maps every node the same way: a
nested `include` entry, with a `where` excluding soft-deleted rows when
the target is soft-deletable (Prisma accepts `where` inside `include` for
to-one and to-many edges alike). A root `withDeleted` is the root's own
opt-in only, same rule as `@kavo/typeorm`.

The one strategy it does act on is `key` (issue #364): the node maps to
`include[<rel>] = { select: { <pk>: true } }`, so Prisma returns
`{ <pk>: value }` or `null` for the edge with no other column — no
soft-delete `where`, since the FK is the literal reference on the parent
row whatever the target's delete state. This narrows the payload but not
the query count: Prisma resolves an `include` entry with its own query
regardless, so `key` here is not the query saved it is on the other three
adapters. Selecting the parent's scalar FK field instead would drop the
query, but that needs the DMMF `relationFromFields` name plumbed onto the
descriptor — a later change. A non-owning `key` edge is rejected at
bootstrap via `RelationDescriptor.ownsForeignKey`.

## 4. Pagination & count strategy

`findMany` filters by `readFilter(query)` rather than `query.filter`,
same seam as `@kavo/typeorm`: it AND-s in the keyset predicate under
cursor pagination and is the identity function under offset pagination
(ADR-0021). The read narrows with `isCursorPagination` before touching
`.offset` — a `CursorPagination` carries none — and passes `skip: 0` on a
cursor page, since the keyset predicate already excludes everything
before it; `take: pagination.limit` bounds the page either way. Prisma's
own `cursor`/`skip: 1` pagination option is deliberately not used: it
takes a unique _id_ and cannot express a multi-column keyset with mixed
sort directions.

`count()` is a dedicated `delegate.count()` call built from `query.filter`
— not `readFilter(query)`, since `total` is the size of the whole match
set, not of what remains after the cursor — never fetch-then-length: the
engine only calls `count` when `pagination.count` is true, so
`total: null` costs zero extra queries.

## 5. Error-mapping table

`mapDriverError` reads `PrismaClientKnownRequestError.code` — Prisma
normalizes every connector's errors into its own driver-agnostic
`P####` catalog, so unlike `@kavo/typeorm`'s table this one needs no
per-database code lists. The original error always travels as `cause`:

| Prisma code                                                                  | Exception                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------ |
| `P2002` unique constraint                                                    | `ConflictException` (409)                  |
| `P2003` FK on insert/update, `P2014` required relation                       | `UnresolvedRelationException` (422)        |
| `P2003` FK blocking a delete (`context.operation` is `deleteOne`/`purgeOne`) | `ConflictException` (409)                  |
| `P2025` record not found                                                     | `NotFoundException`                        |
| `P2034` transaction conflict                                                 | `TransactionException` (`retryable: true`) |
| anything else                                                                | `PersistenceException` with `cause`        |

## 6. Adapter-specific caveats

**`LIKE` cannot express an interior `%`, and has no `_` at all.** Prisma's
`where` has no raw pattern operator — only `equals`, `startsWith`,
`endsWith`, and `contains` — so exactly four pattern shapes translate:

| wire pattern | Prisma filter    |
| ------------ | ---------------- |
| `john`       | `equals: "john"` |
| `A%`         | `startsWith: A`  |
| `%son`       | `endsWith: son`  |
| `%j%`        | `contains: j`    |

Anything else — an interior wildcard (`a%b`), or any use of the
single-character wildcard `_`, which Prisma has no equivalent for — is
**rejected with `KAVO_QUERY_UNSUPPORTED_PARAM` (400)**. It is not
downgraded to `equals` on the raw pattern: that returned a silently
different result set from the other three adapters for the same wire
request, with no error on either side. Escape a literal `%`/`_` with a
backslash to sidestep the limit, or reach for a raw query. Doc 05 §3
cross-references this from the grammar side.

The grammar's backslash escape itself _is_ honored: `\%` and `\_` are
resolved to literal text before the wildcard positions are read, so
`filter[name][like]=100\%` is `{ equals: "100%" }` — matching what
`@kavo/typeorm` gets from its bound `ESCAPE` clause and `@kavo/mongoose`
from `likeToRegExpSource`. `@kavo/mikroorm` is the adapter with the weaker
escape story here (doc 17 §7).

## 7. Attachment points for later work

- **Transactions:** same unbuilt seam as `@kavo/typeorm` (doc 09 §6) —
  `TransactionManager` has no consumer in this build.
- **Composite primary keys:** out of scope, same as `@kavo/typeorm`.
- **Implicit many-to-many relations:** associate-by-id (ADR-0014) writes a
  scalar foreign-key field, which an implicit Prisma m:n relation has none
  of (Prisma manages the join table itself). See the package README for
  the escape hatch (a custom operation handler against the raw client).

## 8. Performance posture

Filters translate to Prisma's own indexed-field filter operators — no
raw SQL, no function-wrapping. No N+1: Prisma's `include` already
batches relation loads internally; `maxLimit` clamps upstream. Integration
tests run the real engine→adapter stack against a real Prisma Client on
SQLite (`tests/adapter.spec.ts`, `tests/soft-delete.spec.ts`,
`tests/includes.spec.ts`), per-package testing as specified — the shared
test schema and generated client are built by `pnpm generate`
(`prisma generate` + `prisma db push`), which `pnpm check` runs first.

The schema is shared; the database is not. `db push` writes a template
(`prisma/template.db`) that no test opens, and `tests/support/client.ts`
copies it per client into a scratch directory `tests/support/global-setup.ts`
provisions for the run and removes afterwards. Vitest runs spec files in
parallel workers and SQLite admits one writer at a time, so a single file
turned each `beforeEach` write chain into a lock other files could stall
behind — a `P1008` socket timeout under CI load. One database per client
removes the contention instead of widening the timeout around it.
