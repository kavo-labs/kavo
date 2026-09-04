# Search feature design (`search[...]` query parameter)

Status: implemented (issue #156). Three deviations from the design below,
settled at implementation time — see `docs/internals/architecture/05-query-grammar.md`
§4 and `08-configuration.md` for the shipped shape:

- `searchable` lives under `EntityConfig.allowed.searchable`, not as a
  top-level `EntityConfig` key — `filterable`/`sortable`/`selectable`/
  `includable` all moved under `allowed` before this issue landed
  (`479d762`), and `searchable` followed the same precedent.
- `search.enabled`/`search.mode` resolve as `QuerySettings.search.enabled`/
  `.mode` (i.e. `query.search.enabled`), not a top-level `search` settings
  key — per issue #156's acceptance criteria.
- `searchable`'s zero-config default is every own **string-kind** column,
  narrower than this doc's "every own column" — a non-string column has
  nothing an `ILIKE` fragment can usefully match.

Issue #156 also added `search.mode`'s sibling `search.driver: 'orm'` (the
only value accepted today), a reserved discriminator for a future
pluggable search backend — not part of this design's original scope.

## Summary

Add a `search[query]=<term>` HTTP query parameter (e.g.
`GET /products?search[query]=iPhone`) that performs a case-insensitive
substring (or, optionally, per-word) search across an explicit, per-entity
allowlist of fields (`EntityConfig.searchable`, parallel to `filterable`/
`sortable`). It composes with the existing filter grammar rather than
introducing a new mechanism: `search[query]` is normalized into a
synthetic `Filter` AST fragment (an `OR` group of `ILIKE`/`contains`
conditions, one per searched field) that is `AND`-ed into whatever
`filter[...]` conditions are already present. No new `FilterOperator`, no
adapter code changes, no new ADR — this is a config + grammar + normalizer
feature layered entirely on infrastructure that already exists
(`docs/internals/architecture/05-query-grammar.md`,
`docs/internals/architecture/08-configuration.md`).

## Motivation

Kavo's query grammar already supports rich per-field filtering
(`filter[field][operator]=value`), but there's no ergonomic way to do a
single free-text search across multiple fields at once — the common
"search box" use case. Adding it as a first-class top-level query param
(parallel to `sort=`/`fields=`) keeps the ergonomics of a search box while
reusing 100% of the existing filter translation machinery.

Full-text search (DB-native `tsvector`/GIN indexes, ranking, etc.) is
explicitly out of scope for this iteration — it would need a pluggable
search-backend seam and doesn't translate uniformly across all four ORM
adapters. This design keeps it simple: substring/word matching only. A
full-text mode can be layered on later as a separate, additive
`search.mode` value if/when it's needed, without revisiting this design.

## Config: `EntityConfig.searchable` + `search.enabled`/`search.mode` settings

```ts
createCrud(Product, {
  searchable: ["name", "description", "brand.name", "category.name"], // QueryFieldSelector<Entity>, optional
  defaults: {
    search: {
      enabled: true, // defaults to false — search is opt-in per entity/operation
      mode: "substring", // 'substring' | 'words' — defaults to 'substring'
    },
  },
});
```

- `searchable` is a **new top-level `EntityConfig` key**, not nested under
  a `search` object — it sits directly alongside `filterable`/`sortable`/
  `selectable` and has the exact same shape: a `QueryFieldSelector<Entity>`
  (explicit array or `{ exclude: [...] }`). Like `filterable`, **it
  defaults to all own scalar string columns** when left unconfigured — an
  entity that turns search on with no `searchable` override searches every
  string field. An explicit `searchable` narrows that default, same as
  `filterable` narrows filtering.
- `search.enabled` and `search.mode` are new `QuerySettings` keys
  (alongside `maxFilterDepth`/`maxInValues`/`defaultSort`), resolved
  through the standard global → entity → operation → per-call precedence
  chain (see doc 08). `search.enabled` defaults to `false` — a
  `search[query]` param is rejected until the entity (or operation)
  explicitly turns search on, even though `searchable`'s own default is
  permissive. This keeps "does this endpoint support search at all" an
  explicit decision while "which fields" has a sensible zero-config
  default. Follows the mechanism documented in the `add-config-key` skill:
  add to `BUILT_IN_DEFAULTS`, extend `KavoSettings`, confirm
  `mergeSettings` semantics (last-wins per key, standard for scalar
  settings), add `validateSettings` bootstrap checks, update
  `describeResolvedConfig` and doc 08's key table.
