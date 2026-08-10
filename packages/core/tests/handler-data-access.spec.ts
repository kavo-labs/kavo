import { describe, expect, it } from "vitest";
import type { EntityId, FindManyResult, KavoContext, RepositoryAdapter } from "@kavo/core";
import { NotFoundException, builtInHandlers, createKavo, withListMeta } from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";

/**
 * How a handler reaches persistence (ADR-0025, issue #152).
 *
 * Every config in this file is a **module-scope literal**, written where no
 * adapter, no infrastructure and no `DataSource` exist. That is not
 * stylistic: it is the situation a `@Kavo(Entity, config)` argument is
 * always in, since the decorator runs at class-definition time and the
 * infrastructure a `KavoModule.forRootAsync` factory produces does not
 * exist yet (ADR-0012). A handler that could only work by closing over an
 * adapter would be unwritable here, which is exactly the gap this seam
 * closes — so a test that built its config after `createCrud` would prove
 * nothing.
 */

function makeCrud(config: unknown, adapter = new InMemoryUserAdapter()) {
  const crud = createKavo().createCrud(User, config as never, { adapter, metadata: userMetadata });
  return { crud, adapter };
}

async function seedAda(crud: ReturnType<typeof makeCrud>["crud"]): Promise<void> {
  await crud.createOne({ name: "Ada", email: "ada@example.com", age: 36, status: "pending" } as never);
}

/** The custom operation's own request body — nothing on it is a column. */
class BanUserDto {
  reason = "";
}

/** Records the `transaction` handle the engine put on the request context. */
class TransactionRecordingAdapter extends InMemoryUserAdapter {
  seen: unknown;

  override async create(data: Partial<User>, context?: KavoContext<User>): Promise<User> {
    this.seen = context?.transaction;
    return super.create(data);
  }
}

/** The motivating shape from issue #145: load one row, write one field. */
const banConfig = {
  operations: {
    banOne: {
      dto: { input: BanUserDto },
      handler: {
        async execute(input: { id: EntityId; body: { reason: string } }, context: KavoContext<User>) {
          const existing = await context.repository.findOneById(input.id, null, context);
          if (existing === null) {
            throw new NotFoundException({
              messageParams: { entity: context.entityName, id: String(input.id) },
              context: {
                entityName: context.entityName,
                operation: context.operation,
                correlationId: context.correlationId,
              },
            });
          }
          return context.repository.patch(input.id, { status: "banned", name: input.body.reason }, context);
        },
      },
    },
  },
};

describe("KavoContext.repository — a custom handler's data access", () => {
  it("loads the target row and persists a write, with no adapter in the handler's scope", async () => {
    const { crud, adapter } = makeCrud(banConfig);
    await seedAda(crud);

    const banned = await crud.run("banOne", { id: 1, body: { reason: "spam" } } as never);

    // Serialized through the `item` slot, like any single-row response.
    expect(banned).toMatchObject({ id: 1, status: "banned", name: "spam" });
    // And it is a real write: the row itself changed, not just the response.
    expect(adapter.rows[0]).toMatchObject({ status: "banned", name: "spam" });
    expect(await crud.findOne(1)).toMatchObject({ status: "banned" });
  });

  it("raises the handler's own NotFoundException when the row is missing", async () => {
    const { crud } = makeCrud(banConfig);

    await expect(crud.run("banOne", { id: 404, body: { reason: "spam" } } as never)).rejects.toMatchObject({
      code: "KAVO_NOT_FOUND",
    });
  });

  it("carries the very adapter createCrud resolved, not a copy of it", async () => {
    // Identity matters: a handler's write has to land in the same store
    // every other operation reads from, including the `runtime.adapter`
    // override, which is how a single entity is pointed somewhere else.
    let seen: RepositoryAdapter<User> | undefined;
    const adapter = new InMemoryUserAdapter();
    const { crud } = makeCrud(
      {
        operations: {
          inspectOne: {
            handler: {
              async execute(_input: unknown, context: KavoContext<User>) {
                seen = context.repository;
                return null;
              },
            },
          },
        },
      },
      adapter,
    );

    await crud.run("inspectOne");

    expect(seen).toBe(adapter);
  });

  it("hands a read the writer half too — kind decides the request's shape, not the handler's reach", async () => {
    const { crud, adapter } = makeCrud({
      operations: {
        touchMany: {
          kind: "read",
          cardinality: "many",
          handler: {
            async execute(_input: unknown, context: KavoContext<User>): Promise<FindManyResult<User>> {
              const query = context.query;
              if (query === null) throw new Error("a read is given a normalized query");
              const entities = await context.repository.findMany(query, context);
              // A read that writes: unusual, and deliberately not refused.
              // `kind: "read"` means query resolution and no request body.
              for (const row of entities) await context.repository.patch(row.id, { age: row.age + 1 }, context);
              return { entities, total: entities.length };
            },
          },
        },
      },
    });
    await seedAda(crud);

    await crud.run("touchMany");

    expect(adapter.rows[0]?.age).toBe(37);
  });

  it("runs the handler's writes inside the caller's transaction context", async () => {
    // The handler passes the request's own context back to the adapter, so
    // `transaction` reaches the adapter exactly as it does for a built-in
    // write. Nothing in this build opens one, so the assertion is that the
    // handle arrives, not that it commits.
    const recording = new TransactionRecordingAdapter();
    const { crud } = makeCrud(
      {
        operations: {
          adoptOne: {
            handler: {
              async execute(input: Partial<User>, context: KavoContext<User>) {
                return context.repository.create(input, context);
              },
            },
          },
        },
      },
      recording,
    );
    const handle = { id: "tx-1" };

    await crud.run("adoptOne", { body: { name: "Ada" } } as never, { transaction: { handle } as never });

    expect(recording.seen).toEqual({ handle });
  });
});

describe("builtInHandlers — with and without an adapter argument", () => {
  /**
   * `withListMeta` over the built-in `findMany`, configured where no
   * adapter exists. Before ADR-0025 this needed `builtInHandlers(adapter)`,
   * which is what made the documented wrap unavailable to every app whose
   * infrastructure comes from a `forRootAsync` factory.
   */
  const listMetaConfig = {
    operations: {
      findMany: {
        handler: withListMeta(builtInHandlers<User>()("findMany"), (result: FindManyResult<User>) => ({
          banned: result.entities.filter((row) => row.status === "banned").length,
        })),
      },
    },
  };

  it("runs the built-in behavior against the request's repository when given no adapter", async () => {
    const { crud } = makeCrud(listMetaConfig);
    await seedAda(crud);

    const list = await crud.findMany();

    expect(list).toMatchObject({ items: [expect.objectContaining({ name: "Ada" })], total: 1, meta: { banned: 0 } });
  });

  it("runs against the adapter it was given, when it is given one", async () => {
    // The parameter still means something, and only this: use *that*
    // adapter — a read replica, or the fake below — rather than the
    // entity's own.
    const replica = new InMemoryUserAdapter();
    await replica.create({ name: "Grace", email: "grace@example.com", age: 45, status: "active" });
    const { crud, adapter } = makeCrud({
      operations: {
        findMany: { handler: builtInHandlers<User>(replica)("findMany") },
      },
    });
    await seedAda(crud);

    const list = await crud.findMany();

    expect(list.items).toEqual([expect.objectContaining({ name: "Grace" })]);
    expect(adapter.rows).toHaveLength(1);
  });
});
