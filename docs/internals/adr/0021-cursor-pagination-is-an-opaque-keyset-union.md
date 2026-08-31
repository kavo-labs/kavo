# ADR-0021 — `Pagination` becomes a union, and a cursor is opaque rather than signed

**Status:** accepted

## Context

Kavo shipped two pagination strategies, `offset` and `page`, and
`packages/core/src/query/pagination.ts` described the shape they produce as
"the single internal form every strategy produces and every adapter
consumes": `{ limit, offset }`. Every adapter reads `.offset` and hands it
straight to `skip`/`take` (or its ORM's spelling).

Keyset ("cursor") pagination does not fit that form, and three separate
tensions fall out of trying to make it fit.

**There is no offset to report.** A keyset page is defined by "the rows
ordered after _this_ row", not by a count of rows skipped. Reusing the field
with a `0` in it would hand every adapter a number that means nothing and
that a future reader would reasonably `skip()` by. The issue's own
requirement — "an adapter never receives a meaningless `offset`" — is a
requirement about the _type_, and only the type can enforce it. But
`Pagination` is public API, and so are `PaginationStrategy`,
`NormalizedQueryContext`, and `RepositoryAdapter`, which means any change
here is a change adopters see.

**A cursor cannot be tamper-proof in this package.** The obvious design is
an HMAC-signed token. Core imports nothing at all (ADR-0005), which rules
out `node:crypto`; the one cryptographic API reachable as an ambient global,
`SubtleCrypto`, is asynchronous while `PaginationStrategy.normalize` is
synchronous; and `KavoSettings` has no secret-key concept for a signature to
use. Adding all three — a runtime dependency, an async seam, a key
management story — would be a large architectural bill.

**Nothing in a strategy knows the sort.** A cursor is meaningless except
against the order it was issued for, and it is only correct over a _total_
order. But `normalize(rawParams, limits)` sees neither the effective sort
nor the entity metadata, and widening that signature would break every
third-party strategy — the seam's whole point.

## Decision

**1. `Pagination` is a union, and the offset variant keeps its exact shape.**

```ts
type Pagination<Entity = unknown> = OffsetPagination | CursorPagination<Entity>;
interface OffsetPagination {
  limit: number;
  offset: number;
}
interface CursorPagination<Entity = unknown> {
  limit: number;
  cursor: string | null;
  keyset: FilterExpression<Entity> | null;
}
```

The discriminant is the **presence of `cursor`**, exposed as the exported
guard `isCursorPagination`, not a `kind` tag — that keeps `OffsetPagination`
structurally identical to the pre-union shape, so every existing _producer_
(including third-party strategies) stays assignable with no edit. _Consumers_
that read `.offset` must now narrow first; that break is unavoidable, and is
the point.

**2. A cursor is opaque, not signed.** The token is base64url-encoded JSON,
strictly shape-validated on decode: the payload must be an array whose
length equals the effective sort's, and whose every element matches the
corresponding field's declared `FieldKind` (an `enum` value must be in the
declared set, a `date` must parse, a `null` is refused outright). A failure
is the ordinary `KAVO_QUERY_INVALID_VALUE` query issue on field `cursor` —
the same treatment a malformed `page[number]` gets.

**No documentation or code may claim tamper resistance**, because the
weaker guarantee is genuinely sufficient — but only because of an invariant
the normalizer **enforces**, not one it assumes:

> **A cursor sort key must be on `sortable` ∩ `filterable` ∩ `selectable`.**

The three allowlists are independent `QueryFieldSelector`s, so `sortable`
alone would have made the cursor path a way _around_ the other two:

- **`filterable`**, because `keysetExpression` mints `EQ`/`GT`/`LT`/`GTE`/
  `LTE` nodes over every sort key and `readFilter` AND-s them into the
  adapter's filter _after_ `DefaultFilterParser` and `validateExpression`
  have already run. Gated on `sortable` alone,
  `?sort=email,id&cursor=WyJtIiwwXQ` emits `WHERE email > 'm' OR …` against
  a field `?filter[email][gt]=…` is a 400 for — a value-extraction oracle
  reachable by binary search.
