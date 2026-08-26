import { describe, expect, it } from "vitest";
import type { KavoOptions, Policy } from "@kavo/core";
import { ConfigurationException, ForbiddenException, NotFoundException, createKavo } from "@kavo/core";
import type { EntityId, KavoContext } from "@kavo/core";
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
    if (row === null) {
      throw new Error("fixture: row not found");
    }
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

/** Reads `permissions`/`roles` off `context.principal` — apps write this shape themselves; Kavo has no built-in principal type. */
interface Principal {
  readonly userId?: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
}

function principalOf<Entity>(context: KavoContext<Entity>): Principal {
  return (context.principal as Principal | null | undefined) ?? {};
}

function hasPermission<Entity>(name: string): Policy<Entity> {
  return ({ context }) => (principalOf(context).permissions ?? []).includes(name);
}

function hasRole<Entity>(name: string): Policy<Entity> {
  return ({ context }) => (principalOf(context).roles ?? []).includes(name);
}

function isAuthenticated<Entity>(): Policy<Entity> {
  return ({ context }) => principalOf(context).userId != null;
}

function isOwner<Entity>(field: string): Policy<Entity> {
  return ({ context, entity }) => {
    const principal = principalOf(context);
    if (principal.userId == null || entity === undefined) {
      return false;
    }
    return (entity as unknown as Record<string, unknown>)[field] === principal.userId;
  };
}

