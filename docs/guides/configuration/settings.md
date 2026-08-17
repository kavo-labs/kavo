# Settings

`KavoSettings` uses the same schema at every scope (global `defaults`, entity, operation, per-call). Scopes just merge in precedence order. See [Configuration](/guides/configuration/) for how the scopes combine.

## pagination

`defaultLimit` (default `20`) is the page size when a request supplies no `limit`. `maxLimit` (default `100`) is a hard ceiling on `limit`: a request asking for more is clamped, not rejected.

`strategy` (default `"offset"`) picks which pagination strategy computes the page: `"offset"`, `"page"`, `"cursor"`, `"since"`, `"none"`, or a registered name (see `paginationStrategies` in [Module setup](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync) for adding your own).

- `offset` is flat `limit`/`offset`.
- `page` is `page[number]`/`page[size]`.
- `cursor` is keyset paging over an opaque `?cursor=` token. It requires the effective sort to end in the entity's id field, with every sort key on `allowlists.filterable` and `allowlists.selectable` as well as `sortable`. It reports the next token as `meta.nextCursor`.
- `since` is polling by a plain, compound `?since=<value>|<id>` token against `since.field`. The sort is forced to `[since.field, id]`, delivery is exactly once (the id half breaks ties on `since.field`), and the next token is reported as `meta.nextSince`.
- `none` opts the entity out of pagination entirely. `findMany` always serves the whole match set, `defaultLimit`/`maxLimit` go unused, and a client-sent `limit`/`offset` is rejected as an unsupported param rather than silently ignored. See [No pagination](/querying/pagination#no-pagination) for the caveats.

Pair either keyset strategy with `count: false`, and index the sort tuple. The GraphQL and MCP bindings refuse both, since they can't page a keyset (see [Cursor and since pagination](/querying/pagination#cursor-keyset-pagination), [ADR-0021](/internals/adr/0021-cursor-pagination-is-an-opaque-keyset-union), and [ADR-0022](/internals/adr/0022-since-pagination-composes-a-value-id-keyset)).

`since.field` (default `"updatedAt"`) is the column `?since=` seeks against, and is only consulted under `strategy: "since"`. It must be a `date`- or `string`-kind column on `allowlists.filterable` and `allowlists.selectable`. Kavo checks this at startup, so a missing or wrong-kind column fails immediately rather than on the first request.

`count` (default `true`) controls whether list responses compute `total`, which costs an extra `COUNT` query per list call. Set it to `false` alongside `strategy: "cursor"`/`"since"`: the `COUNT` is `O(n)` over the whole match set and dominates the `O(limit)` keyset page it accompanies.

## query

`maxFilterDepth` (default `3`) is the max nesting depth of the `filter` AST (`and`/`or` groups nested inside each other). `maxInValues` (default `100`) is the max array length for `in`, `notIn`, and `between` filter operators.

`defaultSort` (default `[]`) is the sort order applied when a request supplies no `sort` of its own. A client-supplied `sort` always wins outright; it never merges with this. It's validated against the sortable allowlist, same as a client-supplied sort.

`search.enabled` (default `false`) controls whether `search[query]` is accepted at all. It's a `400` until turned on, even though `allowlists.searchable` itself defaults to every own string column. See [Search](/querying/search). `search.mode` (default `"substring"`, or `"words"`) is the default `search[mode]` when a request doesn't override it per call. `search.driver` (default `"orm"`) is a reserved discriminator for a future pluggable search backend; it's the only value accepted today, and it's config-only (there is no `search[driver]` wire token).

## errors

`exposeInternals` (default `false`) controls whether driver-level error details (raw SQL error messages, stack info) leak into problem-details responses. Keep it `false` in production.

## relations

Moved to [Relations](/features/relations), which also covers `arrayMutation`.

## arrayMutation

See [Relations](/features/relations#arraymutation).

## caching

`etag` (default `true`) controls whether single-item responses carry an `ETag`, and whether `If-None-Match` (→ `304`) and `If-Match` (→ `412`) are honored. It's one key for both halves.

Setting `etag` to `false` at any scope turns both halves off together: no tag is computed, and `If-None-Match` is ignored. `If-Match` is the exception. It is refused with `412 KAVO_PRECONDITION_UNSUPPORTED` rather than ignored, because answering `2xx` would tell a client its write was guarded when nothing checked it. The per-operation scope makes that easy to hit by accident, for example `operations: { findOne: { caching: { etag: true } }, updateOne: { caching: { etag: false } } }` would serve tags on `GET` and drop the header on `PUT`.

See [ETags and conditional requests](/features/caching-and-etags#etags-and-conditional-requests) for the wire behavior, including its limits: the `If-Match` check is check-then-write rather than an atomic compare-and-swap, and a token has to come from an unnarrowed read. For redaction and `@Override` details, see [ETag overrides and redaction](/guides/configuration/etag-overrides).

## cache

`ttl` (default `60`, in seconds) is how long a cached `findOne`/`findMany` response is served without touching the adapter. `enabled` (default `false`) switches the feature on, with one exception that makes it less fussy than it looks: the **presence** of a `cache` object that doesn't spell `enabled` opts that scope in, so `@Kavo(User, { cache: { ttl: 60 } })` and `defaults: { cache: { ttl: 60 } }` enable without a redundant `enabled: true`. An override that does say `enabled: false` is honored as written (that's the escape hatch for "set a ttl everywhere, enable only where told"), and `false` for the whole `cache` key disables the feature wholesale.

A hit is keyed by entity, operation, target row, and query, and any successful write on the entity drops its every entry. The backing store is not configured here: it's a live object registered on `KavoOptions.cacheStore` (see [Module setup's global config](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync)), with an in-process default that needs nothing.

See [Result cache](/features/result-cache) for the walkthrough.

## softDelete

`field` (default `"deletedAt"`) is the name of the delete-marker column. `strategy` (default `"auto"`, or `"soft"`/`"hard"`) picks how deletion behaves: `auto` resolves per entity (soft if the marker field exists, hard otherwise), while `soft`/`hard` state it outright. Setting `false` for the whole `softDelete` key (instead of an object) disables soft delete entirely, even if a marker field exists.

See [Soft delete](/features/soft-delete) for the practical walkthrough, and [Soft delete, restore & purge](/internals/architecture/11-soft-delete) for the full behavior.

## realtime

Moved to [Realtime events](/features/realtime-events).

## operations (global scope only)

At global scope, `operations` is a flat map of booleans, keyed by standard operation id. This is coarser than the richer per-entity form:

```ts
defaults: {
  operations: { restoreOne: false },
}
```

| Operation id | Enabled by default                                          |
| ------------ | ----------------------------------------------------------- |
| `createOne`  | Yes                                                         |
| `findOne`    | Yes                                                         |
| `findMany`   | Yes                                                         |
| `updateOne`  | Yes                                                         |
| `patchOne`   | Yes                                                         |
| `deleteOne`  | Yes                                                         |
| `restoreOne` | No, unless soft delete is declared on the entity (ADR-0013) |
| `purgeOne`   | No, until named explicitly                                  |

An entity's own `operations.<id>` (see [Operations](/guides/configuration/operations#operations-1)) always wins over this global map.