- Unlike `filterable`/`sortable` today, `searchable` entries **may
  include relation paths** (e.g. `brand.name`), reusing the dotted-path
  convention and per-path join machinery the filter translators already
  implement for relation filters.
- Resolution happens once at bootstrap in `resolve-entity-config.ts`
  alongside `filterable`/`sortable`/`selectable`, producing
  `ResolvedEntityConfig.searchable: readonly FieldPath<Entity>[]` and
  `ResolvedEntityConfig.search: { enabled: boolean, mode: 'substring' | 'words' }`,
  then deep-frozen like the rest of `ResolvedEntityConfig`.

## Wire grammar

A new bracket-notation top-level param, `search[...]`, following the same
bracket convention `filter[...]` already uses for grouping related
sub-state under one concept:

```
GET /products?search[query]=blue+iphone&search[mode]=words&search[fields]=name,description,brand.name,category.name
```

- `search[query]=<term>` — the free-text search term. Required whenever
  any other `search[...]` key is present.
- `search[mode]=substring|words` — optional per-call override of the
  resolved `search.mode` setting.
- `search[fields]=<comma-separated field list>` — optional. **Narrows**
  which fields this call searches, as a subset of the entity's resolved
  `searchable` allowlist (same comma-separated convention as the response
  `fields=` param). If omitted, all of `searchable` is searched. This lets
  a caller do a full-allowlist search by default but scope a given request
  down (e.g. a UI that offers "search names only").

### Validation

- If `search.enabled` resolves to `false` (the default) and
  `search[query]` is supplied, this is a `KAVO_QUERY_INVALID_VALUE`-style
  400 — search is not silently ignored, it must be turned on.
