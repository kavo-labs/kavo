import { describe, expect, it } from "vitest";
import type {
  EntityId,
  EntityMetadata,
  KavoRequest,
  NormalizedQueryContext,
  RequestPreconditions,
  RepositoryAdapter,
} from "@kavo/core";
import {
  AlreadyDeletedException,
  NotFoundException,
  PreconditionFailedException,
  PreconditionUnsupportedException,
  createKavo,
} from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";
import { Account, InMemoryAccountAdapter, accountMetadata } from "./support/account-fixture.js";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";

type EntityConfigArg = Parameters<ReturnType<typeof createKavo>["createCrud"]>[1];

function makeCrud(config?: EntityConfigArg, defaults?: Parameters<typeof createKavo>[0]) {
  const adapter = new InMemoryUserAdapter();
  const crud = createKavo(defaults).createCrud(User, config as never, { adapter, metadata: userMetadata });
  return { crud, adapter };
}

function makeAccountCrud(config?: EntityConfigArg) {
  const adapter = new InMemoryAccountAdapter();
  const crud = createKavo().createCrud(Account, config as never, { adapter, metadata: accountMetadata });
  return { crud, adapter };
}

/**
 * Counts `findOneById` so a test can prove the `If-Match` pre-read did or
 * did not happen — the same adapter-call-counting shape
 * `operation-overrides.spec.ts` uses, kept local because a test file never
 * imports another test file.
 */
class CountingUserAdapter implements RepositoryAdapter<User> {
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
    return this.inner.findMany(query);
  }
  async count(query: NormalizedQueryContext<User>) {
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

/** The engine envelope, which the typed service surface unwraps away. */
function execute(
  crud: ReturnType<typeof makeCrud>["crud"],
  request: Partial<KavoRequest<User>> & { operation: string },
) {
  return crud.engine.execute({ id: null, body: null, query: null, options: null, ...request } as never);
}

describe("ETag generation", () => {
  it("puts a strong entity-tag on every single-item response", async () => {
    const { crud } = makeCrud();
    for (const response of [
      await execute(crud, { operation: "createOne", body: ADA as never }),
      await execute(crud, { operation: "findOne", id: 1 }),
      await execute(crud, { operation: "updateOne", id: 1, body: { name: "Ada L" } as never }),
      await execute(crud, { operation: "patchOne", id: 1, body: { age: 37 } as never }),
    ]) {
      expect(response.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(response.notModified).toBe(false);
    }
  });

  it("tags a restoreOne response too", async () => {
    const { crud } = makeAccountCrud({ operations: { createOne: {}, deleteOne: {}, restoreOne: {} } });
    await crud.createOne({ name: "a" } as never);
    await crud.deleteOne(1);

    const response = await crud.engine.execute({
      operation: "restoreOne",
      id: 1,
      body: null,
      query: null,
      options: null,
    } as never);
    expect(response.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("changes the tag when the item changes and repeats it when it does not", async () => {
    const { crud } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });
    const first = await execute(crud, { operation: "findOne", id: 1 });
    const again = await execute(crud, { operation: "findOne", id: 1 });
    expect(again.etag).toBe(first.etag);

    await execute(crud, { operation: "patchOne", id: 1, body: { age: 99 } as never });
    const changed = await execute(crud, { operation: "findOne", id: 1 });
    expect(changed.etag).not.toBe(first.etag);
  });

  it("leaves collection and void responses untagged (out of scope)", async () => {
    const { crud } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });

    const list = await execute(crud, { operation: "findMany" });
    expect(list.etag).toBeNull();
    expect(list.notModified).toBe(false);

    const deleted = await execute(crud, { operation: "deleteOne", id: 1 });
    expect(deleted.etag).toBeNull();
  });

  it("tags per representation: a narrowed read is a different representation", async () => {
    const { crud } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });

    const full = await execute(crud, { operation: "findOne", id: 1 });
    const narrowed = await execute(crud, { operation: "findOne", id: 1, query: { fields: ["name"] } as never });
    expect(narrowed.item).toEqual({ name: "Ada" });
    expect(narrowed.etag).not.toBe(full.etag);
  });

  it("tags per representation for include= too, not only fields=", async () => {
    // The adopter docs name both narrowing knobs; only `fields=` was
    // pinned, so an `include=` that stopped changing the tag would have
    // gone unnoticed — and a tag that ignores an embedded relation is a
    // cache that serves the wrong body.
    const postAdapter = new SeededAdapter<Post>([
      Object.assign(new Post(), { id: 1, title: "First", authorId: 7, author: Object.assign(new Author(), { id: 7 }) }),
    ]);
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
    });
    const posts = kavo.createCrud(Post, {
      allowlists: { includable: ["author"] },
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
    expect(embedded.etag).not.toBe(plain.etag);
  });
});

