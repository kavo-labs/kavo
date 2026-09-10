# Config keys

Every key `createKavo`, `@Kavo`, and `createCrud` accept, with its type, default, and where it's consulted. [Guides/Configuration](/guides/configuration/) covers the same schema as task-based prose ("how do I configure X"). This page is the exhaustive lookup form for when you already know the key and want its type and default.

Two groups of keys sit under `@Kavo(Entity, config)` / `createCrud(Entity, config)`. The first is `KavoSettings` — merged through the [precedence chain](/guides/configuration/) (built-in defaults → global `KavoModule` → entity `@Kavo` → `operations.<id>` → per-call), each scope overriding the one before it for the fields it sets. The second is structural `EntityConfig` — `dto`, `policy`, the per-axis `filter`/`sort`/`select`/`search`/`include` blocks, `relations`, `create`/`update`, and the per-entity `operations` map — resolved once at bootstrap, entity scope only, never merged through that chain and with no global default.

## KavoSettings

### pagination

| Key                       | Type                                                            | Default       |
| ------------------------- | --------------------------------------------------------------- | ------------- |
| `pagination.defaultLimit` | `number`                                                        | `20`          |
| `pagination.maxLimit`     | `number`                                                        | `100`         |
| `pagination.strategy`     | `"offset" \| "page" \| "cursor" \| "since" \| "none" \| string` | `"offset"`    |
| `pagination.count`        | `boolean`                                                       | `true`        |
| `pagination.since.field`  | `string`                                                        | `"updatedAt"` |

