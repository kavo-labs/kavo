import { describe, expect, it } from "vitest";
import type {
  KavoContext,
  KavoEngine,
  KavoRequest,
  KavoResponse,
  EntityId,
  NormalizedQueryContext,
  OperationId,
  RepositoryAdapter,
  TransactionContext,
} from "@kavo/core";
import {
  ConfigurationException,
  DefaultKavoService,
  NotFoundException,
  OperationDisabledException,
  WireQuery,
  createCrud,
  createKavo,
} from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";

/**
 * Captures the `KavoRequest` each typed method builds and answers with one
 * canned envelope. The pipeline behind the engine is engine.spec's
 * subject; what this pins is dispatch — which operation id, and which
 * argument lands in which slot.
 */
class RecordingEngine {
  readonly requests: KavoRequest<User>[] = [];

  constructor(private readonly response: KavoResponse) {}

  async execute(request: KavoRequest<User>): Promise<KavoResponse> {
    this.requests.push(request);
    return this.response;
  }
}

const ITEM = { id: 1, name: "Ada" };
const LIST = { items: [ITEM], limit: 20, offset: 0, total: 1, meta: {} };

function recorded(): { service: DefaultKavoService<User>; engine: RecordingEngine } {
  const engine = new RecordingEngine({
    operation: "recorded",
    item: ITEM,
    list: LIST,
    etag: null,
    notModified: false,
  });
  return {
    service: new DefaultKavoService<User>(engine as unknown as KavoEngine<User>),
    engine,
  };
}

function sole(engine: RecordingEngine): KavoRequest<User> {
  expect(engine.requests).toHaveLength(1);
  return engine.requests[0]!;
}

/** Every typed method, called with an id/body/query where it takes one. */
const CALLS: readonly {
  operation: OperationId;
  call: (service: DefaultKavoService<User>, options: object) => Promise<unknown>;
}[] = [
  { operation: "createOne", call: (service, options) => service.createOne({} as never, options) },
  { operation: "findOne", call: (service, options) => service.findOne(1, undefined, options) },
  { operation: "findMany", call: (service, options) => service.findMany(undefined, options) },
  { operation: "updateOne", call: (service, options) => service.updateOne(1, {} as never, options) },
  { operation: "patchOne", call: (service, options) => service.patchOne(1, {} as never, options) },
  { operation: "deleteOne", call: (service, options) => service.deleteOne(1, options) },
  { operation: "restoreOne", call: (service, options) => service.restoreOne(1, options) },
  { operation: "purgeOne", call: (service, options) => service.purgeOne(1, options) },
];

/**
 * Records the `KavoContext` every adapter call receives, delegating the
 * persistence itself to the shared in-memory fixture. `principal` and
 * `transaction` are opaque to core, so the adapter boundary is the only
 * place their arrival can be observed at all.
 */
class ContextRecordingAdapter implements RepositoryAdapter<User> {
  readonly contexts: KavoContext<User>[] = [];

  constructor(private readonly inner: RepositoryAdapter<User> = new InMemoryUserAdapter()) {}

  get last(): KavoContext<User> {
    const context = this.contexts[this.contexts.length - 1];
    if (context === undefined) throw new Error("the adapter was never called");
    return context;
  }

  async findOneById(
    id: EntityId,
    query: NormalizedQueryContext<User> | null,
    context: KavoContext<User>,
  ): Promise<User | null> {
    this.contexts.push(context);
    return this.inner.findOneById(id, query, context);
  }

  async findOne(query: NormalizedQueryContext<User>, context: KavoContext<User>): Promise<User | null> {
    this.contexts.push(context);
    return this.inner.findOne(query, context);
  }

  async findMany(query: NormalizedQueryContext<User>, context: KavoContext<User>): Promise<readonly User[]> {
    this.contexts.push(context);
    return this.inner.findMany(query, context);
  }

  async count(query: NormalizedQueryContext<User>, context: KavoContext<User>): Promise<number> {
    this.contexts.push(context);
    return this.inner.count(query, context);
  }

  async create(data: Partial<User>, context: KavoContext<User>): Promise<User> {
    this.contexts.push(context);
    return this.inner.create(data, context);
  }

  async update(id: EntityId, data: Partial<User>, context: KavoContext<User>): Promise<User> {
    this.contexts.push(context);
    return this.inner.update(id, data, context);
  }

  async patch(id: EntityId, data: Partial<User>, context: KavoContext<User>): Promise<User> {
    this.contexts.push(context);
    return this.inner.patch(id, data, context);
  }

