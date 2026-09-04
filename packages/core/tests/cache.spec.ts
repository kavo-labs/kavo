import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CacheStore,
  EntityId,
  EntityMetadata,
  KavoAppContext,
  KavoRequest,
  KavoResponse,
  NormalizedQueryContext,
  RepositoryAdapter,
} from "@kavo/core";
import { ConfigurationException, createKavo, createMemoryCacheStore } from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";

type EntityConfigArg = Parameters<ReturnType<typeof createKavo>["createCrud"]>[1];

/**
 * Counts every adapter read a hit must skip — `findOneById` (findOne),
 * `findMany` and `count` (findMany) — so a test can prove a repeated read
 * never touched persistence. The `If-Match` pre-read also goes through
 * `findOneById`, so the same counter doubles as the check that cache
 * lookup stays out of the precondition path's way (ADR-0031).
 */
class CountingReadsAdapter implements RepositoryAdapter<User> {
  reads = 0;

  constructor(private readonly inner: InMemoryUserAdapter = new InMemoryUserAdapter()) {}

  get rows(): User[] {
    return this.inner.rows;
  }

  async findOneById(id: EntityId) {
    this.reads++;
    return this.inner.findOneById(id);
  }
  async findOne(query: NormalizedQueryContext<User>) {
    return this.inner.findOne(query);
  }
  async findMany(query: NormalizedQueryContext<User>) {
    this.reads++;
    return this.inner.findMany(query);
  }
  async count(query: NormalizedQueryContext<User>) {
    this.reads++;
    return this.inner.count(query);
  }
  async create(data: Partial<User>) {
    return this.inner.create(data);
  }
  async update(id: EntityId, data: Partial<User>) {
    return this.inner.update(id, data);
  }
  async patch(id: EntityId, data: Partial<User>) {
    return this.inner.patch(id, data);
  }
  async delete(id: EntityId) {
    return this.inner.delete(id);
  }
  async restore() {
    return this.inner.restore();
  }
  async purge(id: EntityId) {
    return this.inner.purge(id);
  }
}

const ADA = { name: "Ada", email: "ada@example.com", age: 36, status: "active" } as const;

function makeCrud(config?: EntityConfigArg, store?: CacheStore, defaults?: Parameters<typeof createKavo>[0]) {
  const adapter = new CountingReadsAdapter();
  const crud = createKavo({ ...defaults, cacheStore: store }).createCrud(User, config as never, {
    adapter,
    metadata: userMetadata,
  });
  return { crud, adapter };
}

/** The engine envelope, which the typed service surface unwraps away. */
function execute(
  crud: ReturnType<typeof makeCrud>["crud"],
  request: Partial<KavoRequest<User>> & { operation: string },
) {
  return crud.engine.execute({ id: null, body: null, query: null, options: null, ...request } as never);
}

