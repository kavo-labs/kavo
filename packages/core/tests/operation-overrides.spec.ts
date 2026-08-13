import { describe, expect, it } from "vitest";
import type { KavoContext, EntityId, NormalizedQueryContext, RepositoryAdapter } from "@kavo/core";
import { createKavo } from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";

/**
 * Counts calls per adapter method, delegating actual persistence to the
 * shared in-memory fixture — the seam this suite watches to prove an
 * override *replaces* the built-in handler rather than merely running
 * alongside it (issue #21: overriding all five singular standard
 * operations, plus a custom operation, on one entity).
 */
class CountingUserAdapter implements RepositoryAdapter<User> {
  readonly calls: Record<keyof RepositoryAdapter<User>, number> = {
    findOneById: 0,
    findOne: 0,
    findMany: 0,
    count: 0,
    create: 0,
    update: 0,
    patch: 0,
    delete: 0,
    restore: 0,
    purge: 0,
    replaceRelation: 0,
  };

  constructor(private readonly inner: InMemoryUserAdapter = new InMemoryUserAdapter()) {}

  async findOneById(
    id: EntityId,
    _query: NormalizedQueryContext<User> | null,
    _context: KavoContext<User>,
  ): Promise<User | null> {
    this.calls.findOneById++;
    return this.inner.findOneById(id);
  }

  async findOne(query: NormalizedQueryContext<User>, _context: KavoContext<User>): Promise<User | null> {
    this.calls.findOne++;
    return this.inner.findOne(query);
  }

  async findMany(query: NormalizedQueryContext<User>, _context: KavoContext<User>): Promise<readonly User[]> {
    this.calls.findMany++;
    return this.inner.findMany(query);
  }

  async count(query: NormalizedQueryContext<User>, _context: KavoContext<User>): Promise<number> {
    this.calls.count++;
    return this.inner.count(query);
  }

  async create(data: Partial<User>, _context: KavoContext<User>): Promise<User> {
    this.calls.create++;
    return this.inner.create(data);
  }

  async update(id: EntityId, data: Partial<User>, _context: KavoContext<User>): Promise<User> {
    this.calls.update++;
    return this.inner.update(id, data);
  }

  async patch(id: EntityId, data: Partial<User>, _context: KavoContext<User>): Promise<User> {
    this.calls.patch++;
    return this.inner.patch(id, data);
  }

  async delete(id: EntityId, _context: KavoContext<User>): Promise<void> {
    this.calls.delete++;
    await this.inner.delete(id);
  }

  async restore(_id: EntityId, _context: KavoContext<User>): Promise<User> {
    this.calls.restore++;
    return this.inner.restore();
  }

  async purge(id: EntityId, _context: KavoContext<User>): Promise<void> {
    this.calls.purge++;
    await this.inner.purge(id);
  }
}

function makeCrud(config: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1]) {
  const adapter = new CountingUserAdapter();
  const crud = createKavo().createCrud(User, config as never, { adapter, metadata: userMetadata });
  return { crud, adapter };
}

const ADA = { name: "Ada", email: "ada@example.com", age: 36, status: "active" as const };

describe("EntityConfig.operations — overriding every singular standard operation at once (issue #21)", () => {
  it("replaces createOne: the override runs, the built-in adapter.create never does", async () => {
    const sentinel = Object.assign(new User(), { id: 999, name: "from override" });
    const { crud, adapter } = makeCrud({
      operations: {
        createOne: {
          handler: {
            async execute() {
              return sentinel;
            },
          },
        },
      },
    });

    const result = await crud.createOne(ADA as never);
    expect(result).toMatchObject({ id: 999, name: "from override" });
    expect(adapter.calls.create).toBe(0);
  });

  it("replaces findOne: the override runs, the built-in adapter.findOneById never does", async () => {
    const sentinel = Object.assign(new User(), { id: 5, name: "found by override" });
    const { crud, adapter } = makeCrud({
      operations: {
        findOne: {
          handler: {
            async execute() {
              return sentinel;
            },
          },
        },
      },
    });

    const result = await crud.findOne(5);
    expect(result).toMatchObject({ id: 5, name: "found by override" });
    expect(adapter.calls.findOneById).toBe(0);
  });

  it("replaces updateOne: the override runs, the built-in adapter.update never does", async () => {
    const sentinel = Object.assign(new User(), { id: 1, name: "updated by override" });
    const { crud, adapter } = makeCrud({
      operations: {
        updateOne: {
          handler: {
            async execute() {
              return sentinel;
            },
          },
        },
      },
    });

    const result = await crud.updateOne(1, { name: "ignored" } as never);
    expect(result).toMatchObject({ id: 1, name: "updated by override" });
    expect(adapter.calls.update).toBe(0);
  });

  it("replaces patchOne: the override runs, the built-in adapter.patch never does", async () => {
    const sentinel = Object.assign(new User(), { id: 1, name: "patched by override" });
    const { crud, adapter } = makeCrud({
      operations: {
        patchOne: {
          handler: {
            async execute() {
              return sentinel;
            },
          },
        },
      },
    });

    const result = await crud.patchOne(1, { name: "ignored" } as never);
    expect(result).toMatchObject({ id: 1, name: "patched by override" });
    expect(adapter.calls.patch).toBe(0);
  });

  it("replaces deleteOne: the override runs, the built-in adapter.delete never does", async () => {
    let ran = false;
    const { crud, adapter } = makeCrud({
      operations: {
        deleteOne: {
          handler: {
            async execute() {
              ran = true;
              return null;
            },
          },
        },
      },
    });

    await crud.deleteOne(1);
    expect(ran).toBe(true);
    expect(adapter.calls.delete).toBe(0);
  });

  it("overrides all five singular standard operations on one entity", async () => {
    const calls: string[] = [];
    const overrideHandler = (id: string) => ({
      async execute() {
        calls.push(id);
        return Object.assign(new User(), { id: 1, name: id });
      },
    });

    const { crud, adapter } = makeCrud({
      operations: {
        createOne: { handler: overrideHandler("createOne") },
        findOne: { handler: overrideHandler("findOne") },
        updateOne: { handler: overrideHandler("updateOne") },
        patchOne: { handler: overrideHandler("patchOne") },
        deleteOne: {
          handler: {
            async execute() {
              calls.push("deleteOne");
              return null;
            },
          },
        },
      },
    });

    await crud.createOne(ADA as never);
    await crud.findOne(1);
    await crud.updateOne(1, {} as never);
    await crud.patchOne(1, {} as never);
    await crud.deleteOne(1);

    expect(calls).toEqual(["createOne", "findOne", "updateOne", "patchOne", "deleteOne"]);
    // None of the overridden built-ins ever touched the adapter — the
    // registry dispatched straight to the replacement handlers (ADR-0006).
    expect(adapter.calls).toMatchObject({ create: 0, findOneById: 0, update: 0, patch: 0, delete: 0 });
    // findMany was never overridden or called — the control surface only
    // replaced what this config named.
    expect(adapter.calls.findMany).toBe(0);
  });
});