  async delete(id: EntityId, context: KavoContext<User>): Promise<void> {
    this.contexts.push(context);
    await this.inner.delete(id, context);
  }

  async restore(id: EntityId, context: KavoContext<User>): Promise<User> {
    this.contexts.push(context);
    return this.inner.restore(id, context);
  }

  async purge(id: EntityId, context: KavoContext<User>): Promise<void> {
    this.contexts.push(context);
    await this.inner.purge(id, context);
  }
}

function makeCrud(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1]) {
  const adapter = new ContextRecordingAdapter();
  const crud = createKavo().createCrud(User, config as never, {
    adapter,
    metadata: userMetadata,
  }) as DefaultKavoService<User>;
  return { crud, adapter };
}

const ADA = { name: "Ada", email: "ada@example.com", age: 36 };

describe("DefaultKavoService — typed dispatch", () => {
  it("dispatches one operation id per method and forwards the same call options", async () => {
    for (const { operation, call } of CALLS) {
      const { service, engine } = recorded();
      const options = {};
      await call(service, options);
      expect(sole(engine).operation).toBe(operation);
      // Per-call scope is the last link of the precedence chain:
      // it must arrive unmerged, exactly as the caller wrote it.
      expect(sole(engine).options).toBe(options);
    }
  });

  it("sends the create body in the body slot and leaves the rest empty", async () => {
    const { service, engine } = recorded();
    const body = { name: "Ada" };
    await service.createOne(body as never);
    expect(sole(engine)).toEqual({
      operation: "createOne",
      id: null,
      body,
      query: null,
      options: null,
    });
  });

  it("sends the id and the query for findOne", async () => {
    const { service, engine } = recorded();
    const query = { limit: 5 };
    await service.findOne(7, query as never);
    expect(sole(engine)).toMatchObject({ operation: "findOne", id: 7, query, body: null });
  });

  it("sends the query alone for findMany", async () => {
    const { service, engine } = recorded();
    const query = { limit: 5 };
    await service.findMany(query as never);
    expect(sole(engine)).toMatchObject({ operation: "findMany", id: null, query, body: null });
  });

  it("sends the id and the body for the id-plus-body writes", async () => {
    for (const operation of ["updateOne", "patchOne"] as const) {
      const { service, engine } = recorded();
      const body = { name: "Ada" };
      await service[operation](7, body as never);
      expect(sole(engine)).toMatchObject({ operation, id: 7, body, query: null });
    }
  });

  it("sends the id alone for the bodyless writes", async () => {
    for (const operation of ["deleteOne", "restoreOne", "purgeOne"] as const) {
      const { service, engine } = recorded();
      await service[operation](7);
      expect(sole(engine)).toEqual({ operation, id: 7, body: null, query: null, options: null });
    }
  });

  it("fills every slot the caller omitted with null, never undefined", async () => {
    const { service, engine } = recorded();
    await service.findMany();
    const request = sole(engine);
    expect(request.query).toBeNull();
    expect(request.options).toBeNull();
    expect(request.id).toBeNull();
    expect(Object.keys(request).sort()).toEqual(["body", "id", "operation", "options", "query"]);
  });

  it("returns the response item from every single-resource method", async () => {
    for (const operation of ["createOne", "findOne", "updateOne", "patchOne", "restoreOne"] as const) {
      const { service, engine } = recorded();
      const result =
        operation === "createOne"
          ? await service.createOne({} as never)
          : operation === "findOne" || operation === "restoreOne"
            ? await service[operation](1)
            : await service[operation](1, {} as never);
      expect(result).toBe(ITEM);
      expect(engine.requests).toHaveLength(1);
    }
  });

  it("returns the list envelope from findMany", async () => {
    const { service } = recorded();
    await expect(service.findMany()).resolves.toBe(LIST);
  });

  it("returns nothing from the void operations", async () => {
    for (const operation of ["deleteOne", "purgeOne"] as const) {
      const { service } = recorded();
      await expect(service[operation](1)).resolves.toBeUndefined();
    }
  });
});

describe("DefaultKavoService — custom-operation dispatch (issue #145)", () => {
  it("dispatches the id it was handed, with every other slot null", async () => {
    const { service, engine } = recorded();
    await service.run("markPaidOne");
    expect(sole(engine)).toEqual({
      operation: "markPaidOne",
      id: null,
      body: null,
      query: null,
      options: null,
    });
  });

  it("puts id, body and query in the slots the engine reads them from", async () => {
    const { service, engine } = recorded();
    const body = { reference: "INV-1" };
    const query = { limit: 5 };
    await service.run("markPaidOne", { id: 7, body, query } as never);
    expect(sole(engine)).toMatchObject({ operation: "markPaidOne", id: 7, body, query });
  });

  it("forwards per-call options unmerged, like every other method", async () => {
    const { service, engine } = recorded();
    const options = {};
    await service.run("markPaidOne", undefined, options);
    expect(sole(engine).options).toBe(options);
  });
});

