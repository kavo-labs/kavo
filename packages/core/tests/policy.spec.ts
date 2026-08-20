import { describe, expect, it } from "vitest";
import type { KavoOptions } from "@kavo/core";
import {
  ConfigurationException,
  ForbiddenException,
  NotFoundException,
  createKavo,
  evaluatePolicy,
  policyNeedsEntity,
} from "@kavo/core";
import type { EntityId, KavoContext } from "@kavo/core";
import { and, authenticated, filtered, not, or, owner, permission, role, when } from "@kavo/core";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";
import { Account, InMemoryAccountAdapter, accountMetadata } from "./support/account-fixture.js";

function makeCrud(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1], options?: KavoOptions) {
  const adapter = new SeededAdapter<Post>([]);
  const kavo = createKavo(options);
  const crud = kavo.createCrud(Post, config as never, { adapter, metadata: postMetadata });
  return { crud, adapter, kavo };
}

/** `SeededAdapter` plus the one write `arrayMutation`'s `replace` strategy needs (mirrors array-mutation.spec.ts's own). */
class ReplaceCapableAdapter<Entity extends { id: number }> extends SeededAdapter<Entity> {
  async replaceRelation(
    id: EntityId,
    relation: string,
    memberIds: readonly EntityId[] | null,
    _context: KavoContext<Entity>,
  ): Promise<Entity> {
    const row = await this.findOneById(id, null);
    if (row === null) throw new Error("fixture: row not found");
    (row as unknown as Record<string, unknown>)[relation] = memberIds;
    return row;
  }
}

function makeAuthorCrud(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1], options?: KavoOptions) {
  const adapter = new ReplaceCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [] }]);
  const kavo = createKavo(options);
  // Registered on the same root so the entity catalog can resolve `Post`'s
  // id field when normalizing `posts` refs (the same setup array-mutation.spec.ts uses).
  kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
  const crud = kavo.createCrud(
    Author,
    {
      arrayMutation: { strategy: "replace" },
      relations: { edges: { posts: { write: true } } },
      ...config,
    } as never,
    { adapter, metadata: authorMetadata },
  );
  return { crud, adapter, kavo };
}

function makeAccountCrud(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1]) {
  const adapter = new InMemoryAccountAdapter();
  const kavo = createKavo();
  const crud = kavo.createCrud(Account, config as never, { adapter, metadata: accountMetadata });
  return { crud, adapter, kavo };
}

const OWNER = { userId: "u-1" };
const OTHER = { userId: "u-2" };

