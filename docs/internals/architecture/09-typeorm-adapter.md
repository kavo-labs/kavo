# 09 — TypeORM Adapter

`@kavo/typeorm` implements `RepositoryAdapter` (= `EntityReader` +
`EntityWriter`) over a TypeORM `DataSource` and feeds core's metadata
seam. Core scope: CRUD with hard delete, filtering (incl. `NOT` and
relation paths), sorting, pagination, optional counting, soft
delete/restore/purge (§3), and relation loading (§6). `typeorm` is a
peerDependency; `@kavo/core` never imports it.

## 1. The metadata seam

`buildEntityMetadata(dataSource, Entity)` translates TypeORM metadata
into the ORM-independent `EntityMetadata`: id field (exactly one primary
column — composite keys rejected at bootstrap), scalar columns with
`FieldKind` + nullability + generated flags (`isGenerated`, create/
update/delete-date, version columns), enum members, and relation
descriptors (`includable: false` always — ORM metadata supplies shape,
never permission). `createInfrastructure(dataSource)` packages
metadata + adapters, cached per entity; `createTypeOrmKavo` is the
zero-config sugar.

## 2. Query translation (Filter AST → QueryBuilder)

`FilterTranslator`: groups become `Brackets`/`NotBrackets` — precedence
is explicit parentheses, never operator-order luck; parameters are
numbered globally per query. Notable translations: `EQ null` → `IS NULL`;
empty `IN` → `1 = 0` (empty `NOT IN` → `1 = 1`) since SQL `IN ()` is
invalid; `LIKE` carries an `ESCAPE` clause with the backslash (the
grammar's literal-escape) bound as a parameter rather than inlined as a
`'\'` string literal, since drivers disagree on how backslash is escaped
inside a literal (MySQL vs. Postgres); `ILIKE` → `LOWER(col) LIKE
LOWER(:v)` — portable across every driver, one spelling instead of a
per-driver fork.

**Relation-path conditions** (`author.name`) add one **non-selecting**
left join per path segment with deterministic aliases (`Book__author`),
reused across conditions. They restrict root rows; _loading_ a relation is
what `include=` does (doc 12), and because include joins use the same
alias scheme and register themselves with the translator, a filter on an
included path reuses that one selecting join. Relation paths are only
filterable when explicitly allowlisted.

## 3. Repository API vs. QueryBuilder API

- **Reads → QueryBuilder**: the only surface that can express the
  translated AST, joins, ORDER BY on joined paths, and skip/take.
- **Writes → Repository**: entity hydration, column defaults, and
  cascades matter; no dynamic SQL is needed. `update` and `patch` share
  one load-merge-save primitive — the _shape_ of the payload differs at
  the DTO layer (full body vs. sparse), not the persistence mechanics.

**Soft delete** (doc 11) rides on both halves.
`buildEntityMetadata` reports `@DeleteDateColumn` as
`EntityMetadata.softDeleteField`; reads scope themselves to live rows —
`.withDeleted()` for a declared delete column, an explicit
`<alias>.<field> IS NULL` for a marker column named through config — and
`delete`/`restore`/`purge` branch on `context.config.softDelete`,
reaching for TypeORM's own `softDelete`/`restore` only when the field is
the declared one.
Missing rows raise `NotFoundException` (load returns `null`;
`delete` checks `affected === 0`).

## 4. Pagination & count strategy

`findMany` filters by `readFilter(query)`, not `query.filter` directly:
under cursor pagination `readFilter` AND-s in the keyset predicate
`QueryNormalizer` built from the effective sort onto the client filter
(ADR-0021); under offset pagination it is the identity function, so this
adapter's shape is unchanged there. The pagination read itself must
narrow with `isCursorPagination` before touching `.offset` — a
`CursorPagination` carries none — and when it is a cursor page, `skip(0)`
runs instead: the keyset predicate already restricts to rows after the
cursor, so there is nothing left to skip. Either way `take(pagination.limit)`
bounds the page.

`count()` is a dedicated query built from `query.filter` (sorting
stripped) — **not** `readFilter(query)` — since `total` is the size of
the whole match set, not of what remains after the cursor; never
`getManyAndCount`: the engine only calls `count` when `pagination.count`
is true, so `total: null` costs zero extra queries.

## 5. Error-mapping table

`mapDriverError` — the original error always travels as `cause`:

| Driver condition (PG SQLSTATE / MySQL errno / SQLite code)                   | Exception                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------ |
| unique violation (`23505` / 1062 / `SQLITE_CONSTRAINT_UNIQUE`·`_PRIMARYKEY`) | `ConflictException`                        |
| FK violation (`23503` / 1451·1452 / `SQLITE_CONSTRAINT_FOREIGNKEY`)          | `ConflictException`                        |
| invalid input syntax (PG `22P02`, e.g. a non-UUID id)                        | `QueryValidationException` (400)           |
| serialization/deadlock (`40001`·`40P01` / 1213 / `SQLITE_BUSY`)              | `TransactionException` (`retryable: true`) |
| anything else                                                                | `PersistenceException` with `cause`        |

## 6. Attachment points for later work

Two of the three have since landed and are documented above rather than
here:

- **Soft delete (doc 11):** built. The strategy branch lives in
  `delete`/`restore`/`purge` reading `context.config.softDelete`, and query
  methods add the `IS NULL` predicate driven by `query.withDeleted` (§3).
- **Includes (doc 12):** built. `buildQuery` joins to-one nodes
  from the validated `IncludeTree` and `loadBatches` issues one extra query
  per to-many level, stitched by id; the deterministic alias scheme is what
  lets an include join and a relation-path filter share one join (§2).
- **Transactions:** still a seam, and the only one left. Every method
  already receives `KavoContext`; a `QueryRunner` would ride on
  `context.transaction.handle`, with reads/writes switching to the runner's
  manager when present. Nothing binds it in v6 — the sole consumer would be
  bulk `atomic` mode, which this build dropped (doc 03 §5).

## 7. Performance posture

Filters and sorts translate to plain indexed-column predicates —
index-aware by construction (no function-wrapping except the documented
`ILIKE` lowering, which callers can avoid with `like`). No N+1: to-many
relations load one batched query per level, not one per parent row; no
unbounded queries (`maxLimit` clamps upstream). Integration tests run the
real engine→adapter stack on in-memory SQLite (`tests/adapter.spec.ts`,
`tests/soft-delete.spec.ts`, `tests/includes.spec.ts`), per-package testing
as specified.
