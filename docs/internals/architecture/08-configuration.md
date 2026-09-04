# 08 — Configuration System

One layered model, one schema (`KavoSettings`), one precedence chain:

```
built-in defaults → global (createKavo) → entity (createCrud)
                  → operation (operations.<id>) → per-call (KavoCallOptions)
```

## 1. Schema and built-in defaults

`BUILT_IN_DEFAULTS` (`core/src/config/defaults.ts`):

| Key                                                                | Default                                  | Notes                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pagination.defaultLimit` / `maxLimit`                             | 20 / 100                                 | `defaultLimit ≤ maxLimit` enforced                                                                                                                                                                                                                                                                                              |
| `pagination.strategy`                                              | `"offset"`                               | `"page"` built in; custom via `paginationStrategies`                                                                                                                                                                                                                                                                            |
| `pagination.count`                                                 | `true`                                   | `false` skips the count query; envelope reports `total: null`                                                                                                                                                                                                                                                                   |
| `query.maxFilterDepth` / `maxInValues`                             | 3 / 100                                  |                                                                                                                                                                                                                                                                                                                                 |
| `query.defaultSort`                                                | `[]` (unset)                             | order applied when a request supplies no `sort` (issue #56); see below                                                                                                                                                                                                                                                          |
| `query.search`                                                     | `false`                                  | `false` or `{ mode, driver }`; `search[query]` is a 400 until a scope sets an object (issue #156, doc 05 §4). `mode`/`driver` backfill from their defaults when a partial re-enables it                                                                                                                                         |
| `query.search.mode`                                                | `"substring"`                            | `"substring"` \| `"words"`; per-call override via `search[mode]`                                                                                                                                                                                                                                                                |
| `query.search.driver`                                              | `"orm"`                                  | reserved discriminator — the only value accepted today; config-only, no wire counterpart                                                                                                                                                                                                                                        |
| `errors.exposeInternals`                                           | `false`                                  | leak driver detail into responses                                                                                                                                                                                                                                                                                               |
| `relations.maxIncludeDepth` / `maxIncludedNodes`                   | 2 / 10                                   | include depth budget and total node cap                                                                                                                                                                                                                                                                                         |
| `relations.edges.<name>`                                           | `{}`                                     | per-relation loading tuning — `defaultInclude` / `maxDepth` / `strategy`; permission is `allowed.includable`, entity scope only (ADR-0028)                                                                                                                                                                                      |
| `relations.edges.<name>.write`                                     | unset (`false`)                          | `boolean \| { strategy }` — opts a to-many relation into `arrayMutation` writes, inheriting the entity default (`true`) or pinning its own strategy (`{ strategy }`, issue #223); rejected on a to-one relation                                                                                                                 |
| `arrayMutation.strategy`                                           | unset — no built-in default (issue #221) | `"replace"` \| `"resource"` \| `"jsonPatch"` — all three are implemented; the entity-wide default a `write: true` relation inherits; a write-opted relation with no strategy resolvable anywhere demands one be declared; `false` disables the feature wholesale and wins over any per-relation override (ADR-0029, issue #223) |
| `cache.ttl` / `etag`                                               | `0` / `true`                             | TTL result cache for `findOne`/`findMany` (a positive `ttl` turns it on, `0` = off — no separate `enabled` key) + ETag on single-item responses with `If-None-Match`/`If-Match`; the result cache's backing store is **not** here (ADR-0020, ADR-0031)                                                                          |
| `softDelete.field` / `strategy`                                    | `"deletedAt"` / `"auto"`                 | `auto` = soft when the entity has the marker field, `false` disables                                                                                                                                                                                                                                                            |
| `realtime` / `.events` / `.subscribableFields` / `.onPublishError` | `false` / `{}` (unset) / unset / unset   | `false` disables the subtree; any object turns it on — no separate `enabled` key; per-operation event toggles + field allowlist; registered transports are **not** here (ADR-0023)                                                                                                                                              |
| `operations.<id>`                                                  | `{}` (unset)                             | global operation-enablement default (issue #38); see below                                                                                                                                                                                                                                                                      |
| `bulk.mode` / `maxBatchSize`                                       | `"atomic"` / 500                         | reserved (bulk is not built)                                                                                                                                                                                                                                                                                                    |

**Schema extensibility rule:** new features add keys to this schema —
they never add a second config mechanism. The reserved keys above are
already merged and validated so a later feature adds behavior only.

## 2. Merge semantics (normative)

Implemented in `mergeSettings` (`merge-settings.ts`):

- Scalars and objects-as-values: nearer scope **replaces** farther scope,
  key by key — an override supplies only what it changes.
- `false` disables an inheritable feature where the schema allows it
  (`softDelete: false`, `operations.<id>: false` at either the global
  boolean map or the entity scope); a nearer object re-enables.
- Arrays replace wholesale. `undefined` scopes are skipped.

`cache` is not a special case (ADR-0031): it merges with exactly the
generic algebra above. The result cache's on/off is carried by `ttl`
itself — a positive `ttl` in an override is on, `0` is off — so `cache:
{ ttl: 60 }` at any scope enables against the `ttl: 0` built-in default,
and an etag-only override (`cache: { etag: false }`) leaves the result
cache off rather than accidentally flipping it on.

An `EntityConfig` mixes settings keys with structural keys (`dto`,
`allowed`, `computed`, `operations`); only the settings subset
participates in the merge. `computed` carries functions, so like `dto` it
is entity-scope-only and never merges through the chain — see
[ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated).
`policy` is the same shape of exception, for the same reason (it is itself
a closure): it resolves through its own nearest-scope-wins walk in
`resolveEntityConfig` — `operations.<id>.policy`, then `EntityConfig.policy`
(one default function for the whole entity), then a `GlobalConfig.policy`
set once at `createKavo` (ADR-0037) — never `mergeSettings`, and, unlike
every ordinary settings key, it takes **no** per-call override at any of its
three scopes, since a per-call parameter that could loosen a policy would
let a caller weaken its own authorization. `GlobalConfig.policy` is
deliberately not a `KavoSettings` field even though it is `policy`'s
global-scope home — `DeepPartial` (what `GlobalConfig.defaults` is typed as)
recurses into any property type that extends `object`, which a function type
does, so it would produce an object type keyed by `Function.prototype`'s own
properties instead of a callable function.

`authorization` (governing `authorization.required`, the `policy`
default-deny switch) is, by contrast, an **ordinary** `KavoSettings` key —
it merges through the generic algebra above at every scope including
global, unlike `policy`. `KavoEngine.configViewFor` pins it back to the
pre-merge value after applying a per-call override, the one scope it is
excluded from, for the same "no loosening" reason `policy` itself is
excluded from per-call entirely. See
[ADR-0035](/internals/adr/0035-authorization-required-default-deny-switch).

**`operations` is a special case, at two different scopes.** At _global_
scope, `KavoSettings.operations` is a plain boolean map
(`Partial<Record<StandardOperationId, boolean>>`) and merges through
`mergeSettings` exactly like any other key — `createKavo({ defaults:
{ operations: { deleteOne: false } } })` sets an app-wide default. At
_entity/operation_ scope, `EntityConfig.operations`/`OperationConfig` is
a structurally richer, per-entity-typed shape (it also carries
`handler`/`meta`), so it is deliberately **excluded** from the generic
`SETTINGS_KEYS` merge (`resolve-entity-config.ts`) — folding it in would
feed a `handler` function through the boolean-shaped global merge.
Instead, `createOperationRegistry` resolves `enabled` for each operation
directly. When the entity declares no `operations` key at all, the chain is
the unconditional/soft-delete-declared default, then the global
`operations.<id>` boolean. The moment the entity _does_ declare `operations`
(ADR-0038, issue #257), that key becomes an explicit whitelist: an id the config
doesn't name at all resolves to disabled, regardless of its
unconditional/soft-delete/global default. `true`/`false` names an id
explicitly, in either direction; an object carrying settings enables by
being named — there's no `enabled` field, since the object's own presence
already says so. See ADR-0015 for what the global default can and cannot
reach in `@kavo/nest`.

The entity-scope map also holds keys the global one cannot: an
`operations` key outside the eight standard ids declares a **custom**
operation (issue #145, doc 07 §1a), and the global boolean map is keyed by
`StandardOperationId`, so nothing at global scope can enable, disable or
name one. Everything else about a custom entry follows the same rules as a
standard one, including the per-operation settings scope: the loop that
precomputes `settingsFor(operation)` walks `operations` by key and never
checks the key against the standard table.

## 3. Resolution timing and immutability

All merging happens **once at bootstrap** (`resolveEntityConfig`) into a
deep-frozen `ResolvedEntityConfig`: entity-scope settings, precomputed
per-operation views behind `settingsFor(operation)`, resolved allowlists
(explicit, or derived from own scalar columns plus any selectable computed
fields), the default response `projection` (`null` unless
`allowed.selectable` was configured explicitly —
[ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection)),
the cached `DtoResolver`, the validated `computed` map, the resolved
`policy` map (ADR-0037), and the relation registry. There is no runtime mutation API — per-call
overrides (`KavoCallOptions.settings`) are merged as _parameters_ onto
the operation view inside the engine, validated, and discarded with the
request.

`deepFreeze` recurses into everything reachable from the settings tree, so
a `KavoSettings` key must be plain data — this is why registered realtime
transports (live objects, not data) are resolved separately, on
`ResolvedEntityConfig.realtimeTransports` from `KavoOptions.
realtimeTransports`, and the result-cache store the same way, on
`ResolvedEntityConfig.cacheStore` from `KavoOptions.cacheStore` (ADR-0031)
— the same structural relationship `dto`/`computed`/
`relations` already have to `settings` (ADR-0023).

## 4. Bootstrap validation

`validateSettings` fails fast with a `ConfigurationException` naming the
**entity, the key path, and the offending value**
(`Invalid configuration for entity 'User' at 'pagination.maxLimit':
expected a positive integer, got -1`). The same bar applies to unknown
pagination strategies, missing infrastructure, non-`@Kavo` controllers in
`forFeature`, and custom-operation id collisions.

### `computed`

Every way a computed-field declaration can be structurally wrong fails at
bootstrap rather than as a surprising response later
([ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated)):

- a name that collides with a real column or relation — the shadowed value
  would silently vanish from every response;
- a descriptor with no `resolve` function;
- an `async` `resolve`, whose promise the serializer would emit unawaited;
- the name `__proto__`, which is not an ordinary object key and would
  disappear from the resolved map without a word — caught in both of its
  spellings, by name for `{ ["__proto__"]: … }` and by inspecting the
  declared record's prototype for the object-literal `{ __proto__: … }`,
  which invokes the prototype setter and never reaches `Object.keys`;
- a computed name in a configured `allowed.filterable`/`sortable`/
  `searchable` — there is no column to translate to `WHERE`/`ORDER BY`, and
  in-memory post-fetch filtering is rejected rather than deferred;
- a computed name declared by a registered `create`/`update`/`patch` DTO
  class — the value could only ever be discarded, and the DTO's runtime
  shape is what `@kavo/nest` builds `@ApiBody` from, so OpenAPI would
  advertise a property the engine unconditionally drops.

### `policy`

`policy` is a plain function at every scope (ADR-0037), so there is no
shape left to statically validate against `createOne`/`findMany`'s lack of a
single row — the engine always calls the resolved function, with
`entity: undefined` on those two ids, whether the policy came from the
operation, the entity default, or the global default. The one bootstrap
check left, applied at all three scopes, is that a resolved `policy` value
actually is a function: a non-function value — including the pre-ADR-0033
per-operation entity-scope map shape (`{ updateOne: hasPermission(...) }`)
if a caller still passes one — fails at bootstrap with a
`ConfigurationException` naming the entity and the scope's path, the same
bar every other entry in this section holds to.

### `query.defaultSort`

Order applied when a request supplies no `sort` at all — a client- or
caller-supplied `sort`, when present, always wins outright; the two never
merge. Each entry is `{ field, direction }` (the same shape as a parsed
`Sort`), resolved through the full precedence chain like every other
setting, so it can be set globally, per entity, per operation, or per call.
Fields are checked against the same sortable allowlist client-supplied
`sort` fields are checked against, but as soon as the value is set rather
than when a request uses it: at **bootstrap** (`resolveEntityConfig`) for
global/entity/operation scope, and when a per-call override is merged
(`KavoEngine.configViewFor`) for per-call scope — so a bad default fails
fast at the scope that introduced it instead of producing a broken
`ORDER BY` on the first request that hits it. Doc 05 covers the
request-time semantics (client `sort` vs. this fallback).

### `allowed.searchable`

Same `QueryFieldSelector` shape and resolution as `filterable`/`sortable`/
`selectable`, but its zero-config default is narrower: every own
**string-kind** column, not every own column — a non-string column has
nothing an `ILIKE` fragment can usefully match. Relation paths are
permitted (unlike `filterable`/`sortable`), reusing the per-path join
machinery `filter[...]` already resolves for relation filters. See doc 05
§4 for the wire grammar it gates.

### `relations.edges.<name>.defaultInclude`

`defaultInclude: true` on a relation absent from `allowed.includable` is a
bootstrap `ConfigurationException` — it would load a relation clients cannot
ask for ([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)).
`validateSettings` only ever sees `KavoSettings`, which does not carry
`allowed`, so this cross-check runs separately, in
`validateIncludableRelations` (`resolve-entity-config.ts`), once `allowed`
has resolved — the same reason `query.defaultSort` and
`pagination.since.field` are checked outside `validateSettings` too.

## 5. Root factory and framework skin

`createKavo({ defaults, infrastructure, paginationStrategies })` is the
core entry point; the bare `createCrud(Entity, config?, runtime)` is an
implicit root instance with built-in defaults — the zero-config path pays
nothing for any of this. `KavoModule.forRoot` (doc 10) is a thin skin:
it passes `defaults` through untouched and contributes only its own
route concerns via the `OperationMetadata` augmentation (ADR-0007).

## 6. Debug dump

`kavo.describe(entityName)` (backed by `describeResolvedConfig`) returns
the frozen result for one entity — settings, allowed, the declared
computed-field names, relations, and every per-operation view — as a plain
printable object.