- **`selectable`**, because `cursorValuesOf` reads the **raw entity**
  (deliberately: a client selecting `select=title` still needs `id` in its
  cursor) and `meta` never passes through the serializer. Gated on
  `sortable` alone, excluding `passwordHash` via `selectable` or an item DTO
  while leaving `sortable` at its default — the natural configuration —
  means `?sort=passwordHash,id` base64-encodes the hash into `nextCursor`,
  and walking pages dumps the column in order.

A field failing either extra check is **rejected**, never dropped from the
sort: omitting a key would silently break the total order the keyset
depends on.

With that invariant enforced, the no-signature argument holds: a cursor
payload is a tuple of comparison values against fields the client can
already filter on and already read. It can send `?filter[createdAt][gt]=…`
with any value it likes against those same fields, so a forged cursor grants
nothing forging a filter does not, and a signature would protect nothing
that is not already open. Opacity is there to stop clients from _depending_
on the token's structure, which it does.

**Encode-time type validation.** `cursorValuesOf` also checks every value
against its column's declared `FieldKind`, using the same predicate
`reviveValue` decodes with, and raises `ConfigurationException` on a
mismatch. The declared kind and the runtime representation genuinely
disagree for some columns, and because the tiebreaker _must_ be `idField`,
that disagreement makes the whole feature unusable rather than merely odd:

| Column                         | Declared | Runtime          | Without the check                                        |
| ------------------------------ | -------- | ---------------- | -------------------------------------------------------- |
| `bigint` (MikroORM v7, Prisma) | `number` | JS `bigint`      | `JSON.stringify` throws → opaque **500 on page 1**       |
| `bigint` (TypeORM)             | `number` | `string`         | round-trips → permanent **400 on page 2**, wrong message |
| `Decimal` (Prisma)             | `number` | `Decimal` object | `Decimal.toJSON()` → same as TypeORM's                   |

The supported runtime representations for a cursor key are therefore:
`string`, finite `number`, `boolean`, and `Date`. **`bigint` and decimal
columns are not supported as cursor sort keys** — including as the `idField`
tiebreaker, which rules cursor pagination out for those entities entirely
until the codec grows a canonical string form for them.

**3. The keyset predicate is built in core, as an ordinary filter AST.**
`keysetExpression(sort, values)` produces the row-wise comparison as an `OR`
of `AND` chains — `(a > va) OR (a = va AND b < vb) OR (…)` — flipping to
`LT` for each `desc` key. Consequences:

- mixed `asc`/`desc` sorts work on every adapter at once, because no adapter
  reimplements row-wise comparison;
- composition with the client's filter, with include joins, and with the
  soft-delete scope is free, since every adapter already translates this AST.

**Index-startability: the disjunction is AND-ed with a redundant leading
range.** A bare `OR` of `AND` chains is correct and is the only shape that
handles mixed directions — but it is **not a btree start condition**. For
any multi-column sort (which the `idField` tiebreaker rule effectively
forces), PostgreSQL either takes an ordered index scan with the whole `OR`
as a _filter_ — reading and discarding every row before the cursor, which is
precisely the `OFFSET` cost this feature exists to remove — or a `BitmapOr`
that loses the ordering and forces a sort. MySQL/InnoDB behaves the same;
SQLite falls back to a temporary b-tree. (MongoDB is genuinely fine: it
plans a `SORT_MERGE` over the branches.)

So the emitted shape is

```
(a >= va) AND ( (a > va) OR (a = va AND b < vb) OR (a = va AND b = vb AND id > vid) )
```

for `sort=a,-b,id` — `<=` when the leading key descends. The extra conjunct
is **logically implied by every branch of the disjunction**, so it narrows
nothing and changes no result; it exists purely to hand the planner a range
qualification it can _start_ the scan on, taking the cost from
O(rows before the cursor) to O(ties on the leading key + limit). Every
adapter already translates `GTE`/`LTE`, so this is five lines in core and no
adapter change. Single-key sorts already emit a bare range condition and get
it for free.

