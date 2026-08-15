# Settings

The app-wide `KavoSettings` shape — the same schema at every scope (global `defaults`, entity, operation, per-call), just merged in precedence order. See [Configuration](/guides/configuration/) for how the scopes combine.

## pagination

`defaultLimit` (default `20`) is the page size when a request supplies no `limit`. `maxLimit` (default `100`) is a hard ceiling on `limit` — a request asking for more is clamped, not rejected.

`strategy` (default `"offset"`) picks which pagination strategy computes the page — `"offset"`, `"page"`, `"cursor"`, `"since"`, `"none"`, or a registered name (see `paginationStrategies` in [Module setup](/guides/configuration/module-setup#global-config-kavomodule-forroot-forrootasync) for adding your own):

- `offset` is flat `limit`/`offset`.
- `page` is `page[number]`/`page[size]`.
- `cursor` is keyset paging over an opaque `?cursor=` token, which requires the effective sort to end in the entity's id field — with every sort key on `allowlists.filterable` and `allowlists.selectable` as well as `sortable` — and reports the next token as `meta.nextCursor`.
- `since` is polling by a plain, compound `?since=<value>|<id>` token against `since.field`, with the sort forced to `[since.field, id]`, exactly-once delivery (the id half breaks ties on `since.field`), and the next token reported as `meta.nextSince`.
- `none` opts the entity out of pagination altogether: `findMany` always serves the whole match set, `defaultLimit`/`maxLimit` go unused, and a client-sent `limit`/`offset` is rejected as an unsupported param rather than silently ignored. See [No pagination](/querying/pagination#no-pagination) for the caveats.

Pair either keyset strategy with `count: false`, and index the sort tuple; both are refused by the GraphQL and MCP bindings, which cannot page a keyset (see [Cursor pagination](/querying/pagination#cursor-keyset-pagination), [Since pagination](/querying/pagination#since-seek-by-timestamp-pagination), [ADR-0021](/internals/adr/0021-cursor-pagination-is-an-opaque-keyset-union), and [ADR-0022](/internals/adr/0022-since-pagination-composes-a-value-id-keyset)).

`since.field` (default `"updatedAt"`) is only consulted under `strategy: "since"`: the column `?since=` seeks against. It must be a `date`- or `string`-kind column on `allowlists.filterable` and `allowlists.selectable`, checked at startup — a missing or wrong-kind column fails immediately rather than on the first request.

`count` (default `true`) controls whether list responses compute `total` (an extra `COUNT` query per list call). Set it to `false` alongside `strategy: "cursor"`/`"since"`: the `COUNT` is `O(n)` over the whole match set and dominates the `O(limit)` keyset page it accompanies.

## query

`maxFilterDepth` (default `3`) is the max nesting depth of the `filter` AST (`and`/`or` groups nested inside each other). `maxInValues` (default `100`) is the max array length for `in`, `notIn`, and `between` filter operators.

`defaultSort` (default `[]`) is the sort order applied when a request supplies no `sort` of its own. A client-supplied `sort` always wins outright — it never merges with this. It's validated against the sortable allowlist, same as client-supplied sort.

`search.enabled` (default `false`) controls whether `search[query]` is accepted at all — a 400 until turned on, even though `allowlists.searchable` itself defaults to every own string column. See [Search](/querying/search). `search.mode` (default `"substring"`, or `"words"`) is the default `search[mode]` when a request doesn't override it per call. `search.driver` (default `"orm"`) is a reserved discriminator for a future pluggable search backend — the only value accepted today; it's config-only, there is no `search[driver]` wire token.

## errors

`exposeInternals` (default `false`) controls whether driver-level error details (raw SQL error messages, stack info) leak into problem-details responses. Keep it `false` in production.

## relations

Moved to [Relations](/features/relations), which also covers `arrayMutation`.

## arrayMutation

See [Relations](/features/relations#arraymutation).

## caching

`etag` (default `true`) controls whether single-item responses carry an `ETag`, and whether `If-None-Match` (→ `304`) and `If-Match` (→ `412`) are honored — one key, both halves.

`false` at any scope turns both halves off together — no tag is computed and `If-None-Match` is ignored. `If-Match` is the exception: it is **refused** with `412 KAVO_PRECONDITION_UNSUPPORTED`, not ignored. Answering `2xx` would tell a client its write was guarded when nothing checked it, and the per-operation scope makes that easy to arrive at by accident (`operations: { findOne: { caching: { etag: true } }, updateOne: { caching: { etag: false } } }` would serve tags on `GET` and drop the header on `PUT`).

See [ETags and conditional requests](/features/caching-and-etags#etags-and-conditional-requests) for the wire behavior, including the explicit limits: the `If-Match` check is check-then-write rather than an atomic compare-and-swap, and a token has to come from an unnarrowed read.

**Redaction belongs in the DTO, not in an interceptor.** Kavo's `KavoResponseInterceptor` is method-scoped and therefore innermost: it sets the `ETag` before any controller- or app-level interceptor runs. An outer interceptor that strips fields per role would ship a hash of the _unredacted_ representation next to a redacted body — and a client's `If-Match` built from it would never match. Shape the response with a per-operation `item` DTO, which the engine serializes through before hashing.

**An `@Override`'d method gets the `ETag` for free, and enforces `If-Match` only if it forwards it.** The split is worth reading carefully, because the two halves come from different places ([ADR-0027](/internals/adr/0027-an-override-inherits-the-etag-but-not-the-precondition)):

- **The tag is automatic.** An override on a single-item operation can return the typed service's item — `this.base.patchOne(id, body, { principal })` — and `@Kavo` hashes it into the same strong `ETag` a generated route would serve. Nothing to opt into.
- **The precondition is not.** `If-Match` is evaluated inside the engine, against a canonical read, so it only runs if the method passes its `preconditions` parameter on: either as `{ preconditions }` on the typed service, or by returning `service.engine.execute({ …, preconditions })`.

Before v0.9 the tag was not automatic, and the host framework filled in its own weak one instead. That is the failure worth recognizing if you are on an older version: reads carried an `ETag`, `If-None-Match` answered `304`, and the tag changed with the body — everything except the `412` that protects data, so a route could look fully conditional while every guarded write was a silent lost update. Assert the tag's **shape** (`/^"[0-9a-f]{64}"$/`), not its presence.

One limit survives. The engine compares `If-Match` against what `findOne` would serve for that id, so an override serving a **reshaped** representation hands out a tag the check can never match, and every conditional write answers `412`. Serve the canonical shape, or set `caching: { etag: false }` for that operation and own the concurrency control yourself.

## softDelete

`field` (default `"deletedAt"`) is the name of the delete-marker column. `strategy` (default `"auto"`, or `"soft"`/`"hard"`) picks how deletion behaves: `auto` resolves per entity (soft if the marker field exists, hard otherwise); `soft`/`hard` state it outright. `false` for the whole `softDelete` key (instead of an object) disables soft delete entirely, even if a marker field exists.

See [Soft delete](/features/soft-delete) for the practical walkthrough, and [Soft delete, restore & purge](/internals/architecture/11-soft-delete) for the full behavior.

## realtime

Moved to [Realtime events](/features/realtime-events).

## operations (global scope only)

At global scope, `operations` is a flat map of booleans, keyed by standard operation id — coarser than the richer per-entity form:

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