`strategy: "none"` (ADR-0030) opts the entity out of pagination — `findMany` serves the whole match set, `defaultLimit`/`maxLimit` go unused, and a client-sent `limit`/`offset` is rejected rather than ignored. `pagination.since.field` is consulted only under `strategy: "since"` (ADR-0022), where a missing column is a bootstrap error. See [Pagination](/querying/pagination) and [Settings](/guides/configuration/settings#pagination).

### errors

| Key                      | Type      | Default |
| ------------------------ | --------- | ------- |
| `errors.exposeInternals` | `boolean` | `false` |

Leaks driver-level error detail (a `PersistenceException`'s `cause`, adapter-mapped detail) into responses. See [Errors](/reference/errors).

### cache

| Key          | Type                        | Default |
| ------------ | --------------------------- | ------- |
| `cache`      | `{ ttl?, etag } \| false`   | `false` |
| `cache.ttl`  | `number \| false`, optional | omitted |
| `cache.etag` | `boolean`                   | `true`  |

One subtree covers both halves of HTTP response caching. `cache.ttl` is the engine-level result cache that serves a repeated `findOne`/`findMany` read from a store without touching the adapter — a positive `ttl` (in seconds) turns it on, an omitted `ttl` (the default) means off, and there is no separate `enabled` key. `ttl: 0` fails bootstrap validation; `ttl: false` overrides an _inherited_ `ttl` back off without disabling `etag` at that scope. `cache.etag` is the conditional-request machinery — the `ETag` on single-item responses plus `If-None-Match`/`If-Match`. `cache: false` turns both halves off together. The backing store is a live object registered on `KavoOptions.cacheStore`, not a settings key (ADR-0023, ADR-0031). See [Caching & ETags](/features/caching-and-etags) and [Result cache](/features/result-cache).

### delete

| Key               | Type                           | Default                      |
| ----------------- | ------------------------------ | ---------------------------- |
| `delete`          | `{ field, strategy } \| false` | resolved per entity (`auto`) |
| `delete.field`    | `string`                       | `"deletedAt"`                |
| `delete.strategy` | `"auto" \| "soft" \| "hard"`   | `"auto"`                     |

`auto` resolves per entity: soft when the entity carries the marker field, hard otherwise. `soft` on an entity without a marker field fails at bootstrap. `false` at any scope disables soft delete entirely. See [Soft delete](/features/soft-delete).

### realtime

| Key                           | Type                                        | Default |
| ----------------------------- | ------------------------------------------- | ------- |
| `realtime`                    | `{ events?, ... } \| false`                 | `false` |
| `realtime.events`             | `Partial<Record<RealtimeEventId, boolean>>` | unset   |
| `realtime.subscribableFields` | `string[] \| { exclude: string[] }`         | unset   |
| `realtime.onPublishError`     | `(error, transport, event) => void`         | unset   |

`false` (the default) disables the subtree; any object enables it and every event emits unless an id is dialed back to `false` in `events`. Registered transports are a live object on `KavoOptions.realtimeTransports`, not a settings key (ADR-0023). See [Realtime events](/features/realtime-events).

### identifier

| Key                | Type                 | Default                          |
| ------------------ | -------------------- | -------------------------------- |
| `identifier`       | `{ field } \| unset` | unset (`EntityMetadata.idField`) |
| `identifier.field` | `string`             | —                                |

Global → entity scope only — never per-operation, never per-call. Retargets the `…One` route param and `EntityReader.findOneById` to a scalar column other than the primary key (`GET /users/:username` instead of `GET /users/:id`); the sort tiebreaker, cursor/since keyset, realtime ids, immutable-key stripping on writes, and association-by-id all stay on the real primary key. Rejected at bootstrap on a composite-key entity, an unknown/relation/derived field name, a field whose kind isn't `string`/`number`, or an adapter that doesn't implement `RepositoryAdapter.supportsIdentifierField` — all four ORM adapters do. Kavo does not verify the field is actually unique. See ADR-0052.

### operations

| Key                                | Type      | Default                                      |
| ---------------------------------- | --------- | -------------------------------------------- |
| `operations.<standardOperationId>` | `boolean` | see [CRUD operations](/core/crud-operations) |

Global scope only — a boolean map keyed by the standard operation ids. Coarser than the per-entity `EntityConfig.operations` (below), which also carries `handler`/`meta`/`dto`/`policy` and always wins over this map. See [Guides/Configuration/Settings §operations](/guides/configuration/settings#operations-global-scope-only).

## EntityConfig — structural, entity scope only

Not `KavoSettings`. Declared on `EntityConfig` directly, so there is no global default and no per-operation or per-call override; each is resolved once at `createCrud`/`@Kavo`.

### filter

| Key                                  | Type                                                                            | Default          |
| ------------------------------------ | ------------------------------------------------------------------------------- | ---------------- |
| `filter.fields`                      | `FieldPath[] \| { exclude: FieldPath[] } \| { <field>: FilterOperatorToken[] }` | every own column |
| `filter.default`                     | `FilterExpression<Entity>`                                                      | unset            |
| `filter.apply`                       | `(args) => FilterExpression \| undefined`                                       | unset            |
| `filter.limits.maxDepth`             | `number`                                                                        | `3`              |
| `filter.limits.maxInValues`          | `number`                                                                        | `100`            |
| `filter.limits.maxLikePatternLength` | `number`                                                                        | `200`            |

`fields` in the map form (`{ field: ["eq", "in"] }`) restricts which operators are permitted per named field; a field named there is implicitly on the allowlist, and one absent from a map permits every operator. `default` is the predicate applied when a request supplies no `filter=` — a client `filter=` wins outright, never merges. `apply` (ADR-0048) is `AND`ed into every read and into the id lookup of every single-row write, and the client can only narrow further inside that `AND`. `limits` are per-request cost ceilings (issue #386, formerly `KavoSettings.limits.{filterDepth,inValues,likePattern}`). See [Filtering](/querying/filtering).

### sort

| Key            | Type                                           | Default          |
| -------------- | ---------------------------------------------- | ---------------- |
| `sort.fields`  | `FieldPath[] \| { exclude: FieldPath[] }`      | every own column |
| `sort.default` | `(-FieldPath \| FieldPath)[]` (wire shorthand) | `[]`             |
| `sort.apply`   | `(args) => sort keys \| undefined`             | unset            |

`default` takes the same wire shorthand `sort=` does (`-field` for descending) and is used only when the request sends no `sort=`. `apply` (ADR-0048) prepends forced keys ahead of the client's own sort, deduplicating a client field already named. Fields are validated against `fields` at bootstrap. See [Sorting](/querying/sorting).

### select

| Key              | Type                                                          | Default                        |
| ---------------- | ------------------------------------------------------------- | ------------------------------ |
| `select.fields`  | `FieldPath<Entity,1>[] \| { exclude: FieldPath<Entity,1>[] }` | every own column               |
| `select.default` | `FieldPath<Entity,1>[]`                                       | unset — every selectable field |
| `select.apply`   | `(args) => fields \| undefined`                               | unset                          |

`fields` is depth 1 — `select=` addresses the entity's own columns, and an included relation is projected through `select[<relation>]=` against the target's own `select.fields` (ADR-0045); a relation-dotted entry neither type-checks nor boots. `fields` also closes the response body: a column left off is not served, which is what makes it a confidentiality control and not just a validation list (ADR-0026). A registered `dto.item`/`dto.list` with a runtime shape **replaces** the projection and wins even where wider. `default` is the projection for a request that sends no `select=`, validated against `fields` at bootstrap. `apply` (ADR-0048) is additive only, never a mask. See [Field selection](/querying/field-selection).

### search

| Key              | Type                                                               | Default                      |
| ---------------- | ------------------------------------------------------------------ | ---------------------------- |
| `search`         | `{ fields?, default?, mode?, driver? } \| false`                   | `false`                      |
| `search.fields`  | `FieldPath[] \| { exclude: FieldPath[] }` (relation paths allowed) | every own string-kind column |
| `search.default` | `string`                                                           | unset                        |
| `search.mode`    | `"substring" \| "words"`                                           | `"substring"`                |
| `search.driver`  | `"orm"`                                                            | `"orm"`                      |

`false` (the default) disables search — `search[query]` is rejected with a 400 until an entity or operation scope sets an object. Unlike `filter.fields`/`sort.fields`, `search.fields` entries may be relation paths (`"brand.name"`) — a search box spreads one term across whatever fields make sense. `default` is the term used when a request sends no `search[query]`. See [Search](/querying/search).

### include

| Key                       | Type                                                              | Default                   |
| ------------------------- | ----------------------------------------------------------------- | ------------------------- |
| `include.fields`          | `IncludePath<Entity,1>[] \| { exclude: IncludePath<Entity,1>[] }` | `[]` — nothing includable |
| `include.default`         | `IncludePath<Entity,1>[]`                                         | `[]`                      |
| `include.apply`           | `(args) => relation paths \| undefined`                           | unset                     |
| `include.limits.maxDepth` | `number`                                                          | `2`                       |
| `include.limits.maxNodes` | `number`                                                          | `10`                      |

`fields` is **opt-in**, unlike every other axis: unconfigured means no relation is includable (the posture `relations.edges` had before ADR-0028). `{ exclude: [] }`, written explicitly, means the opposite — every relation includable. `default` relations are included even when `include=` doesn't name them, and each must also be on `fields` (ADR-0028's cross-check). `apply` (ADR-0048) force-includes paths on every request, still subject to the depth/breadth limits and the `fields` allowlist. `include.limits.maxDepth` is overridable per-subtree by `relations.<name>.read.maxDepth`, below. See [Relations](/features/relations).

### relations

| Key                               | Type                                     | Default                            |
| --------------------------------- | ---------------------------------------- | ---------------------------------- |
| `relations.<name>.read.maxDepth`  | `number`                                 | inherits `include.limits.maxDepth` |
| `relations.<name>.read.strategy`  | `"auto" \| "join" \| "batch" \| "key"`   | `"auto"`                           |
| `relations.<name>.write.strategy` | `"replace" \| "resource" \| "jsonPatch"` | — (relation is not array-mutable)  |

Keyed by the entity's own top-level relation names, resolved directly at bootstrap, never merged and with no global default (issue #404, folding the former `KavoSettings.relations.edges` and `KavoSettings.arrayMutation` into one block). An entry that tunes nothing (`{}`) is a bootstrap error.

`read` tunes how an already-includable relation loads — whether a relation is includable at all is `include.fields` (ADR-0028), which includable relations load by default is `include.default`, neither of which lives here. `read.strategy: "key"` is owning-side to-one only (a to-many or an inverse `@OneToOne` has no local FK — bootstrap error): it materializes the edge as `{ <pk>: value }` read from the parent row's own foreign-key column, no join, `null` when the FK is null.

`write.strategy` opts a to-many relation into array-mutation writes and names the strategy in one statement — there is no entity-level default and no boolean form; omitting `write` is how a relation stays non-array-mutable. `"replace"` (whole-array `PUT :id/<relation>`), `"jsonPatch"` (`PATCH /entity/:id` with an RFC 6902 array body), and `"resource"` (four per-relation sub-collection routes — `GET`/`POST`/`DELETE`/`PUT` `:id/<relation>`) are all implemented (ADR-0029). `write` on a to-one relation is a bootstrap error — association by id already covers those (ADR-0014). Write **permission** for a relation is the `create`/`update` field lists and registered write DTOs, not this key. See [Relations](/features/relations).

### create / update

| Key              | Type                                                          | Default                                                           |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `create.fields`  | `FieldPath<Entity,1>[] \| { exclude: FieldPath<Entity,1>[] }` | every non-generated own column except the id, plus every relation |
| `create.default` | `Partial<EntityInput<Entity>>`                                | unset                                                             |
| `create.apply`   | `(args) => Partial<EntityInput<Entity>> \| undefined`         | unset                                                             |
| `update.fields`  | same shape as `create.fields`                                 | same default as `create.fields`                                   |
| `update.default` | `Partial<EntityInput<Entity>>`                                | unset                                                             |
| `update.apply`   | same shape as `create.apply`                                  | unset                                                             |

Their own top-level objects rather than nested under a shared `allowed` block (issue #388), since they gate what `createOne`/`updateOne`/`patchOne` may **write** rather than what a request may read. `update` is shared by `updateOne` (PUT) and `patchOne` (PATCH) — both overwrite an existing row, so the writable set is the same question either way. A registered `dto.create`/`dto.update` class with a runtime shape **replaces** this projection and wins over `fields`.

`default` fills in a value for a writable field the body doesn't set — a body that does send the field wins outright (the same one-way relationship a client value has with `sort.default`). `default` is `createOne`- and `updateOne`-only, never `patchOne`: a PATCH that omits a field means "leave it unchanged". `apply` (issue #391, ADR-0048's write-side sibling) is the opposite composition rule — it forces field values into a `createOne`/`updateOne` body, overwriting whatever the client sent. See [Allowed](/features/allowed).

### policy

| Key      | Type             | Default |
| -------- | ---------------- | ------- |
| `policy` | `Policy<Entity>` | unset   |

A single entity-default authorization function (ADR-0037), not a per-operation map. Resolved by its own "nearest scope wins" walk: falls back to `GlobalConfig.policy` (`createKavo({ policy })`), overridden per operation by `operations.<id>.policy`, including `operations.<id>.policy: false` to opt one operation out. No per-call override. Absent every scope, the operation runs unrestricted. See [CRUD operations](/core/crud-operations).

### dto / operations (entity scope)

| Key                       | Type                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `dto.create`              | DTO class                                                                                       |
| `dto.update`              | DTO class                                                                                       |
| `dto.patch`               | DTO class \| `{ fields: FieldPath<Entity,1>[] }`                                                |
| `dto.query`               | DTO class                                                                                       |
| `dto.item`                | DTO class \| `{ fields: FieldPath<Entity,1>[] }`                                                |
| `dto.list`                | DTO class \| `{ fields: FieldPath<Entity,1>[] }`                                                |
| `operations.<standardId>` | `boolean \| { handler?, meta?, dto?, policy?, + narrowed settings }`                            |
| `operations.<customId>`   | `{ handler?, kind?, cardinality?, dto?, enabled?, realtimeEvent?, meta?, + narrowed settings }` |

`dto.create`/`dto.update` accept a registered class only — their writable-field list is the top-level `create`/`update` keys above (issue #388). `patch`/`item`/`list` additionally accept the inline `{ fields }` shorthand (issue #386). A per-`operations.<id>` entry carries only the `KavoSettings` keys that operation's engine stages read (`pagination` on `findMany` alone, `realtime` on the writes, `delete` on the reads and the delete family, `cache`/`errors` on all — issue #415); naming any other is a compile error. A custom id (anything outside the standard eight) declares a custom operation: `kind` defaults to `"write"`, `cardinality` to `"one"`, and `realtimeEvent` names which of the five `RealtimeEventId`s a `kind: "write"`, `cardinality: "one"` operation publishes. See [DTOs](/core/dtos) and [CRUD operations](/core/crud-operations).
