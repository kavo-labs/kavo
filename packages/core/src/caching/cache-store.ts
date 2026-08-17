import type { KavoResponse } from "../context/kavo-response.js";

/**
 * A read-result cache: the pluggable backing store for the `cache`
 * settings key (ADR-0031). `@kavo/core` defines only this seam and ships
 * one in-process implementation, {@link createMemoryCacheStore}; a Redis or
 * other shared backend is a caller-registered object implementing the same
 * three methods (ADR-0005: core has zero runtime dependencies, and a cache
 * backend is exactly the kind of dependency that stays out).
 *
 * A store is a **live object**, never a `KavoSettings` key: it is
 * registered on `KavoOptions.cacheStore`, once per `createKavo` root, and
 * reached at runtime through `ResolvedEntityConfig.cacheStore` — the same
 * structural relationship realtime transports have to the settings tree
 * (ADR-0023; ADR-0031 records the decision). This is what keeps the deep
 * frozen settings tree free of anything with internal state.
 *
 * **The engine owns correctness, not the store.** The value handed to
 * `set` is the complete `KavoResponse` envelope, but `get` must be treated
 * as serving the *payload*: the engine recomputes `etag`/`notModified` for
 * the request at hand rather than trusting the stored copy, because those
 * two fields are per-request answers to the request's own
 * `If-None-Match` (ADR-0020), and a cached hit has to serve a correct,
 * current `ETag` even when the entry predates the current call's
 * `caching.etag` scope. A store that serializes its values for a shared
 * backend is therefore free to round-trip the envelope — including dropping
 * `etag`/`notModified` entirely, which the engine re-derives anyway.
 *
 * **Expiry is the store's job.** `set` carries the TTL in seconds resolved
 * from `cache.ttl`; the store decides how to enforce it (the shipped
 * in-memory store drops expired entries lazily on `get`). The engine never
 * reads a clock.
 *
 * **Failures degrade, never fail.** The engine wraps every call in a
 * try/catch and falls back to the full pipeline, so a store that throws —
 * a backend momentarily unreachable — costs a read its cache hit, never
 * the read itself. Core has no ambient logger to report through (ADR-0005).
 */
export interface CacheStore {
  /**
   * The cached `KavoResponse` for one entity's one read, or `null` on a
   * miss. An expired or evicted entry is a miss.
   */
  get(entityName: string, key: string): Promise<KavoResponse | null> | KavoResponse | null;
  /**
   * Store one read's response for `ttlSeconds`. A write that follows
   * (`invalidate`) must drop it: the response is keyed by
   * entity + operation + target id + normalized query — a `findOne`'s id
   * rides on the request, not in the query, so a `findOne(1)` and a
   * `findOne(2)` are different keys — and a write leaves all four
   * untouched, so nothing but an explicit invalidation (or expiry) ever
   * removes it.
   */
  set(entityName: string, key: string, value: KavoResponse, ttlSeconds: number): Promise<void> | void;
  /**
   * Drop every entry for one entity. Called after any successful write on
   * that entity — whole-entity granularity is the v1 invalidation strategy
   * (ADR-0031), because the engine cannot know which of an entity's cached
   * queries a write invalidated and erring on the safe side is the only
   * correct answer. An entity with nothing cached should make this a no-op.
   */
  invalidate(entityName: string): Promise<void> | void;
}

/**
 * The built-in in-process store. Entries are kept per entity (one map per
 * `entityName`), so `invalidate` is a single map delete and a write on an
 * entity that never enabled caching pays for one miss. Expired entries are
 * dropped lazily on `get`; nothing actively sweeps, and nothing needs to
 * — a stale entry is only ever reached through a `get`, which removes it.
 *
 * Sharing is the caller's choice: every `createKavo` root that does not
 * register its own store gets a private instance, and two roots never
 * share entries. An app that wants one process-wide cache hands the same
 * store to every root (e.g. `KavoModule.forRoot({ cacheStore })`).
 */
export function createMemoryCacheStore(): CacheStore {
  const byEntity = new Map<string, Map<string, Entry>>();

  return {
    get(entityName, key) {
      const entries = byEntity.get(entityName);
      if (entries === undefined) return null;
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },

    set(entityName, key, value, ttlSeconds) {
      let entries = byEntity.get(entityName);
      if (entries === undefined) {
        entries = new Map();
        byEntity.set(entityName, entries);
      }
      entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },

    invalidate(entityName) {
      byEntity.delete(entityName);
    },
  };
}

interface Entry {
  readonly value: KavoResponse;
  readonly expiresAt: number;
}
