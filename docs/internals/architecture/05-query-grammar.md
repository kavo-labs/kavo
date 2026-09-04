# 05 — Query Model, Filter Engine & Query String Grammar

This is the standalone grammar reference — it is written to serve as
end-user documentation verbatim. The implementation lives in
`core/src/query/` (`DefaultFilterParser`, `QueryNormalizer`, the
pagination strategies); adapters only ever see the validated, normalized
result.

The `<Entity>Filter` / `<Entity>Query` OpenAPI component schemas
(`@kavo/nest`, doc 10 §4 "Named component schemas") model this grammar
structurally for GraphQL/MCP and programmatic callers — see ADR-0042 for
what fidelity they carry and why REST's own flat query params here are
untouched.

## 1. Operators — AST names and wire tokens (single source of truth)

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

Wire tokens are camelCase and **exact-case matched** — one spelling, no
aliases (`GTE`/`Gte` are 400s). Logical operators: `AND`, `OR`, `NOT`
(wire: `and`, `or`, `not`). Core ships exactly this set; an operator
registry mapping tokens to AST factories is a natural extension point but
is deliberately not built in v6.

**`NOT` is variadic and means `NOT(AND(children))`.** All three logical
operators take a child list — `FilterGroup.children` is
`readonly FilterExpression[]` for every operator — so `NOT` needed an
arity answer rather than an assumption. The wire parser only ever builds
the unary shape (`convertLogical` wraps exactly one converted node), but a
programmatic caller hand-builds the AST and `QueryNormalizer` validates
allowlists and limits, not arity. Conjoining is what makes the unary case
a special case of the general one instead of the only legal one, and it
gives the degenerate group below its meaning for free. Reading
`children[0]` and dropping the rest — which `@kavo/typeorm` and
`@kavo/prisma` used to do — returned rows the caller asked to exclude.

## 2. Reference example

```
GET /users
  ?filter[age][gte]=18
  &filter[status][in]=active,pending
  &filter[name][like]=%25john%25
  &filter[or][0][role][eq]=admin
  &filter[or][1][status][eq]=banned
  &sort=-createdAt,name
  &limit=20&offset=20
  &select=id,name,email
```

resolves to

```
AND[ age GTE 18, status IN [active, pending], name LIKE "%john%",
     OR[ role EQ "admin", status EQ "banned" ] ]
sort:       [{ createdAt desc }, { name asc }]
pagination: { limit: 20, offset: 20 }
select:     root: [id, name, email]
```

## 3. Grammar rules

- **Filters:** `filter[field][operator]=value`. Multiple `filter[...]`
  params AND together implicitly. Multiple operators on one field also
  AND (`filter[age][gte]=18&filter[age][lt]=65`).
- **Multi-value operators** (`in`, `notIn`): comma-separated by default;
  the repeated-key form `filter[status][in][]=a&filter[status][in][]=b`
  is also accepted. A **bare empty operand** — `filter[status][in]=`, or
  its repeated-key spelling `filter[status][in][]=` — is a
  `KAVO_QUERY_INVALID_VALUE` **400 on every column kind**. It is neither
  "no filter" nor "the empty set": a client that wants no filter omits the
  parameter. Left to coercion the two column kinds disagreed — string
  coercion accepts `""`, so `filter[name][in]=` built a live `IN ('')`
  (a search for the empty string, usually zero rows and no error), while
  `filter[age][in]=` was already a 400. A UI that submits a cleared
  multi-select now gets an error it can see rather than a silently empty
  page. An _interior_ empty element (`in=a,,b`) is a different question
  and keeps its per-element coercion behavior. The genuinely empty array a
  programmatic caller can pass (`value: []`) is unaffected — that is the
  empty set, and it round-trips as one.
- **`between`:** exactly two comma-separated bounds, in the order given —
  the pair is never sorted, so `between=65,18` is an empty range rather
  than a silently corrected one.
- **`isNull` / `isNotNull`:** boolean-valued. `false` flips to the
  complementary operator (`isNull=false` ≡ `isNotNull=true`), so both
  spellings mean what they read as.