**An index is required, and is the adopter's job.** Keyset paging is
`O(limit)` only against an index covering the sort tuple **in that exact
column order and with those directions**. Without one, every page sorts the
whole match set — and on MongoDB an unindexed large sort does not merely get
slow, it exceeds the 32 MB in-memory sort limit and _errors_. Kavo cannot
create the index (it never owns the schema), so this is documented as an
adopter obligation in `docs/using-the-api.md` rather than enforced.

**`pagination.count` still dominates by default.** `count` defaults to
`true`, so an out-of-the-box cursor page is the `O(limit)` keyset select
_plus_ an `O(n)` `COUNT(*)` over the whole match set. The default is not
changed here — it is a wire-contract change, and `total` disappearing from
the envelope by default would break every existing client. Instead the docs
recommend `pagination.count: false` alongside `strategy: "cursor"`, and say
why: `total` is the one thing keyset paging cannot make cheap.

Adapters call `readFilter(query)` in `findMany` instead of reading
`query.filter`; it AND-s the keyset onto the client filter (and is the
identity function under offset paging). **`count` deliberately keeps using
`query.filter`** — `total` is the size of the whole match set, so
`pagination.count` behaviour is unchanged and strategy-independent.

**4. Sort validation lives in `QueryNormalizer`, not in the strategy.** The
strategy carries the token through and leaves `keyset` at `null`; the
normalizer — which runs after sort resolution and holds the entity metadata
— enforces the rules and fills `keyset`, on **both** the wire path and the
programmatic one. The rules:

- the effective sort must **end in `idField`**. `EntityMetadata` carries no
  uniqueness information beyond the primary key (composite keys are out of
  scope), so "ends in a unique tiebreaker" can only mean "ends in the
  primary key" — the one field Kavo can prove unique. Declaring other unique
  fields would need a new config key and is deferred.
- every sort field must be a **root scalar column** — a relation path has no
  value to read off the returned row.
- a `json` column may not be a sort key: no portable ordering.
- every sort field must be on **`filterable` and `selectable`** as well as
  `sortable` (§2). Rejected, not dropped.
- a **nullable** column is _not_ rejected, and that is a **known,
  unenforced limitation, not a safe fallback.** Whether an ORM calls a
  column nullable is not a reliable signal (Mongoose reports every
  non-`required` path that way), so rejecting on it would make the feature
  unusable on one adapter rather than safe on four. What the decoder does
  instead — refusing a cursor that carries `null` for any key — is only
  **half** a guard, and which half an adopter gets depends on where their
  engine sorts NULLs:

  |                                           | Boundary row's key is `NULL`        | Null-keyed rows are past the cursor                                     |
  | ----------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
  | **NULLS FIRST** (PG `DESC`, sqlite `ASC`) | token carries `null` → **loud 400** | —                                                                       |
  | **NULLS LAST** (PG `ASC`, sqlite `DESC`)  | —                                   | `col > v` is `UNKNOWN` for `NULL` → **rows silently omitted, no error** |

  In the NULLS-LAST case a client walking the cursor sees a subset of the
  match set, gets `nextCursor: null`, and believes it saw everything —
  while `total` still counts the missing rows. MongoDB behaves the same way
  under `desc` (it sorts null/missing first and `$lt` type-brackets, so null
  documents never match). Both halves are pinned by tests in
  `packages/orms/typeorm/tests/cursor-pagination.spec.ts`, which uses
  sqlite's opposite NULL orderings per direction to exercise them in one
  suite.

  **Therefore: cursor pagination must not be used over a nullable sort
  key.** This is stated as plainly in `docs/using-the-api.md`. Two fuller
  fixes are on the table and deferred: rejecting a nullable non-`idField`
  sort key where the ORM's nullability metadata is trustworthy (which needs
  a per-adapter trust signal on `EntityMetadata`, since Mongoose's is not),
  or emitting a NULL-aware keyset (`(a > v) OR a IS NULL OR (a = v AND …)`
  for ASC/NULLS-LAST — core already has `IS_NULL`/`IS_NOT_NULL` in the AST,
  but NULL ordering is engine-specific, which is the hard part). Neither is
  a documentation change, so neither belongs in the change that made the
  documentation honest.