describe("policy — a plain function per operation", () => {
  it("allows a call carrying the required permission", async () => {
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: hasPermission("post:update") } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    const updated = await crud.updateOne(1, { title: "b" } as never, {
      principal: { permissions: ["post:update"] },
    });
    expect(updated).toMatchObject({ title: "b" });
  });

  it("denies a call missing the required permission with KAVO_FORBIDDEN (403)", async () => {
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: hasPermission("post:update") } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    const call = crud.updateOne(1, { title: "b" } as never, { principal: { permissions: [] } });
    await expect(call).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_FORBIDDEN", status: 403 });
  });

  it("combines multiple conditions with ordinary &&", async () => {
    const policy: Policy<Post> = ({ context }) => {
      const principal = principalOf(context);
      return (principal.permissions ?? []).includes("post:delete") && (principal.permissions ?? []).includes("admin");
    };
    const { crud, adapter } = makeCrud({ operations: { deleteOne: { policy } } } as never);
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

  it("an owner-style check reads the loaded entity against principal.userId", async () => {
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: isOwner<Post>("authorId") } },
    } as never);
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

  it("composes role/permission/ownership/negation by hand — admin bypasses ownership, a banned owner is still denied", async () => {
    const policy: Policy<Post> = (args) => {
      if (hasRole<Post>("admin")(args)) {
        return true;
      }
      if (hasRole<Post>("banned")(args)) {
        return false;
      }
      return hasPermission<Post>("post:update")(args) && isOwner<Post>("authorId")(args);
    };
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

  it("checks principal.userId presence for authentication", async () => {
    const { crud } = makeCrud({ operations: { createOne: { policy: isAuthenticated() } } } as never);
    await expect(crud.createOne({ title: "x", authorId: "u-1" } as never, { principal: null })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(crud.createOne({ title: "x", authorId: "u-1" } as never, { principal: OWNER })).resolves.toMatchObject(
      { title: "x" },
    );
  });

  it("runs an arbitrary predicate against context and the loaded entity", async () => {
    const { crud, adapter } = makeCrud({
      operations: {
        updateOne: { policy: (({ entity }) => entity?.title !== "locked") as Policy<Post> },
      },
    } as never);
    adapter.rows.push({ id: 1, title: "locked", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await expect(crud.updateOne(1, { title: "x" } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("receives resource, operation, and params.id alongside context and entity", async () => {
    let seen: { resource: string; operation: string; id: unknown } | undefined;
    const { crud, adapter } = makeCrud({
      operations: {
        updateOne: {
          policy: (({ resource, operation, params }) => {
            seen = { resource, operation, id: params.id };
            return true;
          }) as Policy<Post>,
        },
      },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    await expect(crud.updateOne(1, { title: "x" } as never)).resolves.toMatchObject({ title: "x" });
    expect(seen).toEqual({ resource: "Post", operation: "updateOne", id: 1 });
  });

  it("sees params.id coerced to the id column's kind, not the raw string a caller passed", async () => {
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: (({ params }) => params.id === 1) as Policy<Post> } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    // The string "1", not the number 1 — what an HTTP path param arrives as.
    await expect(crud.updateOne("1" as never, { title: "x" } as never)).resolves.toMatchObject({ title: "x" });
  });

  it("on findOne (the deferred path) also receives params.id, coerced", async () => {
    const { crud, adapter } = makeCrud({
      operations: { findOne: { policy: (({ params }) => params.id === 1) as Policy<Post> } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    adapter.rows.push({ id: 2, title: "b", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    // The string "1" — what an HTTP path param arrives as — still matches the coerced comparison.
    await expect(crud.findOne("1" as never)).resolves.toMatchObject({ title: "a" });
    await expect(crud.findOne(2)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("policy — single-row operations always get the loaded entity", () => {
  it("findOne evaluates the policy against the row it already fetched, and 404s before 403 for a missing row", async () => {
    const { crud } = makeCrud({
      operations: { findOne: { policy: isOwner<Post>("authorId") } },
    } as never);
    await expect(crud.findOne(1, undefined, { principal: OWNER })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updateOne pre-fetches the row before the policy runs, independent of what the handler itself does", async () => {
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: isOwner<Post>("authorId") } },
    } as never);
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

  it("404s rather than 403 for a checked id that doesn't exist", async () => {
    const { crud } = makeCrud({
      operations: { updateOne: { policy: isOwner<Post>("authorId") } },
    } as never);
    await expect(crud.updateOne(999, { title: "x" } as never, { principal: OWNER })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("pre-fetches even for a policy that never reads entity — the engine can't know it doesn't need it", async () => {
    let sawEntity: unknown;
    const policy: Policy<Post> = ({ entity }) => {
      sawEntity = entity;
      return true;
    };
    const { crud, adapter } = makeCrud({ operations: { updateOne: { policy } } } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await crud.updateOne(1, { title: "x" } as never);
    expect(sawEntity).toMatchObject({ id: 1 });
  });

  it("404s rather than 403 for a missing row even under a context-only policy that would have denied anyway", async () => {
    // Uniform, intentional behavior (ADR-0036): since the engine can no longer
    // tell a context-only policy from a row-dependent one, a missing row
    // always answers 404 ahead of the policy — extending what was already
    // true for owner-style checks (the test above) to every policy.
    const { crud } = makeCrud({
      operations: { deleteOne: { policy: (() => false) as Policy<Post> } },
    } as never);
    await expect(crud.deleteOne(999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("createOne and findMany always call the policy with entity: undefined — there is no single row for either", async () => {
    const seen: unknown[] = [];
    const capture: Policy<Post> = ({ entity }) => {
      seen.push(entity);
      return true;
    };
    const { crud } = makeCrud({
      operations: { createOne: { policy: capture }, findMany: { policy: capture } },
    } as never);
    await crud.createOne({ title: "x", authorId: "u-1" } as never);
    await crud.findMany(undefined);
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe("policy — bootstrap validation", () => {
  it("rejects a non-function reaching 'operations.<id>.policy' at runtime, since TypeScript can't catch a JS or dynamically-built config", () => {
    expect(() => makeCrud({ operations: { updateOne: { policy: "post:update" } } } as never)).toThrowError(
      ConfigurationException,
    );
    try {
      makeCrud({ operations: { updateOne: { policy: "post:update" } } } as never);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as ConfigurationException).detail).toContain("operations.updateOne.policy");
    }
  });

  it("rejects a non-function reaching the entity-level 'policy' default — including the pre-ADR-0033 per-operation map shape", () => {
    expect(() => makeCrud({ policy: { updateOne: () => false } } as never)).toThrowError(ConfigurationException);
    try {
      makeCrud({ policy: { updateOne: () => false } } as never);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID" });
      expect((error as ConfigurationException).detail).toContain("at 'policy'");
      expect((error as ConfigurationException).detail).toContain("must be a function");
    }
  });

  it("rejects a non-function entity-level 'policy' value that is an empty object", () => {
    expect(() => makeCrud({ policy: {} } as never)).toThrowError(ConfigurationException);
  });

  it("lets 'policy: undefined' through at entity level — an unset key isn't presence", () => {
    expect(() => makeCrud({ policy: undefined } as never)).not.toThrow();
  });

  it("rejects a non-function reaching the global (createKavo) 'policy' default the same way", () => {
    expect(() => makeCrud(undefined, { policy: { updateOne: () => false } } as never)).toThrowError(
      ConfigurationException,
    );
  });
});

describe("policy — entity-level and global default (ADR-0037)", () => {
  it("an entity-level default policy applies to every operation that configures none of its own", async () => {
    const { crud, adapter } = makeCrud({ policy: isAuthenticated<Post>() } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    await expect(crud.updateOne(1, { title: "b" } as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(crud.updateOne(1, { title: "b" } as never, { principal: OWNER })).resolves.toMatchObject({
      title: "b",
    });
    await expect(crud.findMany(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(crud.findMany(undefined, { principal: OWNER })).resolves.toMatchObject({
      items: [{ title: "b" }],
    });
  });

  it("operations.<id>.policy overrides an inherited entity-level default with a different rule", async () => {
    const { crud, adapter } = makeCrud({
      policy: isAuthenticated<Post>(),
      operations: { findMany: true, updateOne: { policy: hasPermission<Post>("post:update") } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    // Merely authenticated is not enough for updateOne: its own rule wins.
    await expect(crud.updateOne(1, { title: "b" } as never, { principal: OWNER })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      crud.updateOne(1, { title: "b" } as never, { principal: { permissions: ["post:update"] } }),
    ).resolves.toMatchObject({ title: "b" });
    // findMany still falls back to the entity-level default.
    await expect(crud.findMany(undefined)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("operations.<id>.policy: false opts one operation out of an inherited entity-level default", async () => {
    const { crud } = makeCrud({
      policy: isAuthenticated<Post>(),
      operations: { createOne: true, findMany: { policy: false } },
    } as never);
    await expect(crud.findMany(undefined)).resolves.toMatchObject({ items: [] });
    await expect(crud.createOne({ title: "x", authorId: "u-1" } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a global (createKavo) default policy applies when neither entity nor operation configures one", async () => {
    const { crud, adapter } = makeCrud(undefined, { policy: isAuthenticated() });
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await expect(crud.updateOne(1, { title: "b" } as never)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(crud.updateOne(1, { title: "b" } as never, { principal: OWNER })).resolves.toMatchObject({
      title: "b",
    });
  });

  it("operations.<id>.policy: false opts an operation out of an inherited global default", async () => {
    const { crud } = makeCrud({ operations: { createOne: true, findMany: { policy: false } } } as never, {
      policy: isAuthenticated(),
    });
    await expect(crud.findMany(undefined)).resolves.toMatchObject({ items: [] });
    await expect(crud.createOne({ title: "x", authorId: "u-1" } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("precedence is nearest-defined-wins: operation over entity over global", async () => {
    const { crud, adapter } = makeCrud(
      {
        policy: hasPermission<Post>("entity:default"),
        operations: { findMany: true, updateOne: { policy: hasPermission<Post>("operation:override") } },
      } as never,
      { policy: hasPermission("global:default") },
    );
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    // updateOne: operation-level wins over both entity and global.
    await expect(
      crud.updateOne(1, { title: "b" } as never, { principal: { permissions: ["operation:override"] } }),
    ).resolves.toMatchObject({ title: "b" });
    await expect(
      crud.updateOne(1, { title: "b" } as never, { principal: { permissions: ["entity:default"] } }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // findMany has no operation-level entry: entity-level wins over global.
    await expect(crud.findMany(undefined, { principal: { permissions: ["entity:default"] } })).resolves.toMatchObject({
      items: [{ title: "b" }],
    });
    await expect(crud.findMany(undefined, { principal: { permissions: ["global:default"] } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("an inherited entity-level default still always pre-fetches the row for a single-row operation", async () => {
    let sawEntity: unknown;
    const policy: Policy<Post> = ({ entity }) => {
      sawEntity = entity;
      return true;
    };
    const { crud, adapter } = makeCrud({ policy } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await crud.updateOne(1, { title: "x" } as never);
    expect(sawEntity).toMatchObject({ id: 1 });
  });

  it("an inherited entity-level default on createOne/findMany still gets entity: undefined", async () => {
    const seen: unknown[] = [];
    const capture: Policy<Post> = ({ entity }) => {
      seen.push(entity);
      return true;
    };
    const { crud } = makeCrud({ policy: capture } as never);
    await crud.createOne({ title: "x", authorId: "u-1" } as never);
    await crud.findMany(undefined);
    expect(seen).toEqual([undefined, undefined]);
  });
});

describe("policy — findOne: the deny branch on an existing row", () => {
  it("denies findOne against a row that exists but fails the policy", async () => {
    const { crud, adapter } = makeCrud({
      operations: { findOne: { policy: isOwner<Post>("authorId") } },
    } as never);
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
    const { crud } = makeCrud({
      operations: { findMany: { policy: hasPermission("post:list") } },
    } as never);
    await expect(crud.findMany(undefined, { principal: { permissions: [] } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(crud.findMany(undefined, { principal: { permissions: ["post:list"] } })).resolves.toMatchObject({
      items: [],
    });
  });

  it("evaluates an owner-style check on patchOne", async () => {
    const { crud, adapter } = makeCrud({
      operations: { patchOne: { policy: isOwner<Post>("authorId") } },
    } as never);
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
  it("denies (never throws) when options.principal is simply omitted", async () => {
    const policy: Policy<Post> = (args) => {
      const principal = principalOf(args.context);
      return (
        (principal.permissions ?? []).includes("post:update") ||
        (principal.roles ?? []).includes("admin") ||
        isOwner<Post>("authorId")(args)
      );
    };
    const { crud, adapter } = makeCrud({ operations: { updateOne: { policy } } } as never);
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
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: isOwner<Post>("authorId") } },
    } as never);
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
  it("evaluates an owner-style check on restoreOne against the soft-deleted row instead of always 404ing", async () => {
    const { crud, adapter } = makeAccountCrud({
      softDelete: { strategy: "soft" },
      operations: { createOne: true, deleteOne: true, restoreOne: { policy: isOwner<Account>("name") } },
    } as never);
    await crud.createOne({ name: "u-1" } as never);
    await crud.deleteOne(1);

    await expect(crud.restoreOne(1, { principal: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(crud.restoreOne(1, { principal: OWNER })).resolves.toMatchObject({ id: 1, name: "u-1" });
    expect(adapter.rows[0]!.deletedAt).toBeNull();
  });

  it("evaluates an owner-style check on purgeOne against the soft-deleted row instead of always 404ing", async () => {
    const { crud, adapter } = makeAccountCrud({
      softDelete: { strategy: "soft" },
      operations: { createOne: true, deleteOne: true, purgeOne: { policy: isOwner<Account>("name") } },
    } as never);
    await crud.createOne({ name: "u-1" } as never);
    await crud.deleteOne(1);

    await expect(crud.purgeOne(1, { principal: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
    await crud.purgeOne(1, { principal: OWNER });
    expect(adapter.rows).toHaveLength(0);
  });
});

describe("policy — cache never lets a policy-gated findOne outlive its own check", () => {
  it("re-evaluates a findOne policy on every call, cache hit or not", async () => {
    const { crud, adapter } = makeCrud({
      cache: { ttl: 60 },
      operations: { findOne: { policy: hasPermission("post:read") } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    const allowed = { principal: { permissions: ["post:read"] } };
    const denied = { principal: { permissions: [] } };

    // Warm the cache with an allowed principal.
    await expect(crud.findOne(1, undefined, allowed)).resolves.toMatchObject({ title: "a" });
    // A denied principal must still be refused, not served whatever a
    // same-shaped cache entry might otherwise hold.
    await expect(crud.findOne(1, undefined, denied)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("never caches a findOne with a configured policy, so a later denial can't be starved by a stale hit", async () => {
    const { crud, adapter } = makeCrud({
      cache: { ttl: 60 },
      operations: { findOne: { policy: isOwner<Post>("authorId") } },
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
      operations: { updateOne: { policy: hasPermission("post:update") } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);

    await expect(
      crud.updateOne(1, { title: "x" } as never, { principal: { permissions: ["post:update"] } }),
    ).resolves.toMatchObject({ title: "x" });
    await expect(crud.updateOne(1, { title: "x" } as never, { principal: { permissions: [] } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("an explicit findOne policy still governs when required is true — the deferred check isn't shadowed by the default-deny branch", async () => {
    const { crud, adapter } = makeCrud({
      authorization: { required: true },
      operations: { findOne: { policy: isOwner<Post>("authorId") } },
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
    // default-deny check ahead of (or in place of) the deferred evaluation
    // checkFindOnePolicy runs against the row the handler already fetched.
    await expect(crud.findOne(1, undefined, { principal: OWNER })).resolves.toMatchObject({ title: "a" });
    await expect(crud.findOne(1, undefined, { principal: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("operations.<id>.authorization overrides the entity-level default per operation", async () => {
    const { crud } = makeCrud({
      authorization: { required: true },
      operations: { findOne: true, findMany: { authorization: { required: false } } },
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
      body: [{ id: 2 }, { id: 3 }] as never,
      query: null,
      options: null,
    } as never);
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
    expect(adapter.rows[0]).toMatchObject({ posts: [2, 3] });
  });
});

describe("policy — a required query filter, expressed inside the function", () => {
  const requiresFilter = <Entity>(field: string): Policy<Entity> => {
    const filterHasField = (expression: unknown): boolean => {
      if (expression === null || typeof expression !== "object") {
        return false;
      }
      const node = expression as { kind: string; field?: string; children?: readonly unknown[] };
      if (node.kind === "condition") {
        return node.field === field;
      }
      return (node.children ?? []).some(filterHasField);
    };
    return ({ context }) => filterHasField(context.query?.filter.root ?? null);
  };

  it("denies findMany when the required filter is absent", async () => {
    const { crud } = makeCrud({
      operations: { findMany: { policy: requiresFilter("authorId") } },
    } as never);
    await expect(crud.findMany(undefined)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows findMany when the filter is present, anywhere in the AST", async () => {
    const { crud } = makeCrud({
      operations: { findMany: { policy: requiresFilter("authorId") } },
    } as never);
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
    const { crud, adapter } = makeCrud({
      operations: { updateOne: { policy: requiresFilter("authorId") } },
    } as never);
    adapter.rows.push({ id: 1, title: "a", authorId: 0, author: null, comments: [], deletedAt: null } as Post);
    await expect(crud.updateOne(1, { title: "x" } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
