# Result cache

`cache` is a TTL cache of `findOne` and `findMany` responses: a repeated read with the same query is served from a store without touching the adapter, the serializer, or a DTO. The pipeline short-circuits after preconditions. Reads only: write responses are never cached.

Enable it by setting a TTL. A **positive** `ttl` turns it on — `ttl` _is_ the switch, with no separate `enabled` key to spell, so one key is enough:

```ts
@Kavo(User, {
  cache: { ttl: 60 },
})
```

`ttl` is in seconds (default `0`, which is off). `cache: false` disables the whole subtree, the same convention `softDelete` uses. Setting `defaults: { cache: { ttl: 60 } }` on `KavoModule` opts every entity in, and `operations: { findMany: { cache: { ttl: 5 } } }` tunes one operation. The key resolves through the same global → entity → operation → per-call precedence chain as everything else (per-call via `KavoCallOptions.settings`).

## What a hit skips, what it doesn't

A hit answers `findOne`/`findMany` without the adapter, but it still recomputes the current `ETag` off the cached item, so conditional clients keep working: `If-None-Match` on a hit still gets its `304` against a fresh, correct tag. `cache.etag` and the rest of the `cache` key compose; neither disables the other.

Entries are keyed by entity, operation, target row, app context, and query: `fields`, `include`, `filter`, `sort`, `pagination`, `withDeleted`, `onlyDeleted`. `GET /users/1` and `GET /users/2` are different entries, as are `GET /users/1?fields=name` and the plain read. `context.app` is in the key so one caller's values never leak to another — a computed field that varies by `context.app`, or a custom handler that filters on it, is safe by construction; calls that carry no app context share one bucket. Because `context.app` is canonicalized into the key, it must be plain, shallow, JSON-serializable data with no reference cycles whenever the cache is on. A framework/ORM object passed straight through (a Passport user, a TypeORM entity, a class-transformer instance) canonicalizes by its own enumerable keys only — prototype getters are skipped — so it can hash identically for every caller and collapse them onto one bucket; a request object or a logger recurses forever. Per-call settings are deliberately not part of the key: a per-call `softDelete.strategy` override that reshapes a response without changing the query is outside the cache's contract (ADR-0031).

## Invalidation

Any successful write on the entity (`createOne`, `updateOne`, `patchOne`, `deleteOne`, restore/purge, or a custom write) drops that entity's every entry. There is no per-key staleness analysis: the engine cannot know which cached queries a write changed, so it errs on the safe side. A failed write invalidates nothing. The whole-entity sweep is the only invalidation v1 does, so on a write-heavy entity the cache's hit rate is whatever survives between writes.

## The store

`@kavo/core` ships one in-process store, `createMemoryCacheStore()`, which is the default. A store is a live object, registered once per root on `KavoOptions`, never a settings key (the settings tree is deep-frozen; ADR-0023, ADR-0031):

```ts
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  defaults: { cache: { ttl: 60 } },
  cacheStore: myRedisStore, // { get, set, invalidate }
});
```

The interface is three methods, scoped by entity name:

```ts
interface CacheStore {
  get(entityName: string, key: string): Promise<KavoResponse | null> | KavoResponse | null;
  set(entityName: string, key: string, value: KavoResponse, ttlSeconds: number): Promise<void> | void;
  invalidate(entityName: string): Promise<void> | void;
}
```

Every `createKavo` root that doesn't register one gets a private instance. For a process-wide cache, hand the same store to every root; for a shared backend, implement these three methods over it (core has zero runtime dependencies, so a Redis client stays an app dependency).

## Two things to know

**A hit is as stale as the TTL.** The store never asks the adapter, so a row changed by a write on a _different_ entity, or by an out-of-band change nothing invalidated, shows up at the old value until the entry expires. That is what the TTL is for.

**A broken store costs a hit, never a read.** Every store call is wrapped: `get` that throws is a miss, `set` that throws is ignored, `invalidate` that throws is ignored. A backend that goes down degrades to uncached behavior, not errors.

**Two stated limits on the shipped store.** The in-process store checks expiry only on `get` and never sweeps, so on a pure-read workload with a high-cardinality query space, expired entries whose keys are never revisited accumulate — a caller with a long-lived read-mostly process should register a store that evicts. And transactional reads are cached like any other: a `findOne` inside a programmatic transaction stores its response, so a later call outside the transaction (or after a rollback) is served it — account for it, or keep transactional reads off the cache path.

See [Settings](/guides/configuration/settings#cache) for the schema, [Config keys](/reference/config-keys#cache), and [ADR-0031](/internals/adr/0031-result-cache-is-a-live-store-invalidated-wholesale) for the full decision.