- a **date** sort key is safe only where the backend stores dates in one
  canonical form, and that is a second **known, unenforced limitation**. The
  keyset is an ordinary filter AST, so its comparison is whatever the backend
  does with the bound value; on a backend that stores a date as **text** the
  comparison is lexical, and one column can hold two spellings of the same
  instant. SQLite is where this bites, and the common configuration is the
  one that hits it (#185):

  | Written by                                                               | Stored as                 |
  | ------------------------------------------------------------------------ | ------------------------- |
  | a SQL default — TypeORM renders `@CreateDateColumn` as `datetime('now')` | `2026-08-10 14:51:07`     |
  | the driver, binding a JS `Date`                                          | `2026-08-10 14:51:07.000` |

  Lexically the first is _strictly less_ than the second, so a keyset over
  rows written by the default compares every one of them as before the
  cursor: `col < v` matches the whole page again and `col = v` never fires,
  which kills the tiebreaker chain as well. The page repeats, the token
  repeats, and §5's advance guard is what catches it.

  No bind-side repair exists. Both spellings can coexist in one column —
  rows inserted before a default was added, rows written by a migration,
  rows written by the driver — so no single bound form compares correctly
  against all of them. `ORDER BY` reads that same text the same way, so
  where the spellings are mixed the ordering is already wrong before a
  keyset is involved; the keyset is merely where it becomes visible.

  **A canonicalizing fix was considered and rejected** (#185). Wrapping the
  keyset predicate _and_ the `ORDER BY` in `strftime('%Y-%m-%d %H:%M:%f', …)`
  for date columns on a sqlite-family driver is correct even against mixed
  spellings, and it still costs more than it returns. The column's index can
  then serve neither the seek nor the sort, so every cursor page becomes a
  scan and a sort — the one property keyset pagination exists to provide.
  Sort emission becomes conditional on the driver, a seam only one path ever
  exercises. And it would live in `@kavo/typeorm`, so `@kavo/mikroorm` and
  `@kavo/prisma` over sqlite keep the limitation and the rule below has to be
  stated regardless. Stating it once, and letting §5's guard catch a
  violation loudly, is the better trade.

  **Therefore: on SQLite, a cursor sort key must be a column every row was
  written to through the driver** — a `date` column with a SQL default is not
  one. Postgres and MySQL store dates as a real type and compare them as one,
  and are unaffected.

Rejections are `KAVO_QUERY_CONFLICTING_PARAMS` on field `sort` (or
`KAVO_QUERY_INVALID_FIELD` on the field itself, for the allowlist gates),
and are reported _without_ also decoding the cursor — a cursor checked
against a rejected sort would add a misleading second issue about arity.

**5. `nextCursor` goes in `meta`, and the engine owns it.** The envelope's
fields (`items`, `limit`, `offset`, `total`, `meta`) are normative and do
not grow. The next page's token is `meta.nextCursor`, `null` on the last
page, assembled in `KavoEngine`'s `listMeta` step — the single merge point
for everything that contributes to the list envelope's bag (issue #122).
The strategy's key is the **base** and a handler's `meta` merges over it, so
a `withListMeta` contributor that names `nextCursor` explicitly still wins.

The has-more signal it needs is a **`limit + 1` over-fetch**, and it lives
in the **built-in `findMany` handler**, not in the adapters: the handler
asks the adapter for one row more than the page, drops the sentinel, and
reports `FindManyResult.hasMore`. Putting it there means `EntityReader`'s
contract stays "return exactly what the query asks for", and an adapter —
including a third-party one — needs no cursor awareness beyond honouring
`readFilter`.

**6. `ListResultDto.offset` is `0` on a cursor page.** The field is
non-nullable and normative, and a keyset page genuinely has no absolute
position in the match set. `0` is the honest reading of "how many rows
precede `items[0]` in what this response describes"; cursor clients page
with `meta.nextCursor` and ignore it.

**7. `offset` remains the default strategy, and the protocol bindings refuse
a cursor-configured entity at bootstrap.** Backward (`before`) paging and
Relay-style `edges`/`pageInfo` conventions are out of scope.

`@kavo/graphql`'s list field and `@kavo/mcp`'s `<entity>.findMany` tool both
hard-code `{ limit, offset, sort, filter }`, and `QueryNormalizer` _ignores_
`offset` under the cursor strategy. So a GraphQL client asking for
`books(limit: 20, offset: 40)` against a cursor-configured entity would get
rows 1–20 back with no error and no way to detect it, and `nextCursor` lives
in `meta`, which the `<Name>List` type does not carry — page 2 is
unreachable. Since `pagination.strategy` is entity-scope, one
`defaults: { pagination: { strategy: "cursor" } }` would silently degrade
both shipped bindings to page-one-with-wrong-answers.

The choice is therefore **fail fast**: `crudFields` and `crudTools` each
raise `ConfigurationException` naming the entity, the config key, and the
way out. Adding `cursor` plus a `meta`/`nextCursor` field to both bindings
is the eventual fix and is deliberately deferred — it is a schema change to
two public protocol surfaces, and refusing to bind stays correct after it
lands. The check is duplicated in the two packages rather than shared,
because a protocol binding may not import a sibling one (ADR-0002); it
compares `pagination.strategy` to `"cursor"` by name, so a _third-party_
keyset strategy under another name is not caught.

## Consequences

- **A consumer-side break at v0.6.0.** Any code reading
  `query.pagination.offset` — an adapter, a custom `EntityReader`, a test
  fixture — must narrow with `isCursorPagination` first. Producers are
  unaffected. Kavo versions in lockstep (ADR-0004), so the break lands
  everywhere at once.
- **The base64 codec is hand-rolled.** `packages/core/tsconfig.json` sets
  `"types": []` precisely so a host's ambient globals cannot leak in, which
  rules out `btoa`/`TextEncoder` alongside `Buffer`. The payload is escaped
  to ASCII before encoding, so no UTF-8 encoder is needed; it lives in one
  module, `packages/core/src/query/cursor.ts`, with its own tests.
- **Cursor paging costs one extra row per page**, never an extra query. It
  does not, however, remove the `COUNT(*)`: see §3 on `pagination.count`.
- **A cursor is not portable across sorts.** Changing `sort` while holding a
  token is rejected rather than silently reinterpreted — the arity check
  catches the common case, and the type check catches the rest.
- **A `Date` cursor key is truncated to milliseconds.** `JSON.stringify`
  spells a `Date` as ISO-8601 with three fractional digits, so on a column
  with sub-millisecond precision (PostgreSQL `timestamp(6)`) the boundary
  row can compare equal to the truncated value and be returned **twice**.
  The `idField` tiebreaker bounds the damage to the ties within one
  millisecond, but it does not eliminate it. Sort on a
  millisecond-or-coarser column, or accept the duplicate.
- **`decodeCursor` and `keysetExpression` are not barrel-exported.** Both
  are `QueryNormalizer` internals whose contracts only hold once the
  effective sort has been validated — `decodeCursor` in particular would
  need every caller to have already proven each sort key is a scalar column.
  The barrel carries `encodeCursor`/`cursorValuesOf` (what a custom
  `findMany` handler needs) and `readFilter`/`isCursorPagination` (what an
  adapter needs), and nothing else (ADR-0010).
- **A third-party adapter that half-migrates loops forever, so the engine
  errors instead.** An adapter that took the `isCursorPagination` narrowing
  but kept reading `query.filter` rather than `readFilter(query)` returns
  rows `1..limit` on every request, so `hasMore` never goes false and a
  client following `nextCursor` never terminates. `KavoEngine.listMeta`
  raises `ConfigurationException` when the token it just computed equals the
  one the request carried.
