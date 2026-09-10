# Settings

`KavoSettings` uses the same schema at every scope (global `defaults`, entity, operation, per-call). Scopes just merge in precedence order. See [Configuration](/guides/configuration/) for how the scopes combine.

## pagination

`defaultLimit` (default `20`) is the page size when a request supplies no `limit`. `maxLimit` (default `100`) is a hard ceiling on `limit`: a request asking for more is clamped, not rejected.

`strategy` (default `"offset"`) picks which pagination strategy computes the page: `"offset"`, `"page"`, `"cursor"`, `"since"`, `"none"`, or a registered name (see `paginationStrategies` in [Module setup](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync) for adding your own).

- `offset` is flat `limit`/`offset`.
- `page` is `page[number]`/`page[size]`.
- `cursor` is keyset paging over an opaque `?cursor=` token. It requires the effective sort to end in the entity's id field, with every sort key on `filter.fields` and `select.fields` as well as `sort.fields`. It reports the next token as `meta.nextCursor`.
- `since` is polling by a plain, compound `?since=<value>|<id>` token against `since.field`. The sort is forced to `[since.field, id]`, delivery is exactly once (the id half breaks ties on `since.field`), and the next token is reported as `meta.nextSince`.
- `none` opts the entity out of pagination entirely. `findMany` always serves the whole match set, `defaultLimit`/`maxLimit` go unused, and a client-sent `limit`/`offset` is rejected as an unsupported param rather than silently ignored. See [No pagination](/querying/pagination#no-pagination) for the caveats.

Pair either keyset strategy with `count: false`, and index the sort tuple. The GraphQL and MCP bindings refuse both, since they can't page a keyset (see [Cursor and since pagination](/querying/pagination#cursor-keyset-pagination), [ADR-0021](/internals/adr/0021-cursor-pagination-is-an-opaque-keyset-union), and [ADR-0022](/internals/adr/0022-since-pagination-composes-a-value-id-keyset)).

`since.field` (default `"updatedAt"`) is the column `?since=` seeks against, and is only consulted under `strategy: "since"`. It must be a `date`- or `string`-kind column on `filter.fields` and `select.fields`. Kavo checks this at startup, so a missing or wrong-kind column fails immediately rather than on the first request.

`count` (default `true`) controls whether list responses compute `total`, which costs an extra `COUNT` query per list call. Set it to `false` alongside `strategy: "cursor"`/`"since"`: the `COUNT` is `O(n)` over the whole match set and dominates the `O(limit)` keyset page it accompanies.

## limits

Not a `KavoSettings` key. The per-request cost ceilings live on the axis they bound: `filter.limits.{maxDepth,maxInValues,maxLikePatternLength}` and `include.limits.{maxDepth,maxNodes}` on `EntityConfig` (entity scope only) since issue #386 — see [Entity config](/guides/configuration/entity-config) and [Config keys](/reference/config-keys#filter).

## search

Not a `KavoSettings` key. `search` is an `EntityConfig` block (`fields`, `default`, `mode`, `driver`, or `false`) since issue #386 — see [Search](/querying/search) and [Entity config](/guides/configuration/entity-config).

## errors

`exposeInternals` (default `false`) controls whether driver-level error details (raw SQL error messages, stack info) leak into problem-details responses. Keep it `false` in production.

## defaults

Not a `KavoSettings` key. What a request looks like when the client sends nothing lives on the axis it defaults: `sort.default`, `select.default`, `filter.default`, `search.default`, and `include.default` on `EntityConfig` (entity scope only) since issue #386. Each applies only when the request omits that axis; a client-supplied value replaces it outright, never merges. See [Entity config](/guides/configuration/entity-config) and [Config keys](/reference/config-keys#sort).

## relations

Not a `KavoSettings` key. Per-relation read tuning and the array-mutation
write strategy live on `EntityConfig.relations` (entity scope only) since
issue #404 — see [Relations](/features/relations).

## cache

One subtree covers both halves of HTTP response caching: the result cache and the conditional-request machinery. `etag` (default `true`) controls whether single-item responses carry an `ETag`, and whether `If-None-Match` (→ `304`) and `If-Match` (→ `412`) are honored — one key for both halves, accepting `true`/`false` or `{ enabled }`. `ttl` (optional, in seconds) is the result cache: a **positive** `ttl` turns it on (how long a cached `findOne`/`findMany` response is served without touching the adapter), while an _omitted_ `ttl` (the default) means off. There is no separate `enabled` key — `ttl`'s presence **is** the switch, so `@Kavo(User, { cache: { ttl: 60 } })` and `defaults: { cache: { ttl: 60 } }` enable without any redundant flag, and `false` for the whole `cache` key turns both halves off together. `ttl: 0` fails bootstrap validation rather than meaning off — it is not a valid value.

The two halves are independent by default: `etag` stays on even when the result cache is off. That also makes the natural spelling for etag-only changes safe — `cache: { etag: false }` turns the conditional machinery off and leaves the result cache off too (no `ttl` present), with no presence rule to accidentally flip it on.

To turn off a `ttl` a broader scope turned on, without also turning off `etag` at the narrower scope (which `cache: false` would), set `ttl: false`: `defaults: { cache: { ttl: 60 } }` then `@Kavo(User, { cache: { ttl: false } })` leaves `User` with no result cache but `etag` still on. It is the one explicit "override off" spelling, since `mergeSettings` replaces keys the override supplies rather than clearing them on `undefined`.

Setting `etag` to `false` at any scope turns both conditional halves off together: no tag is computed, and `If-None-Match` is ignored. `If-Match` is the exception. It is refused with `412 KAVO_PRECONDITION_UNSUPPORTED` rather than ignored, because answering `2xx` would tell a client its write was guarded when nothing checked it. The per-operation scope makes that easy to hit by accident, for example `operations: { findOne: { cache: { etag: true } }, updateOne: { cache: { etag: false } } }` would serve tags on `GET` and drop the header on `PUT`.

A result-cache hit is keyed by entity, operation, target row, app context, and query, and any successful write on the entity drops its every entry. The backing store is not configured here: it's a live object registered on `KavoOptions.cacheStore` (see [Module setup's global config](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync)), with an in-process default that needs nothing.

See [ETags and conditional requests](/features/caching-and-etags#etags-and-conditional-requests) for the wire behavior, including its limits: the `If-Match` check is check-then-write rather than an atomic compare-and-swap, and a token has to come from an unnarrowed read. For redaction and `@Override` details, see [ETag overrides and redaction](/guides/configuration/etag-overrides). For the result-cache walkthrough, see [Result cache](/features/result-cache).

## delete

`field` (default `"deletedAt"`) is the name of the delete-marker column. `strategy` (default `"auto"`, or `"soft"`/`"hard"`) picks how deletion behaves: `auto` resolves per entity (soft if the marker field exists, hard otherwise), while `soft`/`hard` state it outright. Setting `false` for the whole `delete` key (instead of an object) disables soft delete entirely, even if a marker field exists.

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