describe("DefaultKavoService — the engine escape hatch", () => {
  it("exposes the very engine the typed methods dispatch through", () => {
    const { service, engine } = recorded();
    expect(service.engine).toBe(engine as unknown as KavoEngine<User>);
  });

  it("produces the same result as the typed method for the same request", async () => {
    class UserItemDto {
      id = 0;
      name = "";
    }
    const { crud } = makeCrud({ dto: { item: UserItemDto } } as never);
    await crud.createOne(ADA as never);

    const typed = await crud.findOne(1);
    const viaEngine = await crud.engine.execute({
      operation: "findOne",
      id: 1,
      body: null,
      query: null,
      options: null,
    });
    expect(viaEngine.item).toEqual(typed);
    // Both went through DTO resolution and serialization — one pipeline.
    expect(Object.keys(viaEngine.item as object)).toEqual(["id", "name"]);
  });

  it("honors per-call options handed straight to the engine", async () => {
    const { crud } = makeCrud();
    await crud.createOne(ADA as never);
    const response = await crud.engine.execute({
      operation: "findMany",
      id: null,
      body: null,
      query: null,
      options: { settings: { pagination: { count: false } } },
    });
    expect(response.list?.total).toBeNull();
  });

  it("does not bypass the operation control surface", async () => {
    const { crud } = makeCrud();
    await expect(
      crud.engine.execute({ operation: "restoreOne", id: 1, body: null, query: null, options: null }),
    ).rejects.toBeInstanceOf(OperationDisabledException);
  });
});

describe("KavoCallOptions — principal", () => {
  it("surfaces the caller's principal on the context, unchanged", async () => {
    const seen: KavoContext<User>[] = [];
    const { crud } = makeCrud({
      operations: {
        findMany: {
          handler: {
            async execute(_input: unknown, context: KavoContext<User>) {
              seen.push(context);
              return { entities: [], total: 0 };
            },
          },
        },
      },
    } as never);
    const principal = { sub: "user-1", roles: ["admin"] };
    await crud.engine.execute({ operation: "findMany", id: null, body: null, query: null, options: { principal } });
    expect(seen[0]?.principal).toBe(principal);
  });

  it("reaches the built-in handlers' adapter calls too", async () => {
    const { crud, adapter } = makeCrud();
    const principal = { sub: "user-1" };
    await crud.createOne(ADA as never, { principal });
    expect(adapter.last.principal).toBe(principal);
  });

  it("is scoped to the call that supplied it", async () => {
    const { crud, adapter } = makeCrud();
    const principal = { sub: "user-1" };
    await crud.createOne(ADA as never, { principal });
    await crud.createOne({ ...ADA, email: "b@x.io" } as never);
    expect(adapter.last.principal).not.toBe(principal);
  });
});

describe("KavoCallOptions — transaction (doc 07 §2)", () => {
  it("hands the adapter the transaction context byte-identical", async () => {
    const { crud, adapter } = makeCrud();
    // `handle` is the adapter's native object; core must never read into it.
    const handle = { queryRunner: Symbol("native") };
    const transaction: TransactionContext = { id: "tx-1", handle };
    await crud.createOne(ADA as never, { transaction });
    expect(adapter.last.transaction).toBe(transaction);
    expect(adapter.last.transaction?.handle).toBe(handle);
    expect(adapter.last.transaction?.id).toBe("tx-1");
  });

  it("threads the same handle through a read as through a write", async () => {
    const { crud, adapter } = makeCrud();
    const transaction: TransactionContext = { id: "tx-2", handle: { native: true } };
    await crud.createOne(ADA as never);
    await crud.findMany(undefined, { transaction });
    expect(adapter.last.transaction).toBe(transaction);
  });

  it("is null outside a transaction", async () => {
    const { crud, adapter } = makeCrud();
    await crud.createOne(ADA as never);
    expect(adapter.last.transaction).toBeNull();
  });
});