describe("cache settings resolution", () => {
  it("'cache: { ttl: … }' at entity scope turns the result cache on", async () => {
    const store = createMemoryCacheStore();
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, store);
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    const hit = await execute(crud, { operation: "findOne", id: 1 });
    expect(hit.item).toMatchObject({ name: "Ada" });
    expect(adapter.reads).toBe(readsAfterMiss);
  });

  it("an etag-only override does not turn the result cache on", async () => {
    const store = createMemoryCacheStore();
    const { crud, adapter } = makeCrud({ cache: { etag: false } } as never, store);
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsAfterMiss + 1);
  });

  it("'cache: false' disables wholesale", async () => {
    const store = createMemoryCacheStore();
    const { crud, adapter } = makeCrud({ cache: false } as never, store);
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsAfterMiss + 1);
  });

  it("a global 'defaults: { cache: { ttl: … } }' opts every entity in", async () => {
    const store = createMemoryCacheStore();
    const { crud, adapter } = makeCrud(undefined, store, { defaults: { cache: { ttl: 30 } } });
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsAfterMiss);
  });

  it("applies at operation scope: an operation that opts in is cached, its sibling is not", async () => {
    const store = createMemoryCacheStore();
    const { crud, adapter } = makeCrud(
      { operations: { createOne: true, findMany: true, findOne: { enabled: true, cache: { ttl: 30 } } } } as never,
      store,
    );
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findMany" });
    const readsAfterMiss = adapter.reads;

    // findOne is cached (operation scope opted in)…
    await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterOne = adapter.reads;
    expect(readsAfterOne).toBe(readsAfterMiss + 1);

    // …findMany is not (its operation scope never said so).
    await execute(crud, { operation: "findMany" });
    expect(adapter.reads).toBe(readsAfterOne + 2); // findMany + count
  });

  it("applies at per-call scope, and a call that does not opt in is not served from the cache", async () => {
    const store = createMemoryCacheStore();
    const { crud, adapter } = makeCrud(undefined, store);
    const cachedCall = { settings: { cache: { ttl: 30 } } };
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1, options: cachedCall });
    const readsAfterMiss = adapter.reads;

    // The same per-call override again: served from the cache.
    await execute(crud, { operation: "findOne", id: 1, options: cachedCall });
    expect(adapter.reads).toBe(readsAfterMiss);

    // No override: not cacheable, hits the adapter even though an entry exists.
    await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsAfterMiss + 1);
  });

  it("per-call 'cache: false' turns an entity-scoped cache off for that one call", async () => {
    const store = createMemoryCacheStore();
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, store);
    const off = { settings: { cache: false } } as const;
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    await execute(crud, { operation: "findOne", id: 1, options: off });
    expect(adapter.reads).toBe(readsAfterMiss + 1);

    // The entity's own scope still caches: a plain call is a hit again.
    await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsAfterMiss + 1);
  });

  it("keys by app context: one caller's response never serves a different caller", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1, options: { app: { id: 1 } as KavoAppContext } });
    const readsAfterMiss = adapter.reads;

    // A different app context with the same query misses: no cross-caller leak.
    await execute(crud, { operation: "findOne", id: 1, options: { app: { id: 2 } as KavoAppContext } });
    expect(adapter.reads).toBe(readsAfterMiss + 1);

    // The same app context hits.
    await execute(crud, { operation: "findOne", id: 1, options: { app: { id: 1 } as KavoAppContext } });
    expect(adapter.reads).toBe(readsAfterMiss + 1);

    // Calls with no app context share one bucket and miss against an
    // entry keyed by a populated context.
    await execute(crud, { operation: "findOne", id: 1 });
    await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsAfterMiss + 2);
  });

  it("keys on the normalized app context, so `{ app: {} }` and no options share one bucket", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });

    // Warm with an explicit empty app context.
    await execute(crud, { operation: "findOne", id: 1, options: { app: {} as KavoAppContext } });
    const readsAfterMiss = adapter.reads;

    // A call with no options at all hits it — the engine normalizes a
    // missing app context to the same `{}` the key is built from, so this
    // would break if the key were built from `request.options?.app` instead
    // of `context.app`.
    await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsAfterMiss);
  });

  it("rejects a malformed 'cache' override at bootstrap, naming the key", () => {
    expect(() => makeCrud({ cache: { ttl: -1 } } as never)).toThrowError(ConfigurationException);
    expect(() => makeCrud({ cache: { ttl: 1.5 } } as never)).toThrowError(ConfigurationException);
    expect(() => makeCrud({ cache: true } as never)).toThrowError(ConfigurationException);
  });

  it("'cache: { ttl: 0 }' no longer validates — omit 'ttl' or use 'ttl: false'", () => {
    expect(() => makeCrud({ cache: { ttl: 0 } } as never)).toThrowError(ConfigurationException);
  });

  it("'cache: { ttl: false }' overrides an inherited ttl back off without disabling etag", async () => {
    const store = createMemoryCacheStore();
    const { crud, adapter } = makeCrud({ cache: { ttl: false } } as never, store, {
      defaults: { cache: { ttl: 60 } },
    });
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    // The entity-scoped `ttl: false` overrode the inherited global ttl: no hit.
    const second = await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsAfterMiss + 1);
    // ETags still serve — only the result cache was turned off.
    expect(second.etag).not.toBeNull();
  });

  it("rejects a malformed cache store at createKavo, once", () => {
    expect(() => createKavo({ cacheStore: {} as never })).toThrowError(ConfigurationException);
    expect(() => createKavo({ cacheStore: { get: 1 } as never })).toThrowError(ConfigurationException);
    expect(() => createKavo({ cacheStore: { get: () => null } as never })).toThrowError(ConfigurationException);
  });

  it("rejects a cache store that is not an object — a scalar is never a store", () => {
    for (const store of [42, "store"]) {
      expect(() => createKavo({ cacheStore: store as never })).toThrowError(ConfigurationException);
    }
  });

  it("a null cache store is treated as unset, falling back to the in-memory default", () => {
    expect(() => createKavo({ cacheStore: null as never })).not.toThrow();
  });
});

