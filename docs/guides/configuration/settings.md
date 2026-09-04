# Settings

`KavoSettings` uses the same schema at every scope (global `defaults`, entity, operation, per-call). Scopes just merge in precedence order. See [Configuration](/guides/configuration/) for how the scopes combine.

## pagination

`defaultLimit` (default `20`) is the page size when a request supplies no `limit`. `maxLimit` (default `100`) is a hard ceiling on `limit`: a request asking for more is clamped, not rejected.

`strategy` (default `"offset"`) picks which pagination strategy computes the page: `"offset"`, `"page"`, `"cursor"`, `"since"`, `"none"`, or a registered name (see `paginationStrategies` in [Module setup](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync) for adding your own).

- `offset` is flat `limit`/`offset`.
- `page` is `page[number]`/`page[size]`.
- `cursor` is keyset paging over an opaque `?cursor=` token. It requires the effective sort to end in the entity's id field, with every sort key on `allowed.filterable` and `allowed.selectable` as well as `sortable`. It reports the next token as `meta.nextCursor`.
- `since` is polling by a plain, compound `?since=<value>|<id>` token against `since.field`. The sort is forced to `[since.field, id]`, delivery is exactly once (the id half breaks ties on `since.field`), and the next token is reported as `meta.nextSince`.
- `none` opts the entity out of pagination entirely. `findMany` always serves the whole match set, `defaultLimit`/`maxLimit` go unused, and a client-sent `limit`/`offset` is rejected as an unsupported param rather than silently ignored. See [No pagination](/querying/pagination#no-pagination) for the caveats.

Pair either keyset strategy with `count: false`, and index the sort tuple. The GraphQL and MCP bindings refuse both, since they can't page a keyset (see [Cursor and since pagination](/querying/pagination#cursor-keyset-pagination), [ADR-0021](/internals/adr/0021-cursor-pagination-is-an-opaque-keyset-union), and [ADR-0022](/internals/adr/0022-since-pagination-composes-a-value-id-keyset)).

`since.field` (default `"updatedAt"`) is the column `?since=` seeks against, and is only consulted under `strategy: "since"`. It must be a `date`- or `string`-kind column on `allowed.filterable` and `allowed.selectable`. Kavo checks this at startup, so a missing or wrong-kind column fails immediately rather than on the first request.

`count` (default `true`) controls whether list responses compute `total`, which costs an extra `COUNT` query per list call. Set it to `false` alongside `strategy: "cursor"`/`"since"`: the `COUNT` is `O(n)` over the whole match set and dominates the `O(limit)` keyset page it accompanies.

## limits

`filterDepth` (default `3`) is the max nesting depth of the `filter` AST (`and`/`or` groups nested inside each other). `inValues` (default `100`) is the max array length for `in`, `notIn`, and `between` filter operators. `likePattern` (default `200`) is the max character length of a `like`/`ilike` pattern. `includeDepth` (default `2`) is the max relation-include nesting depth — overridable per-subtree by `relations.edges.<name>.maxDepth` (see [Relations](/features/relations)). `includedNodes` (default `10`) is the max total number of included relation nodes across the whole include tree.

## search

`search` (default `false`) controls whether `search[query]` is accepted at all. It's a `400` until a scope sets it to an object (`{}` uses the defaults), even though `allowed.searchable` itself defaults to every own string column; set it back to `false` at a narrower scope to disable it there. See [Search](/querying/search). `search.mode` (default `"substring"`, or `"words"`) is the default `search[mode]` when a request doesn't override it per call. `search.driver` (default `"orm"`) is a reserved discriminator for a future pluggable search backend; it's the only value accepted today, and it's config-only (there is no `search[driver]` wire token). A narrower scope re-enabling search from `false` may name only the keys it changes — the rest backfill from these defaults.

## errors

`exposeInternals` (default `false`) controls whether driver-level error details (raw SQL error messages, stack info) leak into problem-details responses. Keep it `false` in production.

## defaults

What a request looks like when the client specifies nothing — the omission-side counterpart to `allowed` (see [Entity config](/guides/configuration/entity-config)). Applied only when the request omits that axis; a client-supplied value replaces it outright, never merges.

`sort` (default `[]`) is the sort order applied when a request supplies no `sort` of its own, in the same wire shorthand `sort=` accepts (`-field` for descending, comma-separated conceptually but declared as an array — `["​-createdAt", "id"]`). A client-supplied `sort` always wins outright; it never merges with this. It's validated against the sortable allowlist, same as a client-supplied sort. `pagination.strategy: "since"` (ADR-0022) still forces its own sort when active, overriding this.

`select` (default unset) is the default response projection: what a read serves when the request sends no `select=` of its own. Unset, behavior is unchanged — every selectable field is projected. Configured, its fields must be on `allowed.selectable`.

`include` (default `[]`) is the list of relations included even when the client's `include=` doesn't name them. Each entry must also be on `allowed.includable` — naming a relation here that clients cannot ask for is a bootstrap error. See [Relations](/features/relations).

## relations

Moved to [Relations](/features/relations), which also covers `arrayMutation`.

## arrayMutation

See [Relations](/features/relations#arraymutation).

## cache

One subtree covers both halves of HTTP response caching: the result cache and the conditional-request machinery. `etag` (default `true`) controls whether single-item responses carry an `ETag`, and whether `If-None-Match` (→ `304`) and `If-Match` (→ `412`) are honored — one key for both halves, accepting `true`/`false` or `{ enabled }`. `ttl` (default `0`, in seconds) is the result cache: a **positive** `ttl` turns it on (how long a cached `findOne`/`findMany` response is served without touching the adapter), while `0` (the default) means off. There is no separate `enabled` key — `ttl` **is** the switch, so `@Kavo(User, { cache: { ttl: 60 } })` and `defaults: { cache: { ttl: 60 } }` enable without any redundant flag, and `false` for the whole `cache` key turns both halves off together.

The two halves are independent by default: `etag` stays on even when the result cache is off. That also makes the natural spelling for etag-only changes safe — `cache: { etag: false }` turns the conditional machinery off and leaves the result cache off too (its `ttl` is still `0`), with no presence rule to accidentally flip it on.

Setting `etag` to `false` at any scope turns both conditional halves off together: no tag is computed, and `If-None-Match` is ignored. `If-Match` is the exception. It is refused with `412 KAVO_PRECONDITION_UNSUPPORTED` rather than ignored, because answering `2xx` would tell a client its write was guarded when nothing checked it. The per-operation scope makes that easy to hit by accident, for example `operations: { findOne: { cache: { etag: true } }, updateOne: { cache: { etag: false } } }` would serve tags on `GET` and drop the header on `PUT`.

A result-cache hit is keyed by entity, operation, target row, app context, and query, and any successful write on the entity drops its every entry. The backing store is not configured here: it's a live object registered on `KavoOptions.cacheStore` (see [Module setup's global config](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync)), with an in-process default that needs nothing.

