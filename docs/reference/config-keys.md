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

## query

| Key                    | Type                     | Default       |
| ---------------------- | ------------------------ | ------------- |
| `query.maxFilterDepth` | `number`                 | `3`           |
| `query.maxInValues`    | `number`                 | `100`         |
| `query.defaultSort`    | `Sort[]`                 | `[]`          |
| `query.search`         | `{ mode, driver } \| false` | `false`     |
| `query.search.mode`    | `"substring" \| "words"` | `"substring"` |
| `query.search.driver`  | `"orm"`                  | `"orm"`       |

See [Filtering](/querying/filtering), [Search](/querying/search), [Sorting](/querying/sorting).

## errors

| Key                      | Type      | Default |
| ------------------------ | --------- | ------- |
| `errors.exposeInternals` | `boolean` | `false` |

See [Errors](/reference/errors).

## relations

| Key                                     | Type                          | Default                              |
| --------------------------------------- | ----------------------------- | ------------------------------------ |
| `relations.maxIncludeDepth`             | `number`                      | `2`                                  |
| `relations.maxIncludedNodes`            | `number`                      | `10`                                 |
| `relations.edges.<name>.defaultInclude` | `boolean`                     | `false`                              |
| `relations.edges.<name>.maxDepth`       | `number`                      | inherits `relations.maxIncludeDepth` |
| `relations.edges.<name>.strategy`       | `"auto" \| "join" \| "batch"` | `"auto"`                             |
| `relations.edges.<name>.write`          | `boolean \| { strategy }`     | `false`                              |

Whether a relation is includable at all is `allowlists.includable` (entity scope only); see [Reference/Config keys §allowlists](#allowlists-entity-scope-only). `relations.edges` is loading tuning for a relation that is already includable. `write: true` inherits the entity's own `arrayMutation.strategy`. `write: { strategy }` pins this relation's own strategy instead, independent of the entity default (issue #223). See [Relations](/features/relations).

## arrayMutation

| Key                      | Type                                     | Default                     |
| ------------------------ | ---------------------------------------- | --------------------------- |
| `arrayMutation`          | `{ strategy } \| false`                  | `{}`                        |
| `arrayMutation.strategy` | `"replace" \| "resource" \| "jsonPatch"` | unset (no built-in default) |

`"replace"`, `"jsonPatch"`, and `"resource"` are all implemented. `arrayMutation.strategy` is the entity-wide default a `relations.edges.<name>.write: true` relation inherits. A relation opted in with no strategy resolvable anywhere (no entity default and no `write: { strategy }` of its own) requires one be declared explicitly (issue #221). `arrayMutation: false` disables the feature wholesale and wins over any per-relation override (issue #223). See [Relations#arrayMutation](/features/relations#arraymutation).

## cache

| Key          | Type                     | Default |
| ------------ | ------------------------ | ------- |
| `cache`      | `{ ttl, etag } \| false` | `false` |
| `cache.ttl`  | `number` (seconds)       | `0`     |
| `cache.etag` | `boolean`                | `true`  |

One subtree covers both halves of HTTP response caching. `cache.ttl` is the engine-level result cache that serves a repeated `findOne`/`findMany` read from a store without touching the adapter — a positive `ttl` turns it on, `0` (the default) means off, and there is no separate `enabled` key. `cache.etag` is the conditional-request machinery — the ETag on single-item responses plus `If-None-Match`/`If-Match`. `cache: false` turns both halves off together. The result cache's backing store is a live object registered on `KavoOptions.cacheStore`, not a settings key (ADR-0023, ADR-0031). See [Caching & ETags](/features/caching-and-etags) and [Result cache](/features/result-cache).

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

## allowlists (entity scope only)

Not part of `KavoSettings`. Declared on `EntityConfig` directly, so there's no global default and no per-operation override.

| Key                     | Type                                                          | Default                                                           |
| ----------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `allowlists.filterable` | `FieldPath[] \| { exclude: FieldPath[] }`                     | every own column                                                  |
| `allowlists.sortable`   | same shape                                                    | every own column                                                  |
| `allowlists.selectable` | same shape                                                    | every own column + computed fields                                |
| `allowlists.includable` | `IncludePath[] \| { exclude: IncludePath[] }`                 | `[]`, no relation includable                                      |
| `allowlists.searchable` | `FieldPath[] \| { exclude: FieldPath[] }`                     | every own string-kind column                                      |
| `allowlists.creatable`  | `FieldPath<Entity,1>[] \| { exclude: FieldPath<Entity,1>[] }` | every non-generated own column except the id, plus every relation |
| `allowlists.updatable`  | same shape                                                    | same default as `creatable`                                       |

See [Allowlists](/features/allowlists).

## dto / computed / operations (entity scope)

`dto`, `computed`, and the per-entity form of `operations` aren't settings either. They're structural `EntityConfig` fields resolved once at `createCrud`/`@Kavo`. See [DTOs](/core/dtos), [Computed fields](/features/computed-fields#computed), and [CRUD operations](/core/crud-operations).