describe("findOne caching", () => {
  it("serves a repeated read from the cache without touching the adapter", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    const first = await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    const second = await execute(crud, { operation: "findOne", id: 1 });
    expect(second.item).toEqual(first.item);
    expect(adapter.reads).toBe(readsAfterMiss);
  });

  it("keys per id: one row's entry is never served for another", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "createOne", body: { ...ADA, name: "Grace" } });
    await execute(crud, { operation: "findOne", id: 1 });
    await execute(crud, { operation: "findOne", id: 2 });
    const readsAfterMisses = adapter.reads;

    const one = await execute(crud, { operation: "findOne", id: 1 });
    const two = await execute(crud, { operation: "findOne", id: 2 });
    expect(one.item).toMatchObject({ id: 1, name: "Ada" });
    expect(two.item).toMatchObject({ id: 2, name: "Grace" });
    expect(adapter.reads).toBe(readsAfterMisses);
  });

  it("keys per representation: a fields-narrowed read is a different entry", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1 });
    await execute(crud, { operation: "findOne", id: 1, query: { select: ["name"] } });
    const readsAfterMisses = adapter.reads;

    const narrowed = await execute(crud, { operation: "findOne", id: 1, query: { select: ["name"] } });
    expect(narrowed.item).toEqual({ name: "Ada" });
    expect(adapter.reads).toBe(readsAfterMisses);
  });

  it("keys per include=, like the ETag does", async () => {
    // Two reads with the same id and no query params differ only in the
    // include tree — if that were not part of the key, the include read
    // would be served the include-less body (or vice versa).
    const reads = { count: 0 };
    const inner = new SeededAdapter<Post>([
      Object.assign(new Post(), { id: 1, title: "First", authorId: 7, author: Object.assign(new Author(), { id: 7 }) }),
    ]);
    const postAdapter = {
      ...inner,
      findOneById: async (id: EntityId) => {
        reads.count++;
        return inner.findOneById(id, null);
      },
    } as unknown as RepositoryAdapter<Post>;
    const metadata = new Map<unknown, EntityMetadata<object>>([
      [Post, postMetadata as EntityMetadata<object>],
      [Author, authorMetadata as EntityMetadata<object>],
    ]);
    const adapters = new Map<unknown, unknown>([
      [Post, postAdapter],
      [Author, new SeededAdapter<Author>([])],
    ]);
    const kavo = createKavo({
      infrastructure: {
        metadataFor: (entity) => metadata.get(entity) as never,
        adapterFor: (entity) => adapters.get(entity) as never,
      },
      cacheStore: createMemoryCacheStore(),
    });
    const posts = kavo.createCrud(Post, {
      allowed: { includable: ["author"] },
      cache: { ttl: 60 },
    } as never);
    kavo.createCrud(Author);

    const plain = await posts.engine.execute({
      operation: "findOne",
      id: 1,
      body: null,
      query: null,
      options: null,
    } as never);
    const embedded = await posts.engine.execute({
      operation: "findOne",
      id: 1,
      body: null,
      query: { include: ["author"] },
      options: null,
    } as never);
    expect(embedded.item).toMatchObject({ author: { id: 7 } });
    const readsAfterMisses = reads.count;

    const embeddedAgain = await posts.engine.execute({
      operation: "findOne",
      id: 1,
      body: null,
      query: { include: ["author"] },
      options: null,
    } as never);
    expect(embeddedAgain.item).toMatchObject({ author: { id: 7 } });
    expect(reads.count).toBe(readsAfterMisses);
    expect(plain.item).not.toMatchObject({ author: expect.anything() });
  });

  it("a hit serves a fresh payload: mutating a returned item corrupts nothing", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1 });
    const hit = await execute(crud, { operation: "findOne", id: 1 });

    (hit.item as Record<string, unknown>).name = "Corrupted";

    const third = await execute(crud, { operation: "findOne", id: 1 });
    expect(third.item).toMatchObject({ name: "Ada" });
    expect(adapter.reads).toBe(1); // one miss, then hits — never a third adapter read
  });

  it("the miss that populates the cache is itself cloned: the originating caller cannot corrupt it", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    const first = await execute(crud, { operation: "findOne", id: 1 });

    (first.item as Record<string, unknown>).name = "Corrupted";

    const second = await execute(crud, { operation: "findOne", id: 1 });
    expect(second.item).toMatchObject({ name: "Ada" });
    expect(adapter.reads).toBe(1); // the corruption stayed on the caller's copy, not in the store
  });
});