describe("policy — Level 1 permission()", () => {
  it("allows a call carrying the required permission", async () => {
    const { crud, adapter } = makeCrud({ operations: { updateOne: { policy: permission("post:update") } } } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    const updated = await crud.updateOne(1, { title: "b" } as never, {
      principal: { permissions: ["post:update"] },
    });
    expect(updated).toMatchObject({ title: "b" });
  });

  it("denies a call missing the required permission with KAVO_FORBIDDEN (403)", async () => {
    const { crud, adapter } = makeCrud({ operations: { updateOne: { policy: permission("post:update") } } } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    const call = crud.updateOne(1, { title: "b" } as never, { principal: { permissions: [] } });
    await expect(call).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_FORBIDDEN", status: 403 });
  });

  it("ANDs multiple permissions — every listed permission is required", async () => {
    const { crud, adapter } = makeCrud({
      operations: { deleteOne: { policy: and(permission("post:delete"), permission("admin")) } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await expect(crud.deleteOne(1, { principal: { permissions: ["post:delete"] } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("leaves an entity with no configured policy unrestricted", async () => {
    const { crud, adapter } = makeCrud();
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await expect(crud.updateOne(1, { title: "b" } as never)).resolves.toMatchObject({ title: "b" });
  });
});

describe("policy — Level 2 helper DSL", () => {
  it("owner() checks the loaded entity against principal.userId", async () => {
    const { crud, adapter } = makeCrud({ operations: { updateOne: { policy: owner("authorId") } } } as never);
    adapter.rows.push({
      id: 1,
      title: "a",
      authorId: "u-1",
      author: null,
      comments: [],
      deletedAt: null,
    } as unknown as Post);

    await expect(crud.updateOne(1, { title: "mine" } as never, { principal: OWNER })).resolves.toMatchObject({
      title: "mine",
    });

    await expect(crud.updateOne(1, { title: "not mine" } as never, { principal: OTHER })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("composes and()/or()/not() — admin bypasses ownership, a banned owner is still denied", async () => {
    const policy = or(role("admin"), and(permission("post:update"), owner("authorId"), not(role("banned"))));
    const { crud, adapter } = makeCrud({ operations: { updateOne: { policy } } } as never);
    adapter.rows.push({
      id: 1,
      title: "a",
      authorId: "u-1",
      author: null,
      comments: [],
      deletedAt: null,
    } as unknown as Post);

    await expect(
      crud.updateOne(1, { title: "x" } as never, { principal: { userId: "u-9", roles: ["admin"] } }),
    ).resolves.toMatchObject({ title: "x" });

    await expect(
      crud.updateOne(1, { title: "x" } as never, {
        principal: { userId: "u-1", permissions: ["post:update"], roles: ["banned"] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      crud.updateOne(1, { title: "x" } as never, { principal: { userId: "u-1", permissions: ["post:update"] } }),
    ).resolves.toMatchObject({ title: "x" });
  });

  it("authenticated() checks principal.userId presence", async () => {
    const { crud } = makeCrud({ operations: { createOne: { policy: authenticated() } } } as never);
    await expect(crud.createOne({ title: "x", authorId: "u-1" } as never, { principal: null })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(crud.createOne({ title: "x", authorId: "u-1" } as never, { principal: OWNER })).resolves.toMatchObject(
      { title: "x" },
    );
  });

  it("when() runs an arbitrary predicate against context and the loaded entity", async () => {
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: when<Post>(({ entity }) => entity?.title !== "locked") } },
    } as never);
    adapter.rows.push({ id: 1, title: "locked", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await expect(crud.updateOne(1, { title: "x" } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("when() receives resource, operation, and params.id alongside context and entity", async () => {
    let seen: { resource: string; operation: string; id: unknown } | undefined;
    const { crud, adapter } = makeCrud({
      operations: {
        updateOne: {
          policy: when<Post>(({ resource, operation, params }) => {
            seen = { resource, operation, id: params.id };
            return true;
          }),
        },
      },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    await expect(crud.updateOne(1, { title: "x" } as never)).resolves.toMatchObject({ title: "x" });
    expect(seen).toEqual({ resource: "Post", operation: "updateOne", id: 1 });
  });

  it("when() sees params.id coerced to the id column's kind, not the raw string a caller passed", async () => {
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: when<Post>(({ params }) => params.id === 1) } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    // The string "1", not the number 1 — what an HTTP path param arrives as.
    await expect(crud.updateOne("1" as never, { title: "x" } as never)).resolves.toMatchObject({ title: "x" });
  });

  it("when() as a leaf of and()/or()/not() still receives params after composition", async () => {
    const { crud, adapter } = makeCrud({
      operations: {
        updateOne: {
          policy: and<Post>(
            authenticated(),
            when(({ params }) => params.id === 1),
          ),
        },
      },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    adapter.rows.push({ id: 2, title: "b", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    await expect(crud.updateOne(1, { title: "x" } as never, { principal: OWNER })).resolves.toMatchObject({
      title: "x",
    });

    await expect(crud.updateOne(2, { title: "x" } as never, { principal: OWNER })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("when() on findOne (the deferred entity-aware path) also receives params.id, coerced", async () => {
    const { crud, adapter } = makeCrud({
      operations: { findOne: { policy: when<Post>(({ params }) => params.id === 1) } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    adapter.rows.push({ id: 2, title: "b", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    // The string "1" — what an HTTP path param arrives as — still matches the coerced comparison.
    await expect(crud.findOne("1" as never)).resolves.toMatchObject({ title: "a" });
    await expect(crud.findOne(2)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("evaluatePolicy defaults params to { id: null } for a direct caller with none to give", async () => {
    const context = { entityName: "Post", operation: "updateOne" } as unknown as KavoContext<Post>;
    const node = when<Post>(({ params }) => params.id === null);
    await expect(evaluatePolicy(node, context)).resolves.toBe(true);
  });
});

describe("policy — entity-aware nodes need the loaded row", () => {
  it("findOne evaluates the policy against the row it already fetched, and 404s before 403 for a missing row", async () => {
    const { crud } = makeCrud({ operations: { findOne: { policy: owner("authorId") } } } as never);
    await expect(crud.findOne(1, undefined, { principal: OWNER })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updateOne pre-fetches the row to check owner(), independent of what the handler itself does", async () => {
    const { crud, adapter } = makeCrud({ operations: { updateOne: { policy: owner("authorId") } } } as never);
    adapter.rows.push({
      id: 1,
      title: "a",
      authorId: "u-1",
      author: null,
      comments: [],
      deletedAt: null,
    } as unknown as Post);
    await expect(crud.updateOne(1, { title: "x" } as never, { principal: OTHER })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Denied before the write: the row is unchanged.
    expect(adapter.rows[0]!.title).toBe("a");
  });

  it("404s rather than 403 for an owner-checked id that doesn't exist", async () => {
    const { crud } = makeCrud({ operations: { updateOne: { policy: owner("authorId") } } } as never);
    await expect(crud.updateOne(999, { title: "x" } as never, { principal: OWNER })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("policy — bootstrap validation", () => {
  it("rejects an entity-level 'policy' map, pointing at operations.<id>.policy instead", () => {
    expect(() => makeCrud({ policy: { updateOne: permission("post:update") } } as never)).toThrowError(
      ConfigurationException,
    );
    try {
      makeCrud({ policy: { updateOne: permission("post:update") } } as never);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as ConfigurationException).detail).toContain("at 'policy'");
      expect((error as ConfigurationException).detail).toContain("operations.<id>.policy");
    }
  });

  it("rejects an entity-level 'policy' map even when empty — presence, not content, is what's rejected", () => {
    expect(() => makeCrud({ policy: {} } as never)).toThrowError(ConfigurationException);
  });

  it("rejects a bare array reaching 'policy' at runtime, since TypeScript can't catch a JS or dynamically-built config", () => {
    expect(() => makeCrud({ operations: { updateOne: { policy: ["post:update"] } } } as never)).toThrowError(
      ConfigurationException,
    );
    try {
      makeCrud({ operations: { updateOne: { policy: ["post:update"] } } } as never);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as ConfigurationException).detail).toContain("operations.updateOne.policy");
      expect((error as ConfigurationException).detail).toContain("#242");
    }
  });

  it("rejects an entity-aware node on createOne with ConfigurationException naming the entity and key path", () => {
    expect(() => makeCrud({ operations: { createOne: { policy: owner("authorId") } } } as never)).toThrowError(
      ConfigurationException,
    );
    try {
      makeCrud({ operations: { createOne: { policy: owner("authorId") } } } as never);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as ConfigurationException).detail).toContain("operations.createOne.policy");
    }
  });

  it("rejects an entity-aware node on findMany", () => {
    expect(() => makeCrud({ operations: { findMany: { policy: when<Post>(() => true) } } } as never)).toThrowError(
      ConfigurationException,
    );
  });

  it("rejects an owner() field that crosses a relation, since the pre-fetch loads no relations", () => {
    expect(() => makeCrud({ operations: { updateOne: { policy: owner("author.id") } } } as never)).toThrowError(
      ConfigurationException,
    );
  });
});

describe("policy — findOne: the deny branch on an existing row", () => {
  it("denies findOne against a row that exists but fails the policy", async () => {
    const { crud, adapter } = makeCrud({ operations: { findOne: { policy: owner("authorId") } } } as never);
    adapter.rows.push({
      id: 1,
      title: "a",
      authorId: "u-1",
      author: null,
      comments: [],
      deletedAt: null,
    } as unknown as Post);
    await expect(crud.findOne(1, undefined, { principal: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(crud.findOne(1, undefined, { principal: OWNER })).resolves.toMatchObject({ title: "a" });
  });
});

describe("policy — findMany and patchOne runtime coverage", () => {
  it("evaluates a context-only policy on findMany", async () => {
    const { crud } = makeCrud({ operations: { findMany: { policy: permission("post:list") } } } as never);
    await expect(crud.findMany(undefined, { principal: { permissions: [] } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(crud.findMany(undefined, { principal: { permissions: ["post:list"] } })).resolves.toMatchObject({
      items: [],
    });
  });

  it("evaluates owner() on patchOne", async () => {
    const { crud, adapter } = makeCrud({ operations: { patchOne: { policy: owner("authorId") } } } as never);
    adapter.rows.push({
      id: 1,
      title: "a",
      authorId: "u-1",
      author: null,
      comments: [],
      deletedAt: null,
    } as unknown as Post);
    await expect(crud.patchOne(1, { title: "x" } as never, { principal: OTHER })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(crud.patchOne(1, { title: "x" } as never, { principal: OWNER })).resolves.toMatchObject({
      title: "x",
    });
  });
});

describe("policy — missing/undefined principal", () => {
  it("permission()/role()/owner() deny (never throw) when options.principal is simply omitted", async () => {
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: or(permission("post:update"), role("admin"), owner("authorId")) } },
    } as never);
    adapter.rows.push({
      id: 1,
      title: "a",
      authorId: "u-1",
      author: null,
      comments: [],
      deletedAt: null,
    } as unknown as Post);
    await expect(crud.updateOne(1, { title: "x" } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("policy — malformed id still gets the engine's usual 400, not a policy-specific failure", () => {
  it("coerces the id before the policy pre-fetch runs", async () => {
    const { crud, adapter } = makeCrud({ operations: { updateOne: { policy: owner("authorId") } } } as never);
    adapter.rows.push({
      id: 1,
      title: "a",
      authorId: "u-1",
      author: null,
      comments: [],
      deletedAt: null,
    } as unknown as Post);
    const call = crud.updateOne("not-a-number" as never, { title: "x" } as never, { principal: OWNER });
    await expect(call).rejects.toMatchObject({
      code: "KAVO_QUERY_INVALID",
      issues: [expect.objectContaining({ code: "KAVO_QUERY_INVALID_VALUE" })],
    });
  });
});

describe("policy — restoreOne/purgeOne pre-fetch sees soft-deleted rows", () => {
  it("evaluates owner() on restoreOne against the soft-deleted row instead of always 404ing", async () => {
    const { crud, adapter } = makeAccountCrud({
      softDelete: { strategy: "soft" },
      operations: { restoreOne: { policy: owner("name") } },
    } as never);
    await crud.createOne({ name: "u-1" } as never);
    await crud.deleteOne(1);

    await expect(crud.restoreOne(1, { principal: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(crud.restoreOne(1, { principal: OWNER })).resolves.toMatchObject({ id: 1, name: "u-1" });
    expect(adapter.rows[0]!.deletedAt).toBeNull();
  });

  it("evaluates owner() on purgeOne against the soft-deleted row instead of always 404ing", async () => {
    const { crud, adapter } = makeAccountCrud({
      softDelete: { strategy: "soft" },
      operations: { purgeOne: { enabled: true, policy: owner("name") } },
    } as never);
    await crud.createOne({ name: "u-1" } as never);
    await crud.deleteOne(1);

    await expect(crud.purgeOne(1, { principal: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
    await crud.purgeOne(1, { principal: OWNER });
    expect(adapter.rows).toHaveLength(0);
  });
});

describe("policy — cache never lets a policy-gated findOne outlive its own check", () => {
  it("re-evaluates a context-only findOne policy on every call, cache hit or not", async () => {
    const { crud } = makeCrud({
      cache: { ttl: 60 },
      operations: { findOne: { policy: permission("post:read") } },
    } as never);
    const allowed = { principal: { permissions: ["post:read"] } };
    const denied = { principal: { permissions: [] } };

    // Warm the cache with an allowed principal.
    await expect(crud.findOne(1, undefined, allowed)).rejects.toBeInstanceOf(NotFoundException);
    // A denied principal must still be refused, not served whatever a
    // same-shaped cache entry might otherwise hold.
    await expect(crud.findOne(1, undefined, denied)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never caches a findOne whose policy is entity-aware, so a later denial can't be starved by a stale hit", async () => {
    const { crud, adapter } = makeCrud({
      cache: { ttl: 60 },
      operations: { findOne: { policy: owner("authorId") } },
    } as never);
    adapter.rows.push({
      id: 1,
      title: "a",
      authorId: "u-1",
      author: null,
      comments: [],
      deletedAt: null,
    } as unknown as Post);

    // The owner reads it first — if this were cached, the next call would
    // reuse this response instead of re-checking ownership.
    await expect(crud.findOne(1, undefined, { principal: OWNER })).resolves.toMatchObject({ title: "a" });
    await expect(crud.findOne(1, undefined, { principal: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("policy — authorization.required default-deny switch (ADR-0035)", () => {
  it("off (the default) leaves an operation with no policy entry unrestricted", async () => {
    const { crud, adapter } = makeCrud();
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await expect(crud.updateOne(1, { title: "b" } as never)).resolves.toMatchObject({ title: "b" });
  });

  it("entity-level required:true denies a standard operation with no policy entry, before the adapter is ever touched", async () => {
    const { crud, adapter } = makeCrud({ authorization: { required: true } } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    const call = crud.updateOne(1, { title: "b" } as never);
    await expect(call).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_FORBIDDEN", status: 403 });
    // The pre-fetch/cache/write path never ran — lastQuery stays whatever
    // pushing the fixture row left it as (never set by a read).
    expect(adapter.lastQuery).toBeNull();
    expect(adapter.rows[0]!.title).toBe("a");
  });

  it("required:true denies every standard operation left unconfigured, not just one", async () => {
    const { crud } = makeCrud({ authorization: { required: true } } as never);
    await expect(crud.createOne({ title: "x", authorId: "u-1" } as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(crud.findMany(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(crud.findOne(1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a global 'defaults: { authorization: { required: true } }' opts every entity in", async () => {
    const { crud } = makeCrud(undefined, { defaults: { authorization: { required: true } } });
    await expect(crud.findMany(undefined)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("an explicit policy.<id> entry still governs when required is true — it isn't overridden", async () => {
    const { crud, adapter } = makeCrud({
      authorization: { required: true },
      operations: { updateOne: { policy: permission("post:update") } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    await expect(
      crud.updateOne(1, { title: "x" } as never, { principal: { permissions: ["post:update"] } }),
    ).resolves.toMatchObject({ title: "x" });
    await expect(crud.updateOne(1, { title: "x" } as never, { principal: { permissions: [] } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("an explicit entity-aware findOne policy still governs when required is true — the deferred check isn't shadowed by the default-deny branch", async () => {
    const { crud, adapter } = makeCrud({
      authorization: { required: true },
      operations: { findOne: { policy: owner("authorId") } },
    } as never);
    adapter.rows.push({
      id: 1,
      title: "a",
      authorId: "u-1",
      author: null,
      comments: [],
      deletedAt: null,
    } as unknown as Post);

    // The owner still passes — required:true must not have hoisted the
    // default-deny check ahead of (or in place of) the deferred owner()
    // evaluation checkFindOnePolicy runs against the row the handler
    // already fetched.
    await expect(crud.findOne(1, undefined, { principal: OWNER })).resolves.toMatchObject({ title: "a" });
    await expect(crud.findOne(1, undefined, { principal: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("operations.<id>.authorization overrides the entity-level default per operation", async () => {
    const { crud } = makeCrud({
      authorization: { required: true },
      operations: { findMany: { authorization: { required: false } } },
    } as never);
    await expect(crud.findMany(undefined)).resolves.toMatchObject({ items: [] });
    await expect(crud.findOne(1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a custom operation is unaffected by required:true — it never reaches the policy stage", async () => {
    const { crud, adapter } = makeCrud({
      authorization: { required: true },
      operations: {
        promoteOne: {
          handler: {
            async execute() {
              return adapter.rows[0] ?? null;
            },
          },
        },
      },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await expect(crud.run("promoteOne" as never, { id: 1 } as never)).resolves.toMatchObject({ title: "a" });
  });

  it("a per-call settings override cannot loosen required:true", async () => {
    const { crud } = makeCrud({ authorization: { required: true } } as never);
    await expect(
      crud.findMany(undefined, { settings: { authorization: { required: false } } } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a per-call settings override cannot tighten required:false either — the subtree is pinned, not merged", async () => {
    const { crud } = makeCrud();
    await expect(
      crud.findMany(undefined, { settings: { authorization: { required: true } } } as never),
    ).resolves.toMatchObject({ items: [] });
  });

  it("rejects a non-boolean authorization.required at bootstrap", () => {
    expect(() => makeCrud({ authorization: { required: "yes" } } as never)).toThrowError(ConfigurationException);
  });

  it("also gates a Kavo-synthesized array-mutation operation (replace<Relation>) — it can never carry a policy.<id> entry of its own", async () => {
    const { crud } = makeAuthorCrud({ authorization: { required: true } } as never);
    const call = crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: [2, 3] as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_FORBIDDEN", status: 403 });
  });

  it("leaves an array-mutation operation alone when required is off (the default) — the gate only adds a restriction, it changes nothing else", async () => {
    const { crud, adapter } = makeAuthorCrud();
    const response = await crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: [2, 3] as never,
      query: null,
      options: null,
    } as never);
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
    expect(adapter.rows[0]).toMatchObject({ posts: [2, 3] });
  });
});

describe("policy — filtered() requires a query filter on a given field", () => {
  it("denies findMany when the required filter is absent", async () => {
    const { crud } = makeCrud({ operations: { findMany: { policy: filtered("authorId") } } } as never);
    await expect(crud.findMany(undefined)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows findMany when the filter is present, anywhere in the AST", async () => {
    const { crud } = makeCrud({ operations: { findMany: { policy: filtered("authorId") } } } as never);
    await expect(
      crud.findMany({ filter: { kind: "condition", field: "authorId", operator: "EQ", value: "u-1" } } as never),
    ).resolves.toMatchObject({ items: [] });

    await expect(
      crud.findMany({
        filter: {
          kind: "group",
          operator: "AND",
          children: [
            { kind: "condition", field: "title", operator: "EQ", value: "a" },
            { kind: "condition", field: "authorId", operator: "EQ", value: "u-1" },
          ],
        },
      } as never),
    ).resolves.toMatchObject({ items: [] });
  });

  it("denies unconditionally on writes, where context.query is null", async () => {
    const { crud, adapter } = makeCrud({ operations: { updateOne: { policy: filtered("authorId") } } } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await expect(crud.updateOne(1, { title: "x" } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("is not entity-aware — policyNeedsEntity reports false", () => {
    expect(policyNeedsEntity(filtered("authorId"))).toBe(false);
  });
});

describe("policyNeedsEntity", () => {
  it("recurses through not()", () => {
    expect(policyNeedsEntity(not(owner("authorId")))).toBe(true);
    expect(policyNeedsEntity(not(permission("post:update")))).toBe(false);
  });
});
