# Config keys

The complete `KavoSettings` field-by-field table — every key, its type, its default, and where it's consulted. [Guides/Configuration](/guides/configuration/) covers the same schema as task-based prose ("how do I configure X"); this page is the exhaustive lookup form for when you already know the key and want its type and default.

Every key below is set the same way at every scope of the [precedence chain](/guides/configuration/) — built-in defaults → global (`KavoModule`) → entity (`@Kavo` config) → operation (`operations.<id>`) → per-call — each scope overriding the one before it for the fields it sets.

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
| `query.search.enabled` | `boolean`                | `false`       |
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
| `relations.edges.<name>.write`          | `boolean`                     | `false`                              |

Whether a relation is includable at all is `allowlists.includable` (entity scope only) — see [Reference/Config keys §allowlists](#allowlists-entity-scope-only). `relations.edges` is loading tuning for a relation that is already includable. See [Relations](/features/relations).

## arrayMutation

| Key                      | Type                                     | Default                   |
| ------------------------ | ---------------------------------------- | ------------------------- |
| `arrayMutation`          | `{ strategy } \| false`                  | `{ strategy: "replace" }` |
| `arrayMutation.strategy` | `"replace" \| "resource" \| "jsonPatch"` | `"replace"`               |

Only `"replace"` is implemented; `"resource"`/`"jsonPatch"` are reserved and rejected at bootstrap. See [Relations#arrayMutation](/features/relations#arraymutation).

## caching

| Key            | Type      | Default |
| -------------- | --------- | ------- |
| `caching.etag` | `boolean` | `true`  |

See [Caching & ETags](/features/caching-and-etags).

## softDelete

| Key                   | Type                           | Default                      |
| --------------------- | ------------------------------ | ---------------------------- |
| `softDelete`          | `{ field, strategy } \| false` | resolved per entity (`auto`) |
| `softDelete.field`    | `string`                       | `"deletedAt"`                |
| `softDelete.strategy` | `"auto" \| "soft" \| "hard"`   | `"auto"`                     |

See [Soft delete](/features/soft-delete).

## realtime

| Key                           | Type                                        | Default              |
| ----------------------------- | ------------------------------------------- | -------------------- |
| `realtime`                    | `{ enabled, events?, ... } \| false`        | `{ enabled: false }` |
| `realtime.enabled`            | `boolean`                                   | `false`              |
| `realtime.events`             | `Partial<Record<RealtimeEventId, boolean>>` | `{}`                 |
| `realtime.subscribableFields` | `string[] \| { exclude: string[] }`         | unset                |
| `realtime.onPublishError`     | `(error, transport, event) => void`         | unset                |

See [Realtime events](/features/realtime-events).

## operations (global scope only)

| Key                                | Type      | Default                                      |
| ---------------------------------- | --------- | -------------------------------------------- |
| `operations.<standardOperationId>` | `boolean` | see [CRUD operations](/core/crud-operations) |

Coarser than the per-entity `EntityConfig.operations`, which also carries `handler`/`meta` and always wins over this global map. See [Guides/Configuration/Settings §operations](/guides/configuration/settings#operations-global-scope-only).

## allowlists (entity scope only)

Not part of `KavoSettings` — declared on `EntityConfig` directly, so there's no global default and no per-operation override.

| Key                     | Type                                          | Default                            |
| ----------------------- | --------------------------------------------- | ---------------------------------- |
| `allowlists.filterable` | `FieldPath[] \| { exclude: FieldPath[] }`     | every own column                   |
| `allowlists.sortable`   | same shape                                    | every own column                   |
| `allowlists.selectable` | same shape                                    | every own column + computed fields |
| `allowlists.includable` | `IncludePath[] \| { exclude: IncludePath[] }` | `[]` — no relation includable      |
| `allowlists.searchable` | `FieldPath[] \| { exclude: FieldPath[] }`     | every own string-kind column       |

See [Allowlists & computed fields](/features/allowlists-and-computed-fields#allowlists).

## dto / computed / operations (entity scope)

`dto`, `computed`, and the per-entity form of `operations` aren't settings either — they're structural `EntityConfig` fields resolved once at `createCrud`/`@Kavo`. See [DTOs](/core/dtos), [Allowlists & computed fields](/features/allowlists-and-computed-fields#computed), and [CRUD operations](/core/crud-operations).