describe("findMany caching", () => {
  it("serves a repeated list from the cache, count query included", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    const first = await execute(crud, { operation: "findMany" });
    const readsAfterMiss = adapter.reads;

    const second = await execute(crud, { operation: "findMany" });
    expect(second.list).toEqual(first.list);
    expect(adapter.reads).toBe(readsAfterMiss);
  });

  it("keys per query: two pages are two entries", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "createOne", body: { ...ADA, name: "Grace", age: 1 } });
    await execute(crud, { operation: "findMany" });
    await execute(crud, { operation: "findMany", query: { limit: 1 } });
    const readsAfterMisses = adapter.reads;

    const page = await execute(crud, { operation: "findMany", query: { limit: 1 } });
    expect(page.list?.items).toHaveLength(1);
    expect(adapter.reads).toBe(readsAfterMisses);
  });
});

describe("invalidation on writes", () => {
  async function primed(store?: CacheStore) {
    const made = makeCrud({ cache: { ttl: 60 } } as never, store);
    await execute(made.crud, { operation: "createOne", body: ADA });
    await execute(made.crud, { operation: "findOne", id: 1 });
    await execute(made.crud, { operation: "findMany" });
    return made;
  }

  it("createOne drops every cached entry for the entity", async () => {
    const { crud, adapter } = await primed();
    const readsBefore = adapter.reads;

    await execute(crud, { operation: "createOne", body: { ...ADA, name: "Grace" } });

    const reRead = await execute(crud, { operation: "findOne", id: 1 });
    expect(reRead.item).toMatchObject({ name: "Ada" });
    expect(adapter.reads).toBe(readsBefore + 1); // fresh findOneById
    await execute(crud, { operation: "findMany" });
    expect(adapter.reads).toBe(readsBefore + 3); // fresh findMany + count
  });

  it("patchOne invalidates both the target row's entry and the list entry", async () => {
    const { crud, adapter } = await primed();
    const readsBefore = adapter.reads;

    await execute(crud, { operation: "patchOne", id: 1, body: { age: 99 } });

    const reRead = await execute(crud, { operation: "findOne", id: 1 });
    expect(reRead.item).toMatchObject({ age: 99 });
    expect(adapter.reads).toBe(readsBefore + 1);
  });

  it("updateOne invalidates", async () => {
    const { crud, adapter } = await primed();
    const readsBefore = adapter.reads;

    await execute(crud, { operation: "updateOne", id: 1, body: { ...ADA, name: "Ada L" } });
    await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsBefore + 1);
  });

  it("deleteOne invalidates", async () => {
    const { crud, adapter } = await primed();
    const readsBefore = adapter.reads;

    await execute(crud, { operation: "deleteOne", id: 1 });

    // The delete is a hard-delete on User: the entry now re-fetches and 404s.
    await expect(execute(crud, { operation: "findOne", id: 1 })).rejects.toMatchObject({
      code: "KAVO_NOT_FOUND",
      status: 404,
    });
    expect(adapter.reads).toBe(readsBefore + 1);
  });

  it("a custom write operation invalidates too", async () => {
    const { crud, adapter } = await primed();
    let ran = false;
    crud.engine.registry.register({
      id: "archiveOne",
      kind: "write",
      cardinality: "single",
      enabled: true,
      handler: {
        async execute() {
          ran = true;
          return null;
        },
      },
      input: null,
      output: null,
      meta: {},
    } as never);
    const readsBefore = adapter.reads;

    await execute(crud, { operation: "archiveOne", id: 1 });
    expect(ran).toBe(true);

    await execute(crud, { operation: "findOne", id: 1 });
    expect(adapter.reads).toBe(readsBefore + 1);
  });

  it("a custom read operation is not cached, whatever its handler returns", async () => {
    const { crud, adapter } = await primed();
    let calls = 0;
    crud.engine.registry.register({
      id: "statOne",
      kind: "read",
      cardinality: "single",
      enabled: true,
      handler: {
        async execute() {
          calls++;
          return { age: calls };
        },
      },
      input: null,
      output: null,
      meta: {},
    } as never);

    const readsBefore = adapter.reads;
    const first = await execute(crud, { operation: "statOne" });
    const second = await execute(crud, { operation: "statOne" });
    expect(first.item).toMatchObject({ age: 1 });
    expect(second.item).toMatchObject({ age: 2 });
    expect(calls).toBe(2); // both ran the pipeline: a custom read is never cached
    expect(adapter.reads).toBe(readsBefore); // and the handler never touched the adapter
  });

  it("a failed write does not invalidate — the cache keeps what it had", async () => {
    const { crud, adapter } = await primed();
    const readsBefore = adapter.reads;

    await expect(execute(crud, { operation: "patchOne", id: 404, body: { age: 1 } })).rejects.toMatchObject({
      code: "KAVO_NOT_FOUND",
      status: 404,
    });

    const hit = await execute(crud, { operation: "findOne", id: 1 });
    expect(hit.item).toMatchObject({ name: "Ada" });
    expect(adapter.reads).toBe(readsBefore); // served from the surviving cache
  });
});