- **`like` / `ilike`:** never auto-wrap wildcards — callers pass `%`
  explicitly. Literal `%` and `_` are escaped with a backslash (`\%`,
  `\_`); the adapter emits the matching `ESCAPE` clause, with the
  backslash bound as a query parameter rather than inlined as a `'\'`
  string literal (drivers disagree on how backslash is escaped inside a
  literal — MySQL's default `sql_mode` treats it as its own in-string
  escape character, Postgres does not — so a parameter is the portable
  spelling). `ilike` is translated portably (`LOWER(col) LIKE
LOWER(:v)`), identical on every driver. Both operators apply to string
  columns only. Two adapters cannot honor the whole pattern language:
  `@kavo/prisma` has no raw pattern operator, so an interior `%` and any
  `_` are **rejected with a 400** rather than mistranslated (doc 14 §6),
  and `@kavo/mikroorm` cannot attach an `ESCAPE` clause, so the backslash
  escape there is driver-dependent (doc 17 §7). The pattern's length is
  capped by `query.maxLikePatternLength` (default 200) — values are always
  parameter-bound, so this is not an injection guard, but an unbounded
  pattern (heavy wildcard backtracking, e.g. `%a%b%c%…`) can otherwise force
  an expensive scan.
- **Relation-path filtering:** dot notation
  (`filter[profile.city][eq]=Helsinki`), permitted only for paths on the
  filterable allowlist. Relation-path filters **restrict root rows** (a
  non-selecting join); they never load or filter the included collection.
  On a **to-many** segment that reads as "at least one" — SQL gets it from
  a `LEFT JOIN` plus a `WHERE`, and the declarative adapters spell it as
  Prisma's `some` / MikroORM's nested list match.
- **Degenerate empty groups.** A group with **zero** children is
  unreachable from the wire (the parser only emits a group once a child
  converted), but a programmatic caller hand-builds the AST and
  `QueryNormalizer` checks allowlists and limits, not arity — so every
  adapter has to answer for it, and **all four agree**:

  | AST      | Matches       | Why                                           |
  | -------- | ------------- | --------------------------------------------- |
  | `AND []` | **every row** | `true` is the identity of conjunction         |
  | `OR []`  | **no row**    | `false` is the identity of disjunction        |
  | `NOT []` | **no row**    | `NOT(AND [])` — the negation of the tautology |

  Each adapter emits a **real predicate** for these, never an omitted one:
  an omitted predicate is exactly how an empty `OR` silently widened to
  every row in `@kavo/typeorm`. The spellings differ because the targets
  do — `1 = 0` in SQL, `$nor: [{}]` in MongoDB, an empty `$in` on the
  primary key in MikroORM, `{ OR: [] }` in Prisma (whose `NOT` over an
  empty operand is dropped rather than honored, doc 14 §2) — but the
  result sets do not, and each adapter's translator spec pins its own row
  of this table.

- **Nested boolean trees:** `filter` also accepts one JSON-encoded value
  — `?filter={"or":[{"name":{"eq":"admin"}},{"not":{"status":{"eq":"x"}}}]}` —
  parsed into the same AST. Bracket notation is sugar for the common flat
  cases; JSON is the full-power escape hatch. **Both produce the
  identical AST** (asserted in `filter-parser.spec.ts`); when both
  appear, they AND together.
- **Sort:** `sort=-createdAt,name` — comma-separated, `-` prefix =
  descending, list order is priority order. Sortable-allowlist enforced.
  A request that supplies no `sort` falls back to the resolved
  `query.defaultSort` setting (doc 08) if one is configured; a client- or
  caller-supplied `sort` always wins outright over the default rather than
  merging with it. With neither, there is no `ORDER BY` at all — row order
  is DB-dependent.