describe("If-None-Match on a read", () => {
  const ifNoneMatch = (tags: readonly string[]): RequestPreconditions => ({ ifNoneMatch: tags });

  it("signals not-modified when the client's tag is current", async () => {
    const { crud } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });
    const { etag } = await execute(crud, { operation: "findOne", id: 1 });

    const revalidated = await execute(crud, {
      operation: "findOne",
      id: 1,
      preconditions: ifNoneMatch([etag as string]),
    });
    expect(revalidated.notModified).toBe(true);
    expect(revalidated.etag).toBe(etag);
  });

  it("does not signal not-modified once the item has changed", async () => {
    const { crud } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });
    const { etag } = await execute(crud, { operation: "findOne", id: 1 });
    await execute(crud, { operation: "patchOne", id: 1, body: { age: 99 } as never });

    const revalidated = await execute(crud, {
      operation: "findOne",
      id: 1,
      preconditions: ifNoneMatch([etag as string]),
    });
    expect(revalidated.notModified).toBe(false);
    expect(revalidated.etag).not.toBe(etag);
    expect(revalidated.item).toMatchObject({ age: 99 });
  });

  it("matches the wildcard against any existing representation", async () => {
    const { crud } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });

    const revalidated = await execute(crud, { operation: "findOne", id: 1, preconditions: ifNoneMatch(["*"]) });
    expect(revalidated.notModified).toBe(true);
  });

  it("is ignored on a write, which has no cache to revalidate", async () => {
    const { crud } = makeCrud();
    const created = await execute(crud, { operation: "createOne", body: ADA as never });

    const patched = await execute(crud, {
      operation: "patchOne",
      id: 1,
      body: { name: "Ada" } as never,
      preconditions: ifNoneMatch([created.etag as string, "*"]),
    });
    expect(patched.notModified).toBe(false);
  });
});

