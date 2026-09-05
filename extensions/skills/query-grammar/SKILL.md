---
name: query-grammar
description: Reference for the query-string grammar every generated Kavo route understands — filter operators, sort, field selection (fields/fields[relation]), pagination strategies, includes, withDeleted, and the security/coercion rules behind them. Use when writing API-consumer docs, constructing a request against a Kavo endpoint, or answering "how do I filter/sort/select/paginate/include" questions.
---

# Query grammar reference

Every generated `findMany`/`findOne` route (and the programmatic
`findMany({ filter, sort, ... })` equivalent) is driven by one query model,
normalized in `core/src/query/` (`DefaultFilterParser`, `QueryNormalizer`,
`PaginationStrategy`). This doc is end-user-safe — hand it to an API
consumer as-is. Full source: `docs/internals/architecture/05-query-grammar.md`
(operators/grammar) and `docs/internals/architecture/12-relations-and-includes.md`
(includes). What an entity _allows_ through these params is configured via
`allowed`/`relations` on `@Kavo` — see the `kavo-decorator` skill.

## Filtering — `filter[field][operator]=value`

| AST operator  | Wire token   | Example                                            |
| ------------- | ------------ | -------------------------------------------------- |
| `EQ`          | `eq`         | `filter[status][eq]=active`                        |
| `NE`          | `ne`         | `filter[status][ne]=banned`                        |
| `GT` / `GTE`  | `gt` / `gte` | `filter[age][gte]=18`                              |
| `LT` / `LTE`  | `lt` / `lte` | `filter[age][lt]=65`                               |
| `IN`          | `in`         | `filter[status][in]=active,pending`                |
| `NOT_IN`      | `notIn`      | `filter[role][notIn]=bot,test`                     |
| `LIKE`        | `like`       | `filter[name][like]=%25john%25`                    |
| `ILIKE`       | `ilike`      | `filter[name][ilike]=%25john%25`                   |
| `BETWEEN`     | `between`    | `filter[createdAt][between]=2026-01-01,2026-06-01` |
| `IS_NULL`     | `isNull`     | `filter[deletedAt][isNull]=true`                   |
| `IS_NOT_NULL` | `isNotNull`  | `filter[deletedAt][isNotNull]=true`                |

Logical operators: `AND` (implicit), `OR`, `NOT` — wire tokens `and`, `or`,
`not`. Wire tokens are camelCase and **exact-case matched**, no aliases
(`GTE`/`Gte` are 400s).

- **Multiple `filter[...]` params AND together implicitly**, including
  repeats on the same field: `filter[age][gte]=18&filter[age][lt]=65`.
- **`in`/`notIn`**: comma-separated by default (`in=active,pending`); the
  repeated-key form `filter[status][in][]=a&filter[status][in][]=b` also
  works. Capped by `limits.inValues` (default 100).
- **`between`**: exactly two comma-separated bounds.
- **`isNull`/`isNotNull`**: boolean-valued; `isNull=false` ≡
  `isNotNull=true` — both spellings mean what they read as.
- **`like`/`ilike`**: never auto-wrap wildcards — pass `%`/`_` explicitly.
  Literal `%`/`_` escape with a backslash (`\%`, `\_`). `ilike` is portable
  (`LOWER(col) LIKE LOWER(:v)`), identical across drivers. String columns
  only.
- **Relation-path filtering**: dot notation (`filter[profile.city][eq]=Helsinki`),
  permitted only on the filterable allowlist. This **restricts root rows**
  via a non-selecting join — it never loads or filters the included
  collection.
- **Nested boolean trees**: `filter` also accepts one JSON-encoded value —
  `?filter={"or":[{"name":{"eq":"admin"}},{"not":{"status":{"eq":"x"}}}]}` —
  producing the identical AST as the bracket form. Bracket notation is sugar
  for the flat common case; JSON is the full-power escape hatch. When both
  appear on the same request, they AND together.
- Nesting depth is capped by `limits.filterDepth` (default 3).

### Combined example

```
GET /users
  ?filter[age][gte]=18
  &filter[status][in]=active,pending
  &filter[name][like]=%25john%25
  &filter[or][0][role][eq]=admin
  &filter[or][1][status][eq]=banned
  &sort=-createdAt,name
  &limit=20&offset=20
  &fields=id,name,email
```

