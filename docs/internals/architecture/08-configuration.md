# 08 — Configuration System

One layered model, one schema (`KavoSettings`), one precedence chain:

```
built-in defaults → global (createKavo) → entity (createCrud)
                  → operation (operations.<id>) → per-call (KavoCallOptions)
```

## 1. Schema and built-in defaults

`KavoSettings` is narrower than it once was. Issue #386 pulled the
request-cost ceilings (filter depth, `IN` array length, `like` pattern
length, include depth/breadth), `search`, and the per-axis `defaults`
(`sort`/`select`/`include`) out of this merged tree entirely — they are
now part of the entity-scope-only `filter`/`sort`/`select`/`search`/
`include` blocks on `EntityConfig` (§4 below), each with its own built-in
fallback and no global default. What remains in `KavoSettings` is exactly
what still makes sense to merge through global → entity → operation →
per-call.

`BUILT_IN_DEFAULTS` (`core/src/config/defaults.ts`):

| Key                                                                | Default                                | Notes                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pagination.defaultLimit` / `maxLimit`                             | 20 / 100                               | `defaultLimit ≤ maxLimit` enforced                                                                                                                                                                                                                                                                                                        |
| `pagination.strategy`                                              | `"offset"`                             | `"page"` built in; custom via `paginationStrategies`                                                                                                                                                                                                                                                                                      |
| `pagination.count`                                                 | `true`                                 | `false` skips the count query; envelope reports `total: null`                                                                                                                                                                                                                                                                             |
| `errors.exposeInternals`                                           | `false`                                | leak driver detail into responses                                                                                                                                                                                                                                                                                                         |
| `cache.ttl` / `etag`                                               | unset / `true`                         | TTL result cache for `findOne`/`findMany` (a positive `ttl` turns it on, omitted = off, `ttl: 0` fails validation, `ttl: false` overrides an inherited `ttl` back off — no separate `enabled` key) + ETag on single-item responses with `If-None-Match`/`If-Match`; the result cache's backing store is **not** here (ADR-0020, ADR-0031) |
| `delete.field` / `strategy`                                        | `"deletedAt"` / `"auto"`               | `auto` = soft when the entity has the marker field, `false` disables                                                                                                                                                                                                                                                                      |
| `identifier.field`                                                 | unset (`EntityMetadata.idField`)       | retargets `…One` route/`findOneById` lookup to a non-PK scalar column (ADR-0052); global → entity only, excluded from every operation's `Allowed` union; rejected at bootstrap on a composite-key entity, an unknown/relation/derived field, a non-`string`/`number` kind, or an adapter that doesn't implement `supportsIdentifierField` |
| `realtime` / `.events` / `.subscribableFields` / `.onPublishError` | `false` / `{}` (unset) / unset / unset | `false` disables the subtree; any object turns it on — no separate `enabled` key; per-operation event toggles + field allowlist; registered transports are **not** here (ADR-0023)                                                                                                                                                        |
| `operations.<id>`                                                  | `{}` (unset)                           | global operation-enablement default (issue #38); see below                                                                                                                                                                                                                                                                                |

`filter.limits`/`include.limits`, `search`, and `sort.default`/
`select.default`/`include.default` each carry their own built-in fallback
(`BUILT_IN_FILTER_LIMITS`, etc.) resolved directly from `EntityConfig` by
`resolve-entity-config.ts` (issue #386) — see §4. `bulk` is not a config
key at all today: bulk operations are contracted and registered but
disabled, with nothing yet to configure.

**Schema extensibility rule:** new features add keys to this schema —
they never add a second config mechanism. The reserved keys above are
already merged and validated so a later feature adds behavior only.

## 2. Merge semantics (normative)

Implemented in `mergeSettings` (`merge-settings.ts`):

- Scalars and objects-as-values: nearer scope **replaces** farther scope,
  key by key — an override supplies only what it changes.
- `false` disables an inheritable feature where the schema allows it
  (`delete: false`, `operations.<id>: false` at either the global
  boolean map or the entity scope); a nearer object re-enables.
- Arrays replace wholesale. `undefined` scopes are skipped.

`cache` is not a special case (ADR-0031 as amended): it merges with exactly
the generic algebra above. The result cache's on/off is carried by `ttl`'s
presence — a positive `ttl` in an override is on, an omitted `ttl` is off —
so `cache: { ttl: 60 }` at any scope enables against the built-in default's
absent `ttl`, and an etag-only override (`cache: { etag: false }`) leaves
the result cache off rather than accidentally flipping it on. `ttl: false`
is the explicit sentinel for overriding an _inherited_ `ttl` back off
without disabling `etag` at that scope; `ttl: 0` is rejected at bootstrap
rather than treated as off.

An `EntityConfig` mixes settings keys with structural keys (`dto`,
`schema`, `filter`, `sort`, `select`, `search`, `include`, `create`,
`update`, `policy`, `relations`, `operations`); only the settings subset
participates in the merge. `relations` (per-relation `read` loading tuning and `write.strategy`
array-mutation policy) is entity-scope-only for the same reason — resolved
by `DefaultRelationRegistry` at bootstrap, no global default; it folded the
former `KavoSettings.relations.edges` and `KavoSettings.arrayMutation` keys
into one block (issue #404, [ADR-0029](/internals/adr/0029-array-relations-may-opt-into-replace-writes)).
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

**The per-operation settings scope is narrowed at the type level** (issue
#415). At runtime `settingsFor(operation)` is the whole `KavoSettings`
subtree, but `OperationConfig` only accepts the keys that operation's
engine stages actually read, so a key it would ignore is a compile error
rather than a silently-dropped value:

| key          | accepted on                                                                 |
| ------------ | --------------------------------------------------------------------------- |
| `pagination` | `findMany`                                                                  |
| `realtime`   | `createOne`, `updateOne`, `patchOne`, `deleteOne`, `restoreOne`, `purgeOne` |
| `delete`     | `findOne`, `findMany`, `deleteOne`, `restoreOne`, `purgeOne`                |
| `cache`      | every operation                                                             |
| `errors`     | every operation                                                             |

`identifier` is on no operation's accepted list at all (ADR-0052) — it is
resolved once, at entity scope, onto `ResolvedEntityConfig.identifierField`,
and never varies per operation or per call.

`delete` is on the reads and the delete family because `configViewFor`
resolves a soft-delete view for each of them — a per-operation `strategy`
override (`operations: { deleteOne: { delete: { strategy: "hard" } } }`) is
a supported way to force `hard` on one operation of a soft-deletable
entity. It is _not_ accepted on `createOne`/`updateOne`/`patchOne`, which
consult no soft-delete strategy. `cache` is _not_ narrowed: its `etag` half
gates `If-Match`/`304` on every single-row operation — the void
`deleteOne`/`purgeOne` included — not just the two reads its `ttl` half
caches. For a **custom** operation the accepted subset follows from the
`kind`/`cardinality` the entry declares: `errors`/`cache` always, `delete`
on any `kind: "read"`, `pagination` also on a `kind: "read", cardinality:
"many"` one; `realtime` never, since a custom operation is not a realtime
event source.

## 3. Resolution timing and immutability

All merging happens **once at bootstrap** (`resolveEntityConfig`) into a
deep-frozen `ResolvedEntityConfig`: entity-scope settings, precomputed
per-operation views behind `settingsFor(operation)`, resolved allowlists
(explicit, or derived from own scalar columns plus any selectable computed
fields), the default response `projection` (`null` unless
`select.fields` was configured explicitly —
[ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection)),
the cached `DtoResolver`, the resolved
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
— the same structural relationship `dto`/
`relations` already have to `settings` (ADR-0023).

## 4. Bootstrap validation

`validateSettings` fails fast with a `ConfigurationException` naming the
**entity, the key path, and the offending value**
(`Invalid configuration for entity 'User' at 'pagination.maxLimit':
expected a positive integer, got -1`). The same bar applies to unknown
pagination strategies, missing infrastructure, non-`@Kavo` controllers in
`forFeature`, and custom-operation id collisions.

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

### `sort.default`

Order applied when a request supplies no `sort` at all — a client- or
caller-supplied `sort`, when present, always wins outright; the two never
merge. Each entry is the same wire shorthand `sort=` accepts (`-field` for
descending), not the internal `Sort` AST — `QueryNormalizer.defaultSortOf`
parses each token with the same per-token logic `parseSort` uses for the
wire param (issue #375, moved onto `EntityConfig.sort` by issue #386).
Unlike a `KavoSettings` key, `sort.default` is entity-scope-only structural
config: no global default, no per-operation or per-call override — it
resolves once, at bootstrap, alongside the rest of `EntityConfig.sort`.
Fields are checked against `sort.fields`, the same allowlist client-supplied
`sort` fields are checked against, at that same bootstrap pass
(`resolveEntityConfig`) — so a bad default fails fast rather than producing
a broken `ORDER BY` on the first request that hits it. Doc 05 covers the
request-time semantics (client `sort` vs. this fallback).

### `select.default` / `include.default`

The other two per-axis `default` keys (issue #375, moved onto `EntityConfig`
by issue #386), same posture: entity-scope-only, applied only on omission,
checked against that axis's own `fields` allowlist at the same bootstrap
pass `sort.default` is. `select.default` fields are checked against
`select.fields`; absent, the projection is unchanged (every selectable
field). `include.default` names are checked against `include.fields`
([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists),
[ADR-0046](/internals/adr/0046-defaults-block-for-omitted-query-axes)) — the
replacement for the old per-relation `relations.edges.<name>.defaultInclude`
boolean, now one flat entity-wide list. (Per-relation loading tuning and
the array-mutation write strategy that also lived on `relations.edges`
became `EntityConfig.relations.<name>.read` / `.write` in issue #404.)

### `search.fields`

Same `QueryFieldSelector` shape and resolution as `filter.fields`/
`sort.fields`/`select.fields`, but its zero-config default is narrower:
every own **string-kind** column, not every own column — a non-string
column has nothing an `ILIKE` fragment can usefully match. Relation paths
are permitted (unlike `filter.fields`/`sort.fields`), reusing the per-path
join machinery `filter[...]` already resolves for relation filters. See
doc 05 §4 for the wire grammar it gates.

A name in `include.default` absent from `include.fields` is a bootstrap
`ConfigurationException` — it would load a relation clients cannot ask for
([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)).
`validateSettings` only ever sees `KavoSettings`, which does not carry
`filter`/`sort`/`select`/`search`/`include`, so this cross-check runs
separately, in `validateDefaults` (`resolve-entity-config.ts`, renamed from
`validateDefaultSort`), once those per-axis blocks have resolved — the
same reason `pagination.since.field` is checked outside `validateSettings`
too.

## 5. Root factory and framework skin

`createKavo({ defaults, infrastructure, paginationStrategies })` is the
core entry point; the bare `createCrud(Entity, config?, runtime)` is an
implicit root instance with built-in defaults — the zero-config path pays
nothing for any of this. `KavoModule.forRoot` (doc 10) is a thin skin:
it passes `defaults` through untouched and contributes only its own
route concerns via the `OperationMetadata` augmentation (ADR-0007).

## 6. Debug dump

`kavo.describe(entityName)` (backed by `describeResolvedConfig`) returns
the frozen result for one entity — settings, the resolved `filter`/`sort`/
`select`/`search`/`include` allowlists, the declared computed-field names,
relations, and every per-operation view — as a plain printable object.