describe("If-Match on a write", () => {
  const ifMatch = (tags: readonly string[]): RequestPreconditions => ({ ifMatch: tags });

  async function seeded() {
    const made = makeCrud();
    await execute(made.crud, { operation: "createOne", body: ADA as never });
    const { etag } = await execute(made.crud, { operation: "findOne", id: 1 });
    return { ...made, etag: etag as string };
  }

  it("applies the write when the tag is current", async () => {
    const { crud, adapter, etag } = await seeded();

    const updated = await execute(crud, {
      operation: "updateOne",
      id: 1,
      body: { name: "Ada Lovelace", email: ADA.email, age: 36, status: "active" } as never,
      preconditions: ifMatch([etag]),
    });
    expect(updated.item).toMatchObject({ name: "Ada Lovelace" });
    expect(updated.etag).not.toBe(etag);
    expect(adapter.rows[0]).toMatchObject({ name: "Ada Lovelace" });
  });

  it("accepts a tag from a findOne with its own output override (issue #131)", async () => {
    // The canonical read `checkIfMatch` pre-reads for comparison must use
    // the *same* representation `findOne` actually serves — `descriptor
    // .output` ahead of the root `item` slot — or every conditional write
    // against a findOne-overridden entity would 412 against a hash the
    // client never received.
    class UserProfileDto {
      id = 0;
      name = "";
    }
    const adapter = new InMemoryUserAdapter();
    const crud = createKavo().createCrud(
      User,
      {
        operations: { createOne: true, updateOne: true, findOne: { enabled: true, dto: { output: UserProfileDto } } },
      } as never,
      { adapter, metadata: userMetadata },
    );
    await execute(crud, { operation: "createOne", body: ADA as never });
    const { etag } = await execute(crud, { operation: "findOne", id: 1 });

    const updated = await execute(crud, {
      operation: "updateOne",
      id: 1,
      body: { name: "Ada Lovelace", email: ADA.email, age: 36, status: "active" } as never,
      preconditions: ifMatch([etag as string]),
    });
    expect(updated.item).toMatchObject({ name: "Ada Lovelace" });
  });

  it("rejects a stale tag with KAVO_PRECONDITION_FAILED and leaves the row untouched", async () => {
    const { crud, adapter, etag } = await seeded();
    await execute(crud, { operation: "patchOne", id: 1, body: { age: 99 } as never });

    const attempt = execute(crud, {
      operation: "patchOne",
      id: 1,
      body: { name: "Overwritten" } as never,
      preconditions: ifMatch([etag]),
    });
    await expect(attempt).rejects.toBeInstanceOf(PreconditionFailedException);
    await expect(attempt).rejects.toMatchObject({ code: "KAVO_PRECONDITION_FAILED", status: 412 });
    expect(adapter.rows[0]).toMatchObject({ name: "Ada", age: 99 });
  });

  it("blocks a stale deleteOne, leaving the row in place", async () => {
    const { crud, adapter, etag } = await seeded();
    await execute(crud, { operation: "patchOne", id: 1, body: { age: 99 } as never });

    await expect(
      execute(crud, { operation: "deleteOne", id: 1, preconditions: ifMatch([etag]) }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(adapter.rows).toHaveLength(1);
  });

  it("allows a fresh deleteOne", async () => {
    const { crud, adapter, etag } = await seeded();

    await execute(crud, { operation: "deleteOne", id: 1, preconditions: ifMatch([etag]) });
    expect(adapter.rows).toHaveLength(0);
  });

  it("raises 404, not 412, when the target does not exist", async () => {
    const { crud } = makeCrud();

    const attempt = execute(crud, {
      operation: "patchOne",
      id: 404,
      body: { name: "ghost" } as never,
      preconditions: ifMatch(['"whatever"']),
    });
    await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
    await expect(attempt).rejects.toMatchObject({ code: "KAVO_NOT_FOUND", status: 404 });
  });

  it("names the current tag in the failure, so a client can retry without a blind re-GET", async () => {
    const { crud, etag } = await seeded();
    await execute(crud, { operation: "patchOne", id: 1, body: { age: 99 } as never });
    const current = (await execute(crud, { operation: "findOne", id: 1 })).etag as string;

    await expect(
      execute(crud, { operation: "patchOne", id: 1, body: { age: 1 } as never, preconditions: ifMatch([etag]) }),
    ).rejects.toMatchObject({ messageParams: { entity: "User", id: "1", etag: current } });
  });

  it("accepts the wildcard against an existing row", async () => {
    const { crud, adapter } = await seeded();

    await execute(crud, { operation: "patchOne", id: 1, body: { age: 42 } as never, preconditions: ifMatch(["*"]) });
    expect(adapter.rows[0]).toMatchObject({ age: 42 });
  });

  it("rejects a weak tag, which promises only semantic equivalence", async () => {
    const { crud, adapter, etag } = await seeded();

    await expect(
      execute(crud, { operation: "patchOne", id: 1, body: { age: 1 } as never, preconditions: ifMatch([`W/${etag}`]) }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(adapter.rows[0]).toMatchObject({ age: 36 });
  });

  it("rejects an If-Match that is present but names no tag at all", async () => {
    // `If-Match:` with an empty value parses to zero tags. Zero tags match
    // nothing, so the condition is false — the write must not slip through
    // as if the client had asked for no guard.
    const { crud, adapter } = await seeded();

    await expect(
      execute(crud, { operation: "patchOne", id: 1, body: { age: 1 } as never, preconditions: ifMatch([]) }),
    ).rejects.toMatchObject({ code: "KAVO_PRECONDITION_FAILED", status: 412 });
    expect(adapter.rows[0]).toMatchObject({ age: 36 });
  });

  it("412s a tag taken from a fields-narrowed read, which is a different representation", async () => {
    // The documented sharp edge, pinned so `canonicalEtag` cannot start
    // honoring `request.query` without a test noticing.
    const { crud, adapter } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });
    const narrowed = await execute(crud, { operation: "findOne", id: 1, query: { fields: ["name"] } as never });

    await expect(
      execute(crud, {
        operation: "patchOne",
        id: 1,
        body: { age: 1 } as never,
        preconditions: ifMatch([narrowed.etag as string]),
      }),
    ).rejects.toMatchObject({ code: "KAVO_PRECONDITION_FAILED", status: 412 });
    expect(adapter.rows[0]).toMatchObject({ age: 36 });
  });

  it("does not pre-read at all for If-Match: *, whose answer needs no tag", async () => {
    const adapter = new CountingUserAdapter();
    const crud = createKavo().createCrud(User, undefined as never, { adapter, metadata: userMetadata });
    await crud.createOne(ADA as never);
    const before = adapter.reads;

    await crud.engine.execute({
      operation: "patchOne",
      id: 1,
      body: { age: 42 } as never,
      query: null,
      options: null,
      preconditions: { ifMatch: ["*"] },
    } as never);

    expect(adapter.reads).toBe(before);
    expect(adapter.rows[0]).toMatchObject({ age: 42 });
  });

  it("pre-reads exactly once for a real tag", async () => {
    const adapter = new CountingUserAdapter();
    const crud = createKavo().createCrud(User, undefined as never, { adapter, metadata: userMetadata });
    await crud.createOne(ADA as never);
    const before = adapter.reads;

    await expect(
      crud.patchOne(1, { age: 1 } as never, { preconditions: { ifMatch: ['"stale"'] } }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(adapter.reads).toBe(before + 1);
  });

  it("reaches the engine through KavoCallOptions on the typed service surface", async () => {
    const { crud, etag } = await seeded();

    await expect(
      crud.patchOne(1, { age: 1 } as never, { preconditions: { ifMatch: ['"stale"'] } }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    await expect(crud.patchOne(1, { age: 1 } as never, { preconditions: { ifMatch: [etag] } })).resolves.toMatchObject({
      age: 1,
    });
  });
});

describe("If-Match on a soft-deleted row", () => {
  /** A soft-deleted account plus the tag its `withDeleted` read serves. */
  async function trashed(config: EntityConfigArg) {
    // createOne/deleteOne/findOne are what the fixture itself needs to run,
    // independent of whichever operation the caller is actually testing —
    // declaring `operations` at all makes it an exclusive whitelist
    // (issue #257), so they have to be named here too.
    const withFixtureOps =
      config === undefined
        ? config
        : {
            ...config,
            operations: {
              createOne: true,
              deleteOne: true,
              findOne: true,
              ...(config as { operations?: object }).operations,
            },
          };
    const made = makeAccountCrud(withFixtureOps as EntityConfigArg);
    await execute(made.crud as never, { operation: "createOne", body: { name: "a" } as never });
    await execute(made.crud as never, { operation: "deleteOne", id: 1 });
    const found = await execute(made.crud as never, {
      operation: "findOne",
      id: 1,
      query: { withDeleted: true } as never,
    });
    return { ...made, etag: found.etag as string };
  }

  it("blocks a stale restoreOne and leaves the row deleted", async () => {
    const { crud, adapter } = await trashed({ operations: { restoreOne: true } } as never);

    await expect(
      execute(crud as never, { operation: "restoreOne", id: 1, preconditions: { ifMatch: ['"stale"'] } }),
    ).rejects.toMatchObject({ code: "KAVO_PRECONDITION_FAILED", status: 412 });
    expect(adapter.rows[0]?.deletedAt).not.toBeNull();
  });

  it("allows a restoreOne whose tag came from a withDeleted read", async () => {
    const { crud, adapter, etag } = await trashed({ operations: { restoreOne: true } } as never);

    await execute(crud as never, { operation: "restoreOne", id: 1, preconditions: { ifMatch: [etag] } });
    expect(adapter.rows[0]?.deletedAt).toBeNull();
  });

  it("blocks a stale purgeOne, so the row is still there to purge later", async () => {
    const { crud, adapter } = await trashed({ operations: { purgeOne: true } } as never);

    await expect(
      execute(crud as never, { operation: "purgeOne", id: 1, preconditions: { ifMatch: ['"stale"'] } }),
    ).rejects.toMatchObject({ code: "KAVO_PRECONDITION_FAILED", status: 412 });
    expect(adapter.rows).toHaveLength(1);
  });

  it("allows a fresh purgeOne", async () => {
    const { crud, adapter, etag } = await trashed({ operations: { purgeOne: true } } as never);

    await execute(crud as never, { operation: "purgeOne", id: 1, preconditions: { ifMatch: [etag] } });
    expect(adapter.rows).toHaveLength(0);
  });

  it("keeps deleteOne's own 409 whether or not a conditional header is sent", async () => {
    // The error identity of a request must not depend on a cache header:
    // both arms are the operation's own AlreadyDeletedException, never the
    // 404 a live-rows-only pre-read would have produced.
    const bare = await trashed(undefined);
    await expect(execute(bare.crud as never, { operation: "deleteOne", id: 1 })).rejects.toBeInstanceOf(
      AlreadyDeletedException,
    );

    const conditional = await trashed(undefined);
    await expect(
      execute(conditional.crud as never, {
        operation: "deleteOne",
        id: 1,
        preconditions: { ifMatch: [conditional.etag] },
      }),
    ).rejects.toMatchObject({ code: "KAVO_ALREADY_DELETED", status: 409 });
  });
});

describe("a write response's tag describes that response, not the canonical read", () => {
  /**
   * `defaultInclude` is where the two representations part ways: a write
   * resolves no query, so its response never carries relations while the
   * canonical read the pre-read hashes always does. So on such an entity a
   * write response's tag is *not* an `If-Match` token — the limit
   * ADR-0020 and `docs/using-the-api.md` both spell out, pinned here so
   * the advice cannot drift away from the behavior.
   */
  function seededAuthor() {
    const adapter = new SeededAdapter<Author>([
      Object.assign(new Author(), {
        id: 1,
        name: "Ada",
        posts: [Object.assign(new Post(), { id: 10, title: "First", authorId: 1 })],
      }),
    ]);
    const metadata = new Map<unknown, EntityMetadata<object>>([
      [Author, authorMetadata as EntityMetadata<object>],
      [Post, postMetadata as EntityMetadata<object>],
    ]);
    const adapters = new Map<unknown, unknown>([
      [Author, adapter],
      [Post, new SeededAdapter<Post>([])],
    ]);
    const kavo = createKavo({
      infrastructure: {
        metadataFor: (entity) => metadata.get(entity) as never,
        adapterFor: (entity) => adapters.get(entity) as never,
      },
    });
    const crud = kavo.createCrud(Author, {
      allowlists: { includable: ["posts"] },
      relations: { edges: { posts: { defaultInclude: true } } },
    } as never);
    kavo.createCrud(Post);
    return { crud, adapter };
  }

  const patch = (crud: ReturnType<typeof seededAuthor>["crud"], name: string) =>
    crud.engine.execute({ operation: "patchOne", id: 1, body: { name } as never, query: null, options: null });

  it("differs from the read's, because only the read carries the default include", async () => {
    const { crud } = seededAuthor();

    const read = await crud.engine.execute({ operation: "findOne", id: 1, body: null, query: null, options: null });
    const patched = await patch(crud, "Ada L");

    expect(read.item).toMatchObject({ posts: [{ title: "First" }] });
    expect(patched.item).not.toHaveProperty("posts");
    expect(patched.etag).not.toBe(read.etag);
  });

  it("so the If-Match token has to come from the read", async () => {
    const { crud } = seededAuthor();
    const patched = await patch(crud, "Ada L");

    await expect(
      crud.patchOne(1, { name: "Ada Lovelace" } as never, { preconditions: { ifMatch: [patched.etag as string] } }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);

    const read = await crud.engine.execute({ operation: "findOne", id: 1, body: null, query: null, options: null });
    await expect(
      crud.patchOne(1, { name: "Ada Lovelace" } as never, { preconditions: { ifMatch: [read.etag as string] } }),
    ).resolves.toMatchObject({ name: "Ada Lovelace" });
  });
});

describe("If-Match the engine cannot evaluate is refused, never dropped", () => {
  it("refuses it on createOne, which targets no existing row", async () => {
    const { crud, adapter } = makeCrud();

    await expect(
      execute(crud, { operation: "createOne", body: ADA as never, preconditions: { ifMatch: ["*"] } }),
    ).rejects.toMatchObject({ code: "KAVO_PRECONDITION_UNSUPPORTED", status: 412 });
    expect(adapter.rows).toHaveLength(0);
  });

  it("refuses it on a custom operation, whose target nothing in the schema describes", async () => {
    const { crud, adapter } = makeCrud();
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
    await execute(crud, { operation: "createOne", body: ADA as never });

    await expect(
      execute(crud, { operation: "archiveOne", id: 1, preconditions: { ifMatch: ['"whatever"'] } }),
    ).rejects.toBeInstanceOf(PreconditionUnsupportedException);
    expect(ran).toBe(false);
    expect(adapter.rows).toHaveLength(1);
  });

  it("refuses it when findOne is disabled, rather than leaking a tag the API never serves", async () => {
    const { crud, adapter } = makeCrud({ operations: { createOne: {}, patchOne: {} } } as never); // findOne left off, so it's disabled
    await execute(crud, { operation: "createOne", body: ADA as never });

    const attempt = execute(crud, {
      operation: "patchOne",
      id: 1,
      body: { age: 7 } as never,
      preconditions: { ifMatch: ['"stale"'] },
    });
    await expect(attempt).rejects.toMatchObject({ code: "KAVO_PRECONDITION_UNSUPPORTED", status: 412 });
    // The whole point: no hash of the row anywhere in the message.
    await expect(attempt).rejects.toSatisfy((error: Error) => !/[0-9a-f]{64}/.test(error.message));
    expect(adapter.rows[0]).toMatchObject({ age: 36 });
  });

  it("still ignores it on a read, which cannot lose an update", async () => {
    const { crud } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });

    const found = await execute(crud, { operation: "findOne", id: 1, preconditions: { ifMatch: ['"stale"'] } });
    expect(found.item).toMatchObject({ name: "Ada" });
  });
});

describe("cache.etag: false disables both halves", () => {
  type Scope = readonly [string, () => ReturnType<typeof makeCrud>, KavoRequest<User>["options"]];
  const scopes: readonly Scope[] = [
    ["global", () => makeCrud(undefined, { defaults: { cache: { etag: false } } }), null],
    ["entity", () => makeCrud({ cache: { etag: false } } as never), null],
    [
      "operation",
      () =>
        makeCrud({
          operations: {
            createOne: true,
            findOne: { enabled: true, cache: { etag: false } },
            patchOne: { enabled: true, cache: { etag: false } },
          },
        } as never),
      null,
    ],
    ["per-call", () => makeCrud(), { settings: { cache: { etag: false } } }],
  ];

  for (const [scope, build, options] of scopes) {
    it(`computes no tag at ${scope} scope`, async () => {
      const { crud } = build();
      await execute(crud, { operation: "createOne", body: ADA as never });

      expect((await execute(crud, { operation: "findOne", id: 1, options })).etag).toBeNull();
    });

    it(`refuses an If-Match precondition at ${scope} scope`, async () => {
      // Refused, not ignored: a client that asked for a guard and got a
      // 2xx would have no way to learn nothing checked it. The operation
      // scope is the one that makes this reachable by accident — `findOne`
      // can serve tags while `patchOne` has etag off.
      const { crud, adapter } = build();
      await execute(crud, { operation: "createOne", body: ADA as never });

      await expect(
        execute(crud, {
          operation: "patchOne",
          id: 1,
          body: { age: 7 } as never,
          options,
          preconditions: { ifMatch: ['"definitely-stale"'] },
        }),
      ).rejects.toMatchObject({ code: "KAVO_PRECONDITION_UNSUPPORTED", status: 412 });
      expect(adapter.rows[0]).toMatchObject({ age: 36 });
    });
  }

  it("can be turned off for one call only, without touching the frozen config", async () => {
    const { crud } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });

    const off = await execute(crud, {
      operation: "findOne",
      id: 1,
      options: { settings: { cache: { etag: false } } },
    });
    expect(off.etag).toBeNull();

    expect((await execute(crud, { operation: "findOne", id: 1 })).etag).not.toBeNull();
  });

  it("ignores an If-None-Match when switched off per call", async () => {
    const { crud } = makeCrud();
    await execute(crud, { operation: "createOne", body: ADA as never });
    const { etag } = await execute(crud, { operation: "findOne", id: 1 });

    const off = await execute(crud, {
      operation: "findOne",
      id: 1,
      preconditions: { ifNoneMatch: [etag as string] },
      options: { settings: { cache: { etag: false } } },
    });
    expect(off.notModified).toBe(false);
  });
});