resolves to:

```
AND[ age GTE 18, status IN [active, pending], name LIKE "%john%",
     OR[ role EQ "admin", status EQ "banned" ] ]
sort:       [{ createdAt desc }, { name asc }]
pagination: { limit: 20, offset: 20 }
fields:     root: [id, name, email]
```

## Sorting — `sort=-createdAt,name`

Comma-separated field list; `-` prefix means descending; list order is
priority order. Enforced against the `sortable` allowlist — a field not on
it is a 400, not a silent no-op.

## Field selection — `fields=` / `fields[<relation>]=`

- `fields=id,name,email` — sparse fieldset for the root resource, validated
  against the `selectable` allowlist.
- `fields[<relation path>]=id,title` — narrows an included node's own
  columns, validated against the **target** entity's `selectable`
  allowlist (see `include` below).
- Keys needed internally for stitching relations are always fetched and
  stripped at serialization time — "kept internally, stripped late" — so a
  narrow fieldset never breaks an include.
- Programmatic callers pass a `FieldSelectionInput`; its three accepted
  spellings collapse to the same normalized selection as the wire form.

## Pagination — `limit`/`offset` (default) or `page[number]`/`page[size]`

Pluggable via `PaginationStrategy` (config key `pagination.strategy`):

- **`offset`** (default): flat `limit`/`offset`, 0-based — the same field
  names the response envelope reports (`items`, `limit`, `offset`, `total`),
  so request and response mirror each other.
- **`page`** (built in): `page[number]`/`page[size]`, 1-indexed, normalized
  internally to `limit`/`offset`.
- Missing `limit` → `pagination.defaultLimit` (20). `limit` above
  `pagination.maxLimit` (100) → clamped, not rejected. Malformed or negative
  → 400.
- `pagination.count: false` skips the count query entirely; the envelope
  reports `total: null` — useful for large tables where `COUNT(*)` is the
  expensive part of a list request.
- Custom strategies register via `paginationStrategies` on `createKavo`/
  `KavoModule.forRoot`.

## Includes — `include=posts.comments,profile`

Comma-separated dot-paths, merged into one validated tree. A relation not on
the entity's inclusion allowlist (`relations.edges.<name>.includable`) is a
400, never a silent omission. Full detail — per-edge `strategy`
(`join`/`batch`/`auto`), depth/node budgets, the pagination-correctness
guarantee for joined to-many relations, cycle guard, soft-delete interplay,
and relation writes — is in the `kavo-decorator` skill's "relations" section
and `docs/internals/architecture/12-relations-and-includes.md`.

## Soft delete — `withDeleted=true`

Includes soft-deleted rows, which are otherwise excluded from every read.
On an entity that is not soft-deletable this is rejected with
`KAVO_QUERY_UNSUPPORTED_PARAM` (not silently ignored); a non-boolean value is
a field-level 400. Applies to the **root only** — it never widens what an
included relation returns.

## Security & robustness (why all of the above is safe to expose)

- **Allowlist settings are fail-closed.** Every entity resolves `filterable`/
  `sortable`/`selectable` at bootstrap — explicit, or defaulting to the
  entity's own scalar columns. Relation paths are **never** allowlisted
  implicitly. Anything outside a list is `KAVO_QUERY_INVALID_FIELD` (400),
  never a silent drop — and programmatic callers get the identical check,
  so typed input skips coercion, not security.
- **Excluding instead of enumerating:** any allowlist key accepts
  `{ exclude: [...] }` in place of an explicit array, resolved at bootstrap
  to every own column except the ones named.
- **Type coercion:** raw wire strings coerce against root column metadata
  before becoming AST values (number, boolean `true`/`false`/`1`/`0`, ISO
  8601 date, enum member match, `null` for nullable columns). A coercion
  failure is a field-level 400, never a silent `NaN`/`Invalid Date`.
  Relation-path filter values are **not** coerced (no column metadata for a
  dotted path) and pass through as strings.
- **One exception, all issues:** every violation across filter, sort,
  fields, and pagination collects into a single `QueryValidationException`
  — a client fixes its whole request in one round trip (`errors[]` in the
  problem-details body).