describe("KavoCallOptions — per-call settings", () => {
  it("applies the override to that call only", async () => {
    const { crud } = makeCrud();
    await crud.createOne(ADA as never);
    await expect(crud.findMany(undefined, { settings: { pagination: { count: false } } })).resolves.toMatchObject({
      total: null,
    });
    await expect(crud.findMany()).resolves.toMatchObject({ total: 1 });
  });

  it("leaves the frozen resolved config untouched", async () => {
    const { crud } = makeCrud();
    await crud.createOne(ADA as never);
    const before = crud.engine.config.settings;
    await crud.findMany(undefined, { settings: { pagination: { count: false, defaultLimit: 1 } } });
    // Config is immutable after bootstrap: an override is a parameter, so
    // even the settings *object* must be the same one.
    expect(crud.engine.config.settings).toBe(before);
    expect(crud.engine.config.settings.pagination).toMatchObject({ count: true, defaultLimit: 20 });
    expect(crud.engine.config.settingsFor("findMany").pagination.count).toBe(true);
  });

  it("validates the merged per-call view, naming the entity and key path", async () => {
    const { crud } = makeCrud();
    try {
      await crud.findMany(undefined, { settings: { pagination: { defaultLimit: 0 } } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect(error).toMatchObject({
        code: "KAVO_CONFIG_INVALID",
        messageParams: { entity: expect.stringContaining("User"), path: "pagination.defaultLimit" },
      });
    }
  });
});

describe("DefaultKavoService — query paths", () => {
  it("normalizes a typed QueryContext without coercing its values", async () => {
    const { crud, adapter } = makeCrud();
    await crud.findMany({
      filter: { kind: "condition", field: "age", operator: "GTE", value: "18" },
    } as never);
    // The programmatic caller's values are already typed, so the pipeline
    // hands them through untouched — a string stays a string.
    expect(adapter.last.query?.filter.root).toMatchObject({ operator: "GTE", value: "18" });
  });

  it("runs the wire grammar for a WireQuery marker", async () => {
    const { crud, adapter } = makeCrud();
    await crud.findMany(new WireQuery({ "filter[age][gte]": "18", limit: "5" }) as never);
    expect(adapter.last.query?.filter.root).toMatchObject({ operator: "GTE", value: 18 });
    expect(adapter.last.query?.pagination).toEqual({ limit: 5, offset: 0 });
  });

  it("treats an omitted query as an empty one, not as a missing context", async () => {
    const { crud, adapter } = makeCrud();
    await crud.findMany();
    expect(adapter.last.query).toMatchObject({
      filter: { root: null },
      sort: [],
      pagination: { limit: 20, offset: 0 },
    });
  });

  it("carries no query at all on a write", async () => {
    const { crud, adapter } = makeCrud();
    await crud.createOne(ADA as never);
    expect(adapter.last.query).toBeNull();
  });
});

describe("createCrud — the standalone zero-config front door", () => {
  // The bare `createCrud(Entity, config?, runtime)` free function, which
  // creates an implicit root instance. Every other suite goes through
  // `createKavo().createCrud(...)`, so nothing exercised the barrel export
  // adopters reach for first.
  it("round-trips a create and a read with no root instance in sight", async () => {
    const crud = createCrud(User, undefined, { adapter: new InMemoryUserAdapter(), metadata: userMetadata });

    const created = await crud.createOne(ADA as never);
    expect(created).toMatchObject({ id: 1, name: "Ada" });
    expect(await crud.findOne(1)).toMatchObject({ email: "ada@example.com" });
  });

  it("still applies an entity config passed to it", async () => {
    class UserItemDto {
      id = 0;
      name = "";
    }
    const crud = createCrud(User, { dto: { item: UserItemDto } } as never, {
      adapter: new InMemoryUserAdapter(),
      metadata: userMetadata,
    });

    const created = await crud.createOne(ADA as never);
    expect(Object.keys(created as object)).toEqual(["id", "name"]);
  });

  it("gives each call its own implicit root, which is why createKavo exists", async () => {
    // Every call builds a fresh root, so two services share nothing — not
    // the runtime they were handed and not the catalog that root owns.
    // Entities registered through separate calls cannot see each other,
    // which is why a multi-entity app wires one `createKavo` instead.
    const first = createCrud(User, undefined, { adapter: new InMemoryUserAdapter(), metadata: userMetadata });
    const second = createCrud(User, undefined, { adapter: new InMemoryUserAdapter(), metadata: userMetadata });

    await first.createOne(ADA as never);

    // A plain 404, not an incidental crash: the second service is fully
    // functional, it simply never saw the row the first one wrote.
    await expect(second.findOne(1)).rejects.toBeInstanceOf(NotFoundException);
  });
});
