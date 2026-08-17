# ADR-0031 — The result cache is a live per-entity store, invalidated wholesale on writes

**Status:** accepted

## Context

`findOne`/`findMany` had no result caching (issue #232): every repeated read
ran the full pipeline — normalize, resolve DTOs, call the adapter, serialize
— even when the same row and the same query had already produced an
identical response moments earlier. The existing `caching.etag` key
(ADR-0020) is conditional-request machinery: it computes a tag and answers
`If-None-Match`/`If-Match`, but a client that does not send the header still
pays for the adapter read every time. A TTL cache is a different feature
that short-circuits before the adapter at all, and it needed a home in the
config precedence chain.

Two design questions dominated. First, where does the **backing store**
live? `cache.ttl` is plain data and belongs in `KavoSettings` like any other
key; a store is a live object (a Redis client, a shared in-memory map) and
cannot. `deepFreeze` recurses into everything reachable from the settings
tree and freezes it, which silently breaks a live object's internal state —
the exact failure ADR-0023 already documents for realtime transports. The
precedent was settled: live objects resolve on `KavoOptions`, once per
`createKavo` root, and ride on `ResolvedEntityConfig` beside `settings`, the
same structural relationship `dto`/`computed`/`relations`/`realtimeTransports`
have.

Second, what is the **cache key**? The entity name is the obvious container.
The normalized query is almost the natural discriminator — but `findOne`'s
target id does not live in the normalized query. `request.id` rides
alongside it, coerced to the id column's kind by `resolveInput` before the
handler runs, and a key built from the query alone would make `findOne(1)`
and `findOne(2)` share one entry — a correctness bug of the worst kind,
because a cache hit serves the stale row without ever asking the adapter.
The key had to compose the id in explicitly. The query half is not safe to
stringify raw either: the include tree carries live `RelationDescriptor`
objects (`IncludeNode.relation`) that a serialization pass must not touch.

A third question was invalidation granularity. A write that touches one row
invalidates an unknown subset of the entity's cached queries — `findOne(2)`
definitely, but also every `findMany` whose filter matched the changed row,
and any `findOne` whose include pulls in a changed relation. Computing which
entries a write invalidated is a staleness analysis the engine has no data
for. The only correct granularity is the entity: drop them all.

## Decision

**1. `cache` is a new `KavoSettings` key; the store is not.**
`cache: { enabled, ttl }` (TTL in seconds) merges through the normal
precedence chain and is `false`-disables-the-subtree like `softDelete`
(`settings.ts`, `defaults.ts` — built-in default `{ enabled: false,
ttl: 60 }`). The backing store is a `CacheStore` interface (`get(entityName,
key)`, `set(entityName, key, value, ttlSeconds)`, `invalidate(entityName)`),
registered on `KavoOptions.cacheStore` with `createMemoryCacheStore()` as the
default, validated once in `createKavo`, and reached at runtime through
`ResolvedEntityConfig.cacheStore` — ADR-0023 applied to caching
(`cache-store.ts`, `kavo.ts`). Core defines only the seam and ships the one
in-process store; a Redis or other shared backend is a caller-registered
object, keeping core at zero runtime dependencies (ADR-0005).

**2. The key is entity + operation + target id + canonicalized query
fingerprint.** The entity name is a separate parameter the store keys on,
so invalidation stays a whole-entity map delete. The in-key parts are
`${operationId}:${requestId}:${canonicalize(queryFingerprint(query))}`
(`kavo-engine.ts` `cacheKey`). `requestId` is empty on a `findMany`, where
there is no target row. `queryFingerprint` is a plain-data projection of the
normalized query — `filter`, `sort`, `pagination`, `fields`, `include`,
`withDeleted`, `onlyDeleted`, `count` — folding each include node down to
its query-decided parts, `fields` and `children` (the relation paths are the
keys), because `canonicalize` must never serialize a live
`RelationDescriptor`. Per-call _settings_ are deliberately not in the key:
a per-call override that reshapes a response without changing the query —
the one known case is `softDelete.strategy` — is outside the key's
contract, stated as a documented limitation rather than silently answered
wrong.

**3. Presence of a `cache` override implies `enabled: true`.** `mergeSettings`
treats `cache` specially: a plain-object override that does not spell
`enabled` forces it on, so `@Kavo(Entity, { cache: { ttl: 60 } })` and a
global `defaults: { cache: { ttl: 60 } }` enable without a redundant
`enabled: true`. An override that does say `enabled: false` — or the
wholesale `cache: false` — is honored as written, the escape hatch for "set
a ttl everywhere, enable only where told." Without the rule, every
enablement would require spelling two keys at every scope, and a partial
override (`{ ttl: 60 }`) would silently merge `enabled: false` from the
built-in default and appear to do nothing.

**4. Only the two standard reads are cached; every successful write
invalidates the entity wholesale.** `isCacheableRead` accepts `findOne` and
`findMany` only — custom-operation reads are never cached, however cheap
their handler — and reads only: write responses are never stored. The
lookup runs after preconditions (`checkIfMatch`), so a failed `If-Match` on
a write never becomes a stale cache read, and before the handler, so a hit
never touches the adapter. After any successful write — standard or custom —
`invalidate(entityName)` drops the entity's every entry (`invalidateCache`),
because nothing about the write's payload tells the engine which cached
queries it could have changed.

**5. A hit serves a fresh envelope: current ETag, cloned payload.**
`etag` and `notModified` are per-request answers to the request's own
`If-None-Match` (ADR-0020), so `responseFromCache` recomputes the tag off
the cached `item` — the same representation `mapResponse` would have hashed
— and never trusts the stored copy; a hit therefore serves a correct,
current `ETag` even when `caching.etag` was off at the scope that produced
the entry. The payload is `structuredClone`d (through the same typed
`WebGlobals` accessor `etag.ts` uses for Web Crypto): an entry is shared
storage, so one caller mutating a returned item must not corrupt what every
later caller reads.

**6. Cache failures degrade, never fail.** Every store call is wrapped in a
`try/catch` that falls back to the full pipeline — a store that throws, a
miss, an expired or evicted entry, and a store that cannot evict all resolve
to the same outcome the feature would have had anyway. A broken cache backend
costs a read its hit and a write its invalidation, never the read or the
write itself. Core has no ambient logger to report through (ADR-0005).

## Consequences

- **A cache hit bypasses the adapter entirely** — no read, no include fan-out,
  no serializer — which is the whole point for a hot, slow-ORM read; the
  price is that the hit is as stale as the entry's TTL, and no write
  analysis can make it fresher. Adopters who need lower staleness trade a
  shorter TTL or a custom store that evicts more aggressively.
- **Whole-entity invalidation is O(1) by construction** in the shipped
  store (one map delete per entity) but coarse: a write on any one row
  discards the entity's every cached query, including queries the write did
  not change. That is a hit-rate cost, not a correctness one.
- **The entity name and the id are key parts the store contract already
  carries**, which keeps invalidation a container delete and keeps a
  `findOne` from colliding with its sibling row — the two most likely
  mistakes for a future third-party store to get wrong are ruled out by the
  interface itself.
- **Two entities that share a store never share entries**, because every
  call is scoped by `entityName`. Two `createKavo` roots each get a private
  default store; an app that wants one process-wide cache hands the same
  instance to every root (`KavoModule.forRoot({ cacheStore })`).
- **`caching` and `cache` compose instead of fighting**: the ETag machinery
  still runs on a hit (cheaply, off the cached item), so conditional
  clients and cached clients see consistent answers; ADR-0027's
  override-inherits-the-etag rule is untouched.
- **The documented staleness gap is per-call settings**: a per-call
  `softDelete.strategy` override that changes what the response would be
  without changing the query is outside the key. It is a stated limitation,
  not a silent wrong answer.