See [ETags and conditional requests](/features/caching-and-etags#etags-and-conditional-requests) for the wire behavior, including its limits: the `If-Match` check is check-then-write rather than an atomic compare-and-swap, and a token has to come from an unnarrowed read. For redaction and `@Override` details, see [ETag overrides and redaction](/guides/configuration/etag-overrides). For the result-cache walkthrough, see [Result cache](/features/result-cache).

## softDelete

`field` (default `"deletedAt"`) is the name of the delete-marker column. `strategy` (default `"auto"`, or `"soft"`/`"hard"`) picks how deletion behaves: `auto` resolves per entity (soft if the marker field exists, hard otherwise), while `soft`/`hard` state it outright. Setting `false` for the whole `softDelete` key (instead of an object) disables soft delete entirely, even if a marker field exists.

See [Soft delete](/features/soft-delete) for the practical walkthrough, and [Soft delete, restore & purge](/internals/architecture/11-soft-delete) for the full behavior.

## realtime

Moved to [Realtime events](/features/realtime-events).

## authorization

`required` (default `false`) makes a standard operation with no configured `policy.<id>` entry deny with `403 KAVO_FORBIDDEN` instead of running unrestricted, and also gates a Kavo-synthesized array-mutation operation (`replace<Relation>` etc.), which can never carry a `policy.<id>` entry of its own. Unlike `policy` itself, this key has a global scope and merges through the ordinary precedence chain — but per-call is excluded: a per-call override can neither loosen nor tighten it. See [Policy](/features/policy#default-deny-authorization-required) and [ADR-0035](/internals/adr/0035-authorization-required-default-deny-switch).

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