- If `search.enabled` is `true`, `searchable` always resolves to a
  non-empty field set (its own default is "all own scalar string
  columns"), so there is no empty-allowlist case to reject once search is
  on — unless an explicit `searchable: []` override reduces it to nothing,
  which is still a 400 on `search[query]` (an explicit empty allowlist is
  a deliberate "no fields" configuration, same as `filterable: []`).
- `search[fields]` containing any field not present in the resolved
  `searchable` allowlist is a 400 (same allowlist-violation family as an
  unselectable field in `fields=` or an unsortable field in `sort=`).
- `search[mode]` with a value outside `substring`/`words` is a 400
  (exact-case matched, like existing wire tokens — no aliases).
- `search[mode]` or `search[fields]` present without `search[query]` is a
  400 — these are modifiers of a search, not independent params.

### Normalization → AST synthesis

Parsed in `default-filter-parser.ts` (or a small module it delegates to),
then folded into `QueryNormalizer`'s output. `search[fields]`, if present,
narrows the field set used below to its intersection with the resolved
`searchable` allowlist; otherwise the full `searchable` allowlist is used.
The synthesized fragment is **`AND`-ed with whatever `filter[...]`
conditions are already present** — `search[query]` narrows the result set,
it doesn't replace explicit filters.

**substring mode** (default): one `OR` group, one `ILIKE` condition per
searched field:

```
GET /products?search[query]=iphone

→ OR(
    name ILIKE '%iphone%',
    description ILIKE '%iphone%',
    brand.name ILIKE '%iphone%',
    category.name ILIKE '%iphone%'
  )
```

**words mode**: split the term on whitespace, build one `OR` group per
word (same shape as above, one group per word), then `AND` the per-word
groups together — every word must match somewhere, in any searched field,
independently:

```
GET /products?search[query]=blue+iphone&search[mode]=words&search[fields]=name,description

→ AND(
    OR(name ILIKE '%blue%', description ILIKE '%blue%'),
    OR(name ILIKE '%iphone%', description ILIKE '%iphone%')
  )
```

Composed with an existing `filter[...]` param, the whole thing is one more
`AND` branch at the root:

```
GET /products?search[query]=iphone&filter[status][eq]=active

→ AND(
    status EQ 'active',
    OR(name ILIKE '%iphone%', description ILIKE '%iphone%', brand.name ILIKE '%iphone%', category.name ILIKE '%iphone%')
  )
```

### Escaping

Reuses the existing `%`/`_` escape-and-bind logic already in the filter
parser/adapters (doc 05 §1's `LIKE`/`ILIKE` escaping invariant): a literal
`%` or `_` typed into a search term is escaped and matched literally, not
treated as a SQL wildcard. The caller-facing `search[query]` term is
always a plain string — Kavo adds the `%...%` wrapping and escaping
itself, unlike `filter[name][like]=` where the caller supplies the raw
LIKE pattern.

## Adapter translation (no code changes required)

All four `FilterTranslator` implementations already handle arbitrary
`OR` groups of `LIKE`/`ILIKE`/pattern conditions — the exact shape a
synthesized search fragment produces — so this feature needs **zero
adapter-level changes**:

- **TypeORM**: real `ILIKE` (`LOWER(col) LIKE LOWER(:p) ESCAPE :pEscape`),
  `OR` via `Brackets`, relation paths via existing per-path join dedup.
- **Prisma**: no raw pattern operator, but search terms have no literal
  `%`/`_` need — translates cleanly to `contains` (Prisma's substring
  match), gated by existing `caseInsensitiveMode` config for
  Postgres-family connectors.
- **MikroORM**: `$ilike` when `caseInsensitiveFilters` is enabled on the
  driver, else falls back to `$like`; relation paths use the existing
  nested-path translation (no joins, declarative like Prisma).
- **Mongoose**: unanchored `$regex` (the substring case, as opposed to the
  anchored-for-equality case `LIKE 'john'` already uses) — this is exactly
  the form a "contains" search needs.

## Testing plan

- **`packages/core/tests/`**: config resolution of `searchable` (array +
  `exclude` form, relation paths, default-all-string-columns when
  unconfigured); `search.enabled`/`search.mode` setting resolution through
  the precedence chain; parser tests for
  `search[query]`/`search[mode]`/`search[fields]` synthesizing the correct
  AST shape in both modes; `search[fields]` narrowing to a subset of
  `searchable`; 400 on `search[query]` when `search.enabled` is `false`;
  400 on `search[query]` with an explicit empty `searchable: []`; 400 on
  `search[fields]` containing a field outside `searchable`; 400 on invalid
  `search[mode]` value; 400 on `search[mode]`/`search[fields]` without
  `search[query]`; escaping of literal `%`/`_` in terms; `search[query]`
  composing (AND) correctly with existing `filter[...]` params.
- **`packages/orms/*/tests/`**: one test per adapter (TypeORM, Prisma,
  MikroORM, Mongoose) confirming the synthesized OR-group produces
  correct query output for both modes, including a relation-path field,
  a `search[fields]`-narrowed request, and each adapter's specific
  translation path (`contains` for Prisma, unanchored `$regex` for
  Mongoose).
- **`packages/frameworks/nest/tests/`**: end-to-end test of
  `GET /products?search[query]=iphone&search[mode]=words` through a
  generated route.

## Docs plan

- `docs/internals/architecture/05-query-grammar.md`: new `## 4. Search`
  section — grammar, both modes, escaping behavior, composition with
  `filter[...]`, worked examples.
- `docs/internals/architecture/08-configuration.md`: add `searchable`
  (default: all own scalar string columns, like `filterable`) and
  `search.enabled` (default `false`) / `search.mode` (default
  `'substring'`) to the entity-config / `QuerySettings` key tables.

## Non-goals / explicitly deferred

- Full-text search (DB-native `tsvector`, ranking, relevance scoring) —
  noted above as a possible future additive `search.mode` value.
- A pluggable search-operator/backend registry — no evidence yet that
  one is needed; would warrant its own ADR if it ever is.

## ADR

None required. This feature adds one config key (`searchable`) via the
existing `QueryFieldSelector` mechanism, two `QuerySettings` keys
(`search.enabled`, `search.mode`), and one bracket-notation grammar
extension (`search[...]`) that compiles down to existing
`Filter`/`FilterGroup`/`ILIKE` AST nodes — per the `add-adr` skill's own
guidance, a new ADR is for a new seam or invariant, not for extending an
already-documented one.