describe("ETag and If-None-Match on a cached hit", () => {
  it("a hit still serves a current, correct ETag", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    const first = await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    const hit = await execute(crud, { operation: "findOne", id: 1 });
    expect(hit.etag).toBe(first.etag);
    expect(hit.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(adapter.reads).toBe(readsAfterMiss);
  });

  it("a hit answers If-None-Match: a current tag is a 304 from the cache", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    const { etag } = await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    const revalidated = await execute(crud, {
      operation: "findOne",
      id: 1,
      preconditions: { ifNoneMatch: [etag as string] },
    });
    expect(revalidated.notModified).toBe(true);
    expect(revalidated.etag).toBe(etag);
    expect(adapter.reads).toBe(readsAfterMiss);
  });

  it("recomputes the tag for the call's own cache.etag scope, not from storage", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    await execute(crud, { operation: "findOne", id: 1 });
    const readsAfterMiss = adapter.reads;

    // The entry was stored with an ETag, but this call's cache.etag is
    // off — the hit must serve `etag: null`, never the stored tag.
    const off = await execute(crud, {
      operation: "findOne",
      id: 1,
      options: { settings: { cache: { etag: false } } },
    });
    expect(off.etag).toBeNull();
    expect(off.notModified).toBe(false);
    expect(adapter.reads).toBe(readsAfterMiss);
  });

  it("a write invalidates both the body and the conditional answer", async () => {
    const { crud } = makeCrud({ cache: { ttl: 60 } } as never, createMemoryCacheStore());
    await execute(crud, { operation: "createOne", body: ADA });
    const { etag } = await execute(crud, { operation: "findOne", id: 1 });
    await execute(crud, { operation: "patchOne", id: 1, body: { age: 99 } });

    const revalidated = await execute(crud, {
      operation: "findOne",
      id: 1,
      preconditions: { ifNoneMatch: [etag as string] },
    });
    expect(revalidated.notModified).toBe(false);
    expect(revalidated.etag).not.toBe(etag);
    expect(revalidated.item).toMatchObject({ age: 99 });
  });
});

