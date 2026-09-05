# Config keys

The complete `KavoSettings` field-by-field table: every key, its type, its default, and where it's consulted. [Guides/Configuration](/guides/configuration/) covers the same schema as task-based prose ("how do I configure X"). This page is the exhaustive lookup form for when you already know the key and want its type and default.

Every key below is set the same way at every scope of the [precedence chain](/guides/configuration/): built-in defaults, then global (`KavoModule`), then entity (`@Kavo` config), then operation (`operations.<id>`), then per-call. Each scope overrides the one before it for the fields it sets.

## pagination

| Key                       | Type                                                  | Default       |
| ------------------------- | ----------------------------------------------------- | ------------- |
| `pagination.defaultLimit` | `number`                                              | `20`          |
| `pagination.maxLimit`     | `number`                                              | `100`         |
| `pagination.strategy`     | `"offset" \| "page" \| "cursor" \| "since" \| string` | `"offset"`    |
| `pagination.count`        | `boolean`                                             | `true`        |
| `pagination.since.field`  | `string`                                              | `"updatedAt"` |

See [Pagination](/querying/pagination) and [Settings](/guides/configuration/settings#pagination).

## limits

| Key                    | Type     | Default |
| ---------------------- | -------- | ------- |
| `limits.filterDepth`   | `number` | `3`     |
| `limits.inValues`      | `number` | `100`   |
| `limits.likePattern`   | `number` | `200`   |
| `limits.includeDepth`  | `number` | `2`     |
| `limits.includedNodes` | `number` | `10`    |

The request-cost ceilings: a filter's nesting depth, an `IN`/`NOT_IN`/`BETWEEN` array's length, a `like`/`ilike` pattern's character length, and relation-include depth/breadth. `limits.includeDepth` is overridable per-subtree by `relations.edges.<name>.maxDepth`, below. See [Filtering](/querying/filtering), [Relations](/features/relations).

## search

| Key             | Type                        | Default       |
| --------------- | --------------------------- | ------------- |
| `search`        | `{ mode, driver } \| false` | `false`       |
| `search.mode`   | `"substring" \| "words"`    | `"substring"` |
| `search.driver` | `"orm"`                     | `"orm"`       |

See [Search](/querying/search), [Sorting](/querying/sorting).

## errors

| Key                      | Type      | Default |
| ------------------------ | --------- | ------- |
| `errors.exposeInternals` | `boolean` | `false` |

See [Errors](/reference/errors).

## relations

| Key                               | Type                                   | Default                        |
| --------------------------------- | -------------------------------------- | ------------------------------ |
| `relations.edges.<name>.maxDepth` | `number`                               | inherits `limits.includeDepth` |
| `relations.edges.<name>.strategy` | `"auto" \| "join" \| "batch" \| "key"` | `"auto"`                       |
| `relations.edges.<name>.write`    | `boolean \| { strategy }`              | `false`                        |

Whether a relation is includable at all is `allowed.includable` (entity scope only); see [Reference/Config keys §allowed](#allowed-entity-scope-only). Which includable relations load by default is `defaults.include`, below. `relations.edges` is loading tuning only for a relation that is already includable — no permission, no default. `strategy: "key"` is owning-side to-one only (a to-many or an inverse `@OneToOne` has no local FK — bootstrap error): it materializes the edge as `{ <pk>: value }` read from the parent row's own foreign-key column, no join, `null` when the FK is null. `write: true` inherits the entity's own `arrayMutation.strategy`. `write: { strategy }` pins this relation's own strategy instead, independent of the entity default (issue #223). See [Relations](/features/relations).

## defaults

| Key                | Type                                           | Default                        |
| ------------------ | ---------------------------------------------- | ------------------------------ |
| `defaults.sort`    | `(-FieldPath \| FieldPath)[]` (wire shorthand) | `[]`                           |
| `defaults.select`  | `FieldPath[]` (optional)                       | unset — every selectable field |
| `defaults.include` | `string[]` (relation names)                    | `[]`                           |

What a request looks like when the client specifies nothing — applied only when the request omits that axis; a client-supplied value replaces it outright, never merges. `defaults.sort` takes the same wire shorthand `sort=` does (`-field` for descending). `defaults.select` fields must be on `allowed.selectable`; `defaults.include` relations must be on `allowed.includable`. See [Sorting](/querying/sorting), [Field selection](/querying/field-selection), [Relations](/features/relations).

## arrayMutation

| Key                      | Type                                     | Default                     |
| ------------------------ | ---------------------------------------- | --------------------------- |
| `arrayMutation`          | `{ strategy } \| false`                  | `{}`                        |
| `arrayMutation.strategy` | `"replace" \| "resource" \| "jsonPatch"` | unset (no built-in default) |

`"replace"`, `"jsonPatch"`, and `"resource"` are all implemented. `arrayMutation.strategy` is the entity-wide default a `relations.edges.<name>.write: true` relation inherits. A relation opted in with no strategy resolvable anywhere (no entity default and no `write: { strategy }` of its own) requires one be declared explicitly (issue #221). `arrayMutation: false` disables the feature wholesale and wins over any per-relation override (issue #223). See [Relations#arrayMutation](/features/relations#arraymutation).

## cache

| Key          | Type                        | Default |
| ------------ | --------------------------- | ------- |
| `cache`      | `{ ttl?, etag } \| false`   | `false` |
| `cache.ttl`  | `number \| false`, optional | omitted |
| `cache.etag` | `boolean`                   | `true`  |

One subtree covers both halves of HTTP response caching. `cache.ttl` is the engine-level result cache that serves a repeated `findOne`/`findMany` read from a store without touching the adapter — a positive `ttl` turns it on, an omitted `ttl` (the default) means off, and there is no separate `enabled` key. `ttl: 0` fails bootstrap validation; `ttl: false` overrides an _inherited_ `ttl` back off without disabling `etag` at that scope. `cache.etag` is the conditional-request machinery — the ETag on single-item responses plus `If-None-Match`/`If-Match`. `cache: false` turns both halves off together. The result cache's backing store is a live object registered on `KavoOptions.cacheStore`, not a settings key (ADR-0023, ADR-0031). See [Caching & ETags](/features/caching-and-etags) and [Result cache](/features/result-cache).

## softDelete

| Key                   | Type                           | Default                      |
| --------------------- | ------------------------------ | ---------------------------- |
| `softDelete`          | `{ field, strategy } \| false` | resolved per entity (`auto`) |
| `softDelete.field`    | `string`                       | `"deletedAt"`                |
| `softDelete.strategy` | `"auto" \| "soft" \| "hard"`   | `"auto"`                     |

See [Soft delete](/features/soft-delete).

## realtime

| Key                           | Type                                        | Default |
| ----------------------------- | ------------------------------------------- | ------- |
| `realtime`                    | `{ events?, ... } \| false`                 | `false` |
| `realtime.events`             | `Partial<Record<RealtimeEventId, boolean>>` | unset   |
| `realtime.subscribableFields` | `string[] \| { exclude: string[] }`         | unset   |
| `realtime.onPublishError`     | `(error, transport, event) => void`         | unset   |

See [Realtime events](/features/realtime-events).

## operations (global scope only)

| Key                                | Type      | Default                                      |
| ---------------------------------- | --------- | -------------------------------------------- |
| `operations.<standardOperationId>` | `boolean` | see [CRUD operations](/core/crud-operations) |

Coarser than the per-entity `EntityConfig.operations`, which also carries `handler`/`meta` and always wins over this global map. See [Guides/Configuration/Settings §operations](/guides/configuration/settings#operations-global-scope-only).

## allowed (entity scope only)

Not part of `KavoSettings`. Declared on `EntityConfig` directly, so there's no global default and no per-operation override.

| Key                  | Type                                                                                      | Default                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowed.filterable` | `FieldPath[] \| { exclude: FieldPath[] }`                                                 | every own column                                                                                                                                                          |
| `allowed.sortable`   | same shape                                                                                | every own column                                                                                                                                                          |
| `allowed.selectable` | `FieldPath<Entity,1>[] \| { exclude: FieldPath<Entity,1>[] }` (plus computed-field names) | every own column + computed fields; depth 1 — a relation-dotted entry neither type-checks nor boots ([ADR-0045](/internals/adr/0045-relation-projection-ceiling-removed)) |
| `allowed.includable` | `IncludePath[] \| { exclude: IncludePath[] }`                                             | `[]`, no relation includable                                                                                                                                              |
| `allowed.searchable` | `FieldPath[] \| { exclude: FieldPath[] }`                                                 | every own string-kind column                                                                                                                                              |

See [Allowed](/features/allowed).

## create / update (entity scope only)

Not part of `KavoSettings` either, and not nested under `allowed` — the write-side allowlists get their own top-level config objects, since they gate what `createOne`/`updateOne`/`patchOne` may write rather than what a request may filter/sort/select/include.

| Key             | Type                                                           | Default                                                            |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `create.fields` | `FieldPath<Entity,1>[] \| { exclude: FieldPath<Entity,1>[] }` | every non-generated own column except the id, plus every relation  |
| `update.fields` | same shape                                                       | same default as `create.fields`                                   |

See [Allowed](/features/allowed).

## dto / computed / operations (entity scope)

`dto`, `computed`, and the per-entity form of `operations` aren't settings either. They're structural `EntityConfig` fields resolved once at `createCrud`/`@Kavo`. See [DTOs](/core/dtos), [Computed fields](/features/computed-fields#computed), and [CRUD operations](/core/crud-operations).