- **Pagination:** pluggable `PaginationStrategy`. Default `offset`: flat
  `limit`/`offset` (0-based) — the same field names the response envelope
  reports, so request and response mirror each other. Built-in
  alternative `page`: `page[number]`/`page[size]` (1-indexed), normalized
  internally to the same `limit`/`offset`. Missing `limit` → `defaultLimit`;
  `limit` above `maxLimit` → clamped; malformed or negative → 400.

  The third built-in, `cursor`, is the one that does **not** normalize to
  `limit`/`offset`: `Pagination` is a union, and its keyset variant carries
  `{ limit, cursor, keyset }` with no `offset` at all (ADR-0021). Consumers
  narrow with `isCursorPagination` before reading `offset`. Wire form is
  flat `limit` plus an opaque `cursor` token; the next page's token comes
  back as `meta.nextCursor` on the list envelope, `null` on the last page.

  Two pieces of the cursor pipeline are deliberately _not_ in the strategy,
  because `normalize(rawParams, limits)` sees neither sort nor metadata:
  `QueryNormalizer` enforces what the effective sort has to be, then decodes
  the token into `pagination.keyset` — a plain filter AST node (`OR` of
  `AND` chains, `LT` for each `desc` key, AND-ed with a redundant non-strict
  bound on the leading key so a btree can _start_ the scan there rather than
  filtering the whole disjunction). Adapters compose it by calling
  `readFilter(query)` in `findMany`; `count` keeps using `query.filter`, so
  `total` still spans the whole match set.

  The sort rules are: it ends in `idField`, every key is a root scalar
  column, no key is `json`, and **every key is on `filterable` and
  `selectable` as well as `sortable`**. That last one is the load-bearing
  security rule rather than a tidiness one — the keyset predicate is
  AND-ed in _after_ `DefaultFilterParser` and `validateExpression` have run,
  and `cursorValuesOf` reads the raw entity into `meta`, which never passes
  through the serializer. Gated on `sortable` alone, the cursor path would
  be a way around the other two allowlists in both directions (ADR-0021 §2).
  A key that fails is rejected, never dropped: dropping one would break the
  total order.

  A malformed, stale, or forged token is a `KAVO_QUERY_INVALID_VALUE` issue
  on `cursor`; a sort that cannot support keyset paging is
  `KAVO_QUERY_CONFLICTING_PARAMS` on `sort`, or `KAVO_QUERY_INVALID_FIELD`
  on the offending field for the allowlist gates. Supplying `?cursor=` to an
  entity that does not page by keyset is `KAVO_QUERY_UNSUPPORTED_PARAM`,
  identically on the wire and programmatic paths — ignoring it would hand
  back page one forever. Cursors are opaque, never signed — ADR-0021 §2
  explains why that is sufficient.

  The fourth built-in, `since`, is a **polling** shape — "give me everything
  that changed since T" — not a bounded traversal, and its `Pagination`
  variant is a third `hasKeyset` member alongside offset and cursor:
  `{ limit, since, keyset }` (ADR-0022). Wire form is flat `limit` plus a
  **plain, compound** `since` value — `"<since.field value>|<id>"`,
  e.g. `2024-03-01T10:00:00.000Z|42` — against `pagination.since.field`
  (default `"updatedAt"`, a documented convention core cannot detect the
  way it detects a soft-delete marker). Never opaque, unlike `cursor`: an
  adopter can read or construct one by hand. The effective sort is
  **forced** to `[since.field, idField]` ascending regardless of any
  client-supplied `sort`, which is rejected outright
  (`KAVO_QUERY_CONFLICTING_PARAMS` on `sort`) rather than silently
  overridden. `QueryNormalizer.resolveSince` splits the token on its last
  `|`, decodes each half, and composes them with the **same**
  `keysetExpression` cursor pagination builds — the id half is what makes
  `since` pagination exactly-once even when rows tie on `since.field`
  (ADR-0022 explains why an earlier, id-less `sinceField >= value` design
  was rejected: a tied group larger than one page never advances without
  it). The next poll's value comes back as `meta.nextSince`, computed from
  the last returned row **regardless of whether the page filled up**
  (unlike `nextCursor`, which is `null` on a non-full page) — polling has
  no "last page" to signal the end of, so an exhausted poll echoes the
  request's own `since` back rather than reporting `null`. `since.field`'s
  existence, `date`/`string` kind, and `filterable`/`selectable`
  membership (`idField`'s too) are bootstrap-checked (`resolveEntityConfig`),
  not per-request, because the forced sort is entirely config-known before
  any request arrives.

  The fifth built-in, `none`, opts a resource out of pagination altogether
  (ADR-0030, issue #225): `findMany` always serves the whole match set, and a
  client-sent `limit`/`offset` is `KAVO_QUERY_UNSUPPORTED_PARAM` rather than
  silently ignored — both issues collected into one exception when both are
  sent, the same "every issue in one round trip" contract the rest of this
  normalizer keeps. Unlike `cursor`/`since`, "none" produces a plain
  `OffsetPagination` (`{ limit, offset }`, `limit` fixed at `2^31 - 1`, the
  largest value every consumer in the workspace — SQL `LIMIT`, GraphQL's
  `Int`, MongoDB's int32 limit — can carry without its own ceiling), so it
  is structurally indistinguishable from `offset` to `paginationShape`'s
  probe. That is why it is the one strategy `QueryNormalizer.normalizeInput`
  has to recognize by name rather than by the shape it produces: the
  programmatic path computes `limit`/`offset` directly (`Math.min(input.
limit ?? defaultLimit, maxLimit)`) rather than calling the registered
  strategy, the same as it already does for `offset`/`page`, so nothing
  short of a name check would make it unbounded there too.

- **Field selection:** `select=id,name,email` — sparse fieldset for the
  root resource, validated against the selectable allowlist.
  `select[<relation path>]=id,title` narrows an included node, validated
  against the _target_ entity's allowlist (doc 12). Programmatic callers
  pass `FieldSelectionInput`, whose three spellings mirror these wire forms
  and collapse to the same normalized selection (doc 03).
- **Soft delete:** `withDeleted=true` includes soft-deleted rows, which
  are otherwise excluded from every read (doc 11); `onlyDeleted=true`
  narrows a read to _only_ those rows — the trash view — and applies to
  single-row reads as well as lists. On an entity
  that is not soft-deletable either is rejected with
  `KAVO_QUERY_UNSUPPORTED_PARAM`, not ignored; a non-boolean value is a
  field-level 400. The two are contradictory ("everything" vs. "only the
  deleted"), so sending both is `KAVO_QUERY_CONFLICTING_PARAMS`. Neither
  flag changes include resolution: a trash-view read resolves `include=`
  exactly as a live one does.
- **Includes:** `include=posts.comments,profile` — comma-separated
  dot-paths, merged into one validated tree (doc 12). A
  relation that is not on the entity's inclusion allowlist is a 400, never
  a silent omission.

## 4. Search

`search[query]=<term>` (issue #156) is a free-text search across an
explicit, per-entity allowlist of fields — the "search box" case, distinct
from `filter[...]`'s single-field, single-operator predicates. It composes
with the existing filter grammar rather than introducing a second
mechanism: `search[query]` is normalized into a synthetic `Filter` AST
fragment (an `OR` group of `ILIKE` conditions, one per searched field) that
is `AND`-ed into whatever `filter[...]` conditions are already present. No
new `FilterOperator`, no adapter code — every `FilterTranslator` already
handles an arbitrary `OR` group of `ILIKE` conditions, the exact shape a
synthesized fragment produces.

```http
GET /products?search[query]=blue+iphone&search[mode]=words&search[fields]=name,description
```

- **`search[query]=<term>`** — the free-text search term. Required
  whenever any other `search[...]` key is present; `search[mode]` or
  `search[fields]` without it is `KAVO_QUERY_CONFLICTING_PARAMS`.
- **`search[mode]=substring|words`** — optional per-call override of the
  resolved `query.search.mode` setting (`substring` default). Exact-case
  matched, like every wire token in this grammar — an unknown value is
  `KAVO_QUERY_INVALID_VALUE`.
  - **`substring`:** one `OR` group, one `ILIKE '%term%'` condition per
    searched field.
  - **`words`:** the term splits on whitespace; one `OR` group per word,
    `AND`-ed together — every word must match somewhere, in any searched
    field, independently. The synthesized width — word count × searched-field
    count, one `ILIKE` condition per pair — is capped at `query.maxInValues`
    (the same limit `in`/`notIn`/`between` reuse, §3); past it,
    `KAVO_QUERY_LIMIT_EXCEEDED`. Unlike those operators this is not an array
    value, and both factors matter: `searchable`'s own default is _every_ own
    string column, so a wide allowlist alone — with no unusually long query —
    can still exceed the cap.
- **`search[fields]=<comma-list>`** — optional. Narrows which fields this
  call searches to a subset of the entity's resolved `allowed.searchable`
  set; a name outside that set is `KAVO_QUERY_INVALID_FIELD` (the same
  allowlist-rejection family `filter[...]`/`sort=`/`select=` use). Omitted,
  every field in `searchable` is searched.

**Allowlist.** `EntityConfig.allowed.searchable` — same
`QueryFieldSelector` shape as `filterable`/`sortable`/`selectable`, and
relation paths are permitted (`'brand.name'`), reusing the per-path join
machinery `filter[...]` already has for relation filters. Unlike
`filterable`/`sortable`, its zero-config default is narrower than "every
own column": every own **string-kind** column, since a non-string column
has nothing an `ILIKE` fragment can usefully match — a bootstrap
`ConfigurationException` if an explicit override names one anyway (own
columns only; a relation-path leaf's kind is not checked). An explicit
empty allowlist (`searchable: []`) is a deliberate "no fields"
configuration — searching still 400s, the same as `filterable: []` would.

Every synthesized pattern (`%term%`) carries a leading wildcard, so it can
never use a plain B-tree index — a `searchable` column that needs to
support real query volume wants a trigram (Postgres `pg_trgm` `GIN`) index
or equivalent, same as any other leading-wildcard `LIKE`/`ILIKE` query
would.

**Gate.** `search[query]` is rejected outright
(`KAVO_QUERY_UNSUPPORTED_PARAM`) unless `query.search` resolves to an
object (`{ mode, driver }`) rather than `false` — `false` by default,
resolved through the standard global → entity → operation → per-call
precedence chain (doc 08). A nearer scope re-enabling search from `false`
may name only the keys it changes (`search: { mode: "words" }`); the
missing ones backfill from their defaults. This keeps "does this
endpoint support search at all" an explicit decision even though
`searchable`'s own default is permissive. The same rejection covers a
`searchable` that resolves empty.

`query.search.driver` is a **reserved discriminator**, not a pluggable
backend seam: `'orm'` is the only value this schema accepts today, kept so
a future `'postgres'` (native full-text) or `'meilisearch'` driver can land
additively without a breaking config change. It is config-only — there is
no `search[driver]` wire token, and callers never choose the backend
per-request.

**Escaping.** A literal `%` or `_` in a search term is escaped with the
same backslash convention `like`/`ilike` use (§3) before the `%term%`
pattern is built, so a term is always matched literally, never as a SQL
wildcard the caller did not intend.

**Composition example:**

```
GET /products?search[query]=iphone&filter[status][eq]=active

→ AND(
    status EQ 'active',
    OR( name ILIKE '%iphone%', description ILIKE '%iphone%' )
  )
```

**Wire-only.** There is no programmatic `QueryContext.search` — a
programmatic caller composes the equivalent `ILIKE` conditions directly
through `filter`, the same way it composes any other filter.

## 5. Security & robustness

- **Allowed:** every entity resolves filterable/sortable/selectable
  lists at bootstrap — explicitly configured, or defaulting to the
  entity's **own scalar columns** (relation paths are never allowlisted
  implicitly). Anything outside a list → 400
  (`KAVO_QUERY_INVALID_FIELD`), never a silent drop. Programmatic
  callers (`findMany({ filter })`) pass through the **same** allowlist
  and limit checks — typed input skips coercion, not security.
- **`selectable` governs the response as well as the request:** where
  `filterable` and `sortable` only gate what a request may name, an
  _explicitly configured_ `selectable` also narrows the default projection,
  so a column left off it is not serialized at all. That is what makes it a
  confidentiality control rather than a validation list. Omit the key and
  the projection is unchanged
  ([ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection)).
- **Computed fields are selectable only:** a declared computed field
  (doc 04 §7) joins the _selectable_ default and never the filterable or
  sortable one — it has no column to translate to `WHERE`/`ORDER BY`, so
  naming it in either is a bootstrap `ConfigurationException` rather than
  an in-memory fallback
  ([ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated)).
- **Excluding instead of enumerating:** each allowlist key also accepts
  `{ exclude: [...] }` instead of an explicit array — resolved at
  bootstrap to every own column (plus, for `selectable`, every selectable
  computed field) except the ones named, so hiding one column (e.g. a
  soft-delete marker) doesn't require re-listing every other one.
  Resolution starts from exactly the base set that key's plain default
  uses, so the result stays fail-closed like the plain array form.
- **Limits** (configurable per scope, doc 8): `query.maxFilterDepth`
  (default 3) on the built AST — enforced _while_ the wire grammar is being
  converted into the AST, not after, so a pathologically nested
  `filter[and][0][and][0]…` (or the `filter={…}` JSON escape hatch, which
  lets `JSON.parse` build far deeper trees than the bracket grammar's own
  key-splitting could) is rejected before the recursion that builds it goes
  any deeper than the limit allows; `query.maxInValues` (default 100) on
  `in`/`notIn`/`between` arrays; `query.maxLikePatternLength` (default 200)
  on `like`/`ilike` pattern length; `pagination.maxLimit` (default 100) on
  page size.
- **Allowlist identifier safety** (`@kavo/typeorm`, issue #367): `filterable`/
  `sortable` are the only two allowlists whose fields are interpolated raw
  into SQL (a join property path, and a `where`/`addOrderBy` column
  reference — identifiers can't be parameter-bound). An explicit array
  override is used verbatim, so it is validated at bootstrap: a bare entry
  must name a real column, relation, or computed field, and a relation-path
  entry's segments must each look like a plain identifier (checked against
  a strict charset — cross-entity metadata to validate the path's target
  isn't available at bootstrap). `@kavo/typeorm`'s `columnRef` re-checks the
  same charset at request time as defense in depth.
- **Type coercion:** raw wire strings coerce against column metadata
  before becoming AST values — number, boolean (`true`/`false`/`1`/`0`),
  date (ISO 8601), enum (member match), `null` for nullable columns.
  Failures are field-level 400 issues, never a silent `NaN` or
  `Invalid Date`. Coercion consults the **root** entity's column metadata
  only: a relation-path value (`filter[profile.city][eq]=…`) has no entry
  in that map and passes through as a string. Include resolution and
  fieldset validation wire in the target entity's config (doc 12), but
  filter-value coercion does not.
- **Reserved keys:** the bracket tree is built from attacker-controlled
  segments **before** any allowlist check, so it is built on
  prototype-less objects. `filter[__proto__][x]=v` therefore assigns an
  ordinary own key and is rejected as a non-allowlisted field
  (`KAVO_QUERY_INVALID_FIELD`) rather than writing through to
  `Object.prototype`. The same applies to `select[__proto__]`, and the
  deserializer reads request bodies with an own-property check, so a
  prototype polluted by anything else in the host application still cannot
  add a writable field to a request that omitted it.
- **One exception, all issues:** every violation across filter, sort,
  select, and pagination is collected into a single
  `QueryValidationException`, so a client fixes its request in one round
  trip (`errors[]` in the problem-details body).

## 6. Normalization pipeline

```
raw query string (flat bracket keys)
  → DefaultFilterParser   (allowlist + coercion + limits → Filter AST)
  → sort / select parsing (allowed)
  → PaginationStrategy    (defaultLimit / maxLimit / 400s)
  → NormalizedQueryContext  { filter, sort, pagination, select,
                              include: {}, withDeleted: false,
                              onlyDeleted: false, count }
```

`QueryNormalizer.normalizeWire` runs the whole pipeline for HTTP input
(the `WireQuery` marker from the framework layer);
`QueryNormalizer.normalizeInput` runs the same validation minus coercion
for programmatic `QueryContext` input. Adapters consume the normalized
form and never re-validate.