describe("cache-store failures degrade, never fail", () => {
  const throwing = (partial: Partial<CacheStore>): CacheStore =>
    ({
      get: async () => {
        throw new Error("cache down");
      },
      set: async () => {
        throw new Error("cache down");
      },
      invalidate: async () => {
        throw new Error("cache down");
      },
      ...partial,
    }) as CacheStore;

  it("a store that fails to answer is a miss, and the read still succeeds", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, throwing({}));
    await execute(crud, { operation: "createOne", body: ADA });

    await expect(execute(crud, { operation: "findOne", id: 1 })).resolves.toMatchObject({
      item: expect.objectContaining({ name: "Ada" }),
    });
    expect(adapter.reads).toBe(1);
  });

  it("a store that fails to hold a value does not fail the read that produced it", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, throwing({}));
    await execute(crud, { operation: "createOne", body: ADA });

    await expect(execute(crud, { operation: "findOne", id: 1 })).resolves.toMatchObject({
      item: expect.objectContaining({ name: "Ada" }),
    });
    expect(adapter.reads).toBe(1);
  });

  it("a store that fails to evict does not fail the write that asked for it", async () => {
    const { crud, adapter } = makeCrud({ cache: { ttl: 60 } } as never, throwing({}));
    await execute(crud, { operation: "createOne", body: ADA });

    await expect(execute(crud, { operation: "patchOne", id: 1, body: { age: 99 } })).resolves.toMatchObject({
      item: expect.objectContaining({ age: 99 }),
    });
    expect(adapter.rows[0]).toMatchObject({ age: 99 });
  });
});

describe("createMemoryCacheStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const response: KavoResponse = {
    operation: "findOne",
    item: { id: 1, name: "Ada" },
    list: null,
    etag: null,
    notModified: false,
  };

  it("round-trips a value per entity and key", () => {
    const store = createMemoryCacheStore();
    expect(store.get("User", "k")).toBeNull();

    store.set("User", "k", response, 60);
    expect(store.get("User", "k")).toEqual(response);
  });

  it("keys are per entity — one entity's entry never leaks into another's", () => {
    const store = createMemoryCacheStore();
    store.set("User", "k", response, 60);
    expect(store.get("Post", "k")).toBeNull();
  });

  it("invalidates one entity's entries only", () => {
    const store = createMemoryCacheStore();
    store.set("User", "k", response, 60);
    store.set("Post", "k", response, 60);

    store.invalidate("User");
    expect(store.get("User", "k")).toBeNull();
    expect(store.get("Post", "k")).toEqual(response);
  });

  it("drops an expired entry on read", () => {
    vi.useFakeTimers();
    const store = createMemoryCacheStore();
    store.set("User", "k", response, 10);
    expect(store.get("User", "k")).toEqual(response);

    vi.advanceTimersByTime(10_001);
    expect(store.get("User", "k")).toBeNull();
  });

  it("invalidating an entity that never cached anything is a no-op", () => {
    const store = createMemoryCacheStore();
    expect(() => store.invalidate("Ghost")).not.toThrow();
  });
});
