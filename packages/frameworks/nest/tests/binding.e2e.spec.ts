import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Controller, Get, Inject, NotFoundException, Param, type INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import type {
  ClassRef,
  DefaultKavoService,
  EntityMetadata,
  FindManyResult,
  KavoContext,
  KavoInfrastructure,
  NormalizedQueryContext,
  OperationHandler,
  RepositoryAdapter,
} from "@kavo/core";
import {
  ConfigurationException,
  NotFoundException as KavoNotFoundException,
  WireQuery,
  builtInHandlers,
  withListMeta,
} from "@kavo/core";
import type { KavoModuleOptions } from "@kavo/nest";
import {
  KAVO_API_GUIDE,
  Kavo,
  KavoModule,
  Override,
  boundKavoService,
  enumProp,
  flattenQuery,
  getKavoServiceToken,
  oneOfArray,
  registerKavoSchemas,
} from "@kavo/nest";
import {
  InMemoryTodoAdapter,
  Todo,
  TodoList,
  TodoTag,
  fakeInfrastructure,
  todoMetadata,
} from "./support/fake-infrastructure.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

let app: INestApplication;
let adapter: InMemoryTodoAdapter;
let httpServer: SupertestTarget | undefined;

interface BootstrapOptions {
  readonly defaults?: KavoModuleOptions["defaults"];
  /**
   * Serve the app behind the qs-"extended" query parser (Express 4's
   * default) instead of Express 5's "simple" one — the nested-object shape
   * `flattenQuery` exists to normalize.
   */
  readonly extendedQueryParser?: boolean;
}

async function bootstrap(controller: unknown, options: BootstrapOptions = {}): Promise<void> {
  adapter = new InMemoryTodoAdapter();
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), defaults: options.defaults }),
      KavoModule.forFeature([controller as never]),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  if (options.extendedQueryParser === true) {
    (app.getHttpAdapter().getInstance() as { set(setting: string, value: string): void }).set(
      "query parser",
      "extended",
    );
  }
  httpServer = await listen(app);
}

afterEach(async () => {
  httpServer = undefined;
  await app.close();
});

/**
 * The bound server `bootstrap` listened on — not `app.getHttpServer()`,
 * which answers just as happily for an app that was only `init()`ed.
 * Cleared in `afterEach`, and re-checked on every call, so a test that
 * never reached `bootstrap` or closed the app mid-test fails here rather
 * than sending supertest back to binding a wildcard port per request
 * (issue #91) — see `boundServer` for the three shapes that covers.
 */
function server(): SupertestTarget {
  return boundServer(httpServer);
}

describe("@Kavo route generation", () => {
  @Kavo(Todo)
  @Controller("todos")
  class TodoController {}

  beforeEach(async () => {
    await bootstrap(TodoController);
  });

  it("serves the six skeleton routes end to end", async () => {
    const created = await request(server()).post("/todos").send({ title: "write docs", priority: 2 }).expect(201);
    expect(created.body).toMatchObject({ id: 1, title: "write docs" });

    await request(server()).get("/todos/1").expect(200);

    const updated = await request(server())
      .put("/todos/1")
      .send({ title: "write more docs", done: false, priority: 1 })
      .expect(200);
    expect(updated.body).toMatchObject({ title: "write more docs" });

    const patched = await request(server()).patch("/todos/1").send({ done: true }).expect(200);
    expect(patched.body).toMatchObject({ done: true });

    await request(server()).delete("/todos/1").expect(204);
    await request(server()).get("/todos/1").expect(404);
  });

  it("returns the ListResultDto envelope on the list route", async () => {
    for (let i = 1; i <= 5; i++) {
      await request(server())
        .post("/todos")
        .send({ title: `t${i}` })
        .expect(201);
    }
    const response = await request(server()).get("/todos?limit=2&offset=1").expect(200);
    expect(response.body).toMatchObject({
      limit: 2,
      offset: 1,
      total: 5,
    });
    // Nothing contributed to `meta`, so the key never reaches the wire.
    expect(response.body).not.toHaveProperty("meta");
    expect(response.body.items).toHaveLength(2);
  });

  it("rejects a repeated pagination param with a 400 rather than crashing", async () => {
    // `?limit=1&limit=2` reaches the binding as an array; it must survive
    // flattening intact so the normalizer can call it a bad value.
    const response = await request(server()).get("/todos?limit=1&limit=2").expect(400);
    expect(response.body).toMatchObject({ code: "KAVO_QUERY_INVALID" });
    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ field: "limit", code: "KAVO_QUERY_INVALID_VALUE" }),
    );
  });

  it("parses the wire grammar into the filter AST (flat bracket keys)", async () => {
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    await request(server()).get("/todos?filter[done][eq]=true&filter[priority][gte]=2&sort=-priority").expect(200);
    const filter = adapter.lastQuery?.filter.root;
    expect(filter).toMatchObject({ kind: "group", operator: "AND" });
    expect(adapter.lastQuery?.sort).toEqual([{ field: "priority", direction: "desc" }]);
  });

  it("maps query validation to a 400 problem-details document", async () => {
    const response = await request(server())
      .get("/todos?filter[nope][eq]=1&sort=-nope")
      .expect(400)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body).toMatchObject({
      status: 400,
      code: "KAVO_QUERY_INVALID",
    });
    expect(response.body.errors).toHaveLength(2);
  });

  it("maps NotFound to a 404 problem-details document", async () => {
    const response = await request(server())
      .get("/todos/99")
      .expect(404)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body).toMatchObject({
      code: "KAVO_NOT_FOUND",
      type: "https://kavo.dev/errors/kavo-not-found",
    });
    expect(response.body.detail).toContain("99");
  });

  it("rejects a non-numeric id on a numeric id column with a 400", async () => {
    await request(server()).get("/todos/abc").expect(400);
  });

  it("strips generated/unknown keys from bodies", async () => {
    const created = await request(server()).post("/todos").send({ id: 999, title: "x", hacker: true }).expect(201);
    expect(created.body.id).toBe(1);
    expect(created.body).not.toHaveProperty("hacker");
  });

  it("exposes the typed service under getKavoServiceToken", async () => {
    const service = app.get<DefaultKavoService<Todo>>(getKavoServiceToken(Todo));
    const item = await service.createOne({ title: "via service" } as never);
    expect(item).toMatchObject({ title: "via service" });
  });

  it("generates no *Many/restore/purge routes while those are disabled", async () => {
    await request(server()).patch("/todos/1/restore").expect(404);
    await request(server()).delete("/todos/1/purge").expect(404);
  });
});

/**
 * `search[query]`/`search[mode]`/`search[fields]` (issue #156), through a
 * generated route — the wire-grammar mirror of `packages/core/tests/
 * query-normalizer.spec.ts`'s unit coverage. `Todo` has exactly one
 * string-kind column (`title`), so it also proves the default `searchable`
 * allowlist (every own string column) with no explicit configuration.
 */
describe("@Kavo search[...] (issue #156)", () => {
  @Kavo(Todo, { query: { search: {} } })
  @Controller("todos")
  class SearchController {}

  beforeEach(async () => {
    await bootstrap(SearchController);
    await request(server()).post("/todos").send({ title: "write docs" }).expect(201);
    await request(server()).post("/todos").send({ title: "buy milk" }).expect(201);
  });

  it("synthesizes an ILIKE condition over the default searchable allowlist (substring, default mode)", async () => {
    await request(server()).get("/todos?search[query]=doc").expect(200);
    expect(adapter.lastQuery?.filter.root).toEqual({
      kind: "condition",
      field: "title",
      operator: "ILIKE",
      value: "%doc%",
    });
  });

  it("ANDs one OR group per word in words mode", async () => {
    await request(server()).get("/todos?search[query]=write docs&search[mode]=words").expect(200);
    expect(adapter.lastQuery?.filter.root).toEqual({
      kind: "group",
      operator: "AND",
      children: [
        { kind: "condition", field: "title", operator: "ILIKE", value: "%write%" },
        { kind: "condition", field: "title", operator: "ILIKE", value: "%docs%" },
      ],
    });
  });
});

describe("@Kavo search[...] rejected when not enabled (issue #156)", () => {
  @Kavo(Todo)
  @Controller("todos")
  class DisabledSearchController {}

  beforeEach(async () => {
    await bootstrap(DisabledSearchController);
  });

  it("rejects search[query] with a 400 problem-details document", async () => {
    const response = await request(server())
      .get("/todos?search[query]=doc")
      .expect(400)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ field: "search[query]", code: "KAVO_QUERY_UNSUPPORTED_PARAM" }),
    );
  });
});

/**
 * Regression, over real HTTP because that is where the damage was: a single
 * anonymous GET whose query string carried a `__proto__` bracket segment used
 * to write into `Object.prototype`, and the write then leaked into every
 * later request in the process through the plain-object reads in the
 * normalizer and the deserializer. Unit coverage lives in
 * `packages/core/tests/filter-parser.spec.ts`; what this file adds is the
 * amplification path — victim requests that never touch the attacking one.
 */
describe("@Kavo prototype pollution over the wire", () => {
  @Kavo(Todo, { softDelete: { strategy: "soft" } })
  @Controller("todos")
  class PollutionController {}

  const POLLUTED = ["withDeleted", "onlyDeleted", "limit", "done", "priority", "include"];

  beforeEach(async () => {
    await bootstrap(PollutionController);
  });

  afterEach(() => {
    for (const key of POLLUTED) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  async function attack(segment: string, value: string): Promise<void> {
    // The attacking request itself is allowed to 400 — what matters is that
    // it leaves nothing behind.
    await request(server()).get(`/todos?filter[__proto__][${segment}]=${value}`);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, segment)).toBe(false);
  }

  it("cannot hand a later reader the soft-deleted rows", async () => {
    await request(server()).post("/todos").send({ title: "live" }).expect(201);
    await request(server()).post("/todos").send({ title: "deleted" }).expect(201);
    await request(server()).delete("/todos/2").expect(204);

    await attack("withDeleted", "true");

    const victim = await request(server()).get("/todos").expect(200);
    expect(victim.body.total).toBe(1);
    expect(victim.body.items).toEqual([expect.objectContaining({ title: "live" })]);
  });

  it("cannot smuggle a field into a later writer's body", async () => {
    // The nastiest amplification: `done` is on the create DTO, so a polluted
    // prototype used to satisfy the deserializer's `key in source` check and
    // append itself to bodies that never mentioned it.
    await attack("done", "true");

    const created = await request(server()).post("/todos").send({ title: "innocent" }).expect(201);
    expect(created.body).toMatchObject({ title: "innocent", done: false });
  });

  it("cannot cap or break a later reader's pagination", async () => {
    for (let i = 1; i <= 3; i++) {
      await request(server())
        .post("/todos")
        .send({ title: `t${i}` })
        .expect(201);
    }
    await attack("limit", "1");

    const victim = await request(server()).get("/todos").expect(200);
    expect(victim.body.items).toHaveLength(3);
  });

  it("cannot poison a later reader into a permanent 400", async () => {
    // `include` on an entity with nothing includable is a 400. Inherited off
    // the prototype it would make every read fail for every client, forever.
    await attack("include", "list");
    await request(server()).get("/todos").expect(200);
  });
});

describe("@Kavo page pagination over the wire", () => {
  @Kavo(Todo, { pagination: { strategy: "page", defaultLimit: 2, maxLimit: 3 } })
  @Controller("todos")
  class PagedController {}

  beforeEach(async () => {
    await bootstrap(PagedController);
    for (let i = 1; i <= 7; i++) {
      await request(server())
        .post("/todos")
        .send({ title: `t${i}` })
        .expect(201);
    }
  });

  const titles = (body: { items: { title: string }[] }): string[] => body.items.map((item) => item.title);

  it("serves the requested 1-indexed page", async () => {
    const response = await request(server()).get("/todos?page[number]=2&page[size]=2").expect(200);
    expect(titles(response.body)).toEqual(["t3", "t4"]);
  });

  it("reports limit/offset in the envelope even under the page strategy", async () => {
    const response = await request(server()).get("/todos?page[number]=2&page[size]=2").expect(200);
    expect(response.body).toMatchObject({ limit: 2, offset: 2, total: 7 });
  });

  it("starts page 1 at offset 0 and falls back to defaultLimit", async () => {
    const response = await request(server()).get("/todos?page[number]=1").expect(200);
    expect(response.body).toMatchObject({ limit: 2, offset: 0 });
    expect(titles(response.body)).toEqual(["t1", "t2"]);
  });

  it("clamps page[size] to maxLimit before computing the offset", async () => {
    const response = await request(server()).get("/todos?page[number]=3&page[size]=99").expect(200);
    expect(response.body).toMatchObject({ limit: 3, offset: 6, total: 7 });
    expect(titles(response.body)).toEqual(["t7"]);
  });

  it("ignores limit/offset once the page strategy is in force", async () => {
    const response = await request(server()).get("/todos?limit=5&offset=5").expect(200);
    expect(response.body).toMatchObject({ limit: 2, offset: 0 });
  });

  it("maps a page number below 1 to a 400 problem-details document", async () => {
    const response = await request(server())
      .get("/todos?page[number]=0")
      .expect(400)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ field: "page[number]", code: "KAVO_QUERY_INVALID_VALUE" }),
    );
  });
});

describe("@Kavo query-parser agnosticism", () => {
  @Kavo(Todo)
  @Controller("todos")
  class TodoController {}

  const wireQuery =
    "?filter[done][eq]=true&filter[priority][gte]=2&filter[title][in][]=a&filter[title][in][]=b" +
    "&filter[or][0][priority][eq]=5&filter[or][1][title][eq]=z&sort=-priority,title&limit=2&offset=1";

  async function normalizedQueryUnder(extendedQueryParser: boolean): Promise<NormalizedQueryContext<Todo> | null> {
    await bootstrap(TodoController, { extendedQueryParser });
    await request(server()).get(`/todos${wireQuery}`).expect(200);
    return adapter.lastQuery;
  }

  it("reaches the same normalized query whether the parser is simple or extended", async () => {
    const simple = await normalizedQueryUnder(false);
    await app.close();
    const extended = await normalizedQueryUnder(true);
    // The nested-object parse is the branch `flattenQuery` exists for
    // (doc 10 §2); equality of the normalized query is what "the binding is
    // parser-agnostic" means.
    expect(extended).toEqual(simple);
  });

  it("still builds the filter AST under the extended parser", async () => {
    const query = await normalizedQueryUnder(true);
    expect(query?.filter.root).toMatchObject({ kind: "group", operator: "AND" });
    expect(query?.sort).toEqual([
      { field: "priority", direction: "desc" },
      { field: "title", direction: "asc" },
    ]);
    expect(query?.pagination).toEqual({ limit: 2, offset: 1 });
  });
});

describe("@Kavo operation control surface", () => {
  it("generates no route for a disabled operation", async () => {
    @Kavo(Todo, { operations: { createOne: true } }) // deleteOne stays off by not naming it
    @Controller("todos")
    class NoDeleteController {}

    await bootstrap(NoDeleteController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    await request(server()).delete("/todos/1").expect(404);
  });

  it("a global operations default guards the route rather than removing it (issue #38, ADR-0015)", async () => {
    // Decoration runs before KavoModule.forRoot(Async)'s options are known
    // (ADR-0012), so a global `defaults.operations.deleteOne: false` can't
    // retract the already-generated DELETE route. It reaches the bound
    // service instead: the route still exists, but calling it always
    // answers with a 405 problem-details document, never a 2xx or a bare 404.
    @Kavo(Todo)
    @Controller("todos")
    class GloballyGuardedController {}

    await bootstrap(GloballyGuardedController, { defaults: { operations: { deleteOne: false } } });
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    const response = await request(server())
      .delete("/todos/1")
      .expect(405)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body).toMatchObject({ code: "KAVO_OPERATION_DISABLED" });
  });

  it("an entity-level override still wins over a global operations default", async () => {
    @Kavo(Todo, { operations: { createOne: true, deleteOne: true } })
    @Controller("todos")
    class ReenabledController {}

    await bootstrap(ReenabledController, { defaults: { operations: { deleteOne: false } } });
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    await request(server()).delete("/todos/1").expect(204);
  });

  it("manual-method-wins: a hand-written method suppresses generation", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class ManualController {
      @Get(":id")
      findOne(): { manual: boolean } {
        return { manual: true };
      }
    }

    await bootstrap(ManualController);
    const response = await request(server()).get("/todos/1").expect(200);
    expect(response.body).toEqual({ manual: true });
    // Other routes still generate.
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
  });

  it("boundKavoService(this) reaches the service the discovery binder assigned", async () => {
    // The access pattern CLAUDE.md tells consumers to prefer over both
    // `forFeature` and constructor injection, and until now the only one
    // with no test at all. A hand-written route is the case it exists for.
    @Kavo(Todo)
    @Controller("todos")
    class SelfServingController {
      @Get("mine")
      async mine(): Promise<{ titles: string[] }> {
        const service = boundKavoService<Todo>(this);
        const list = await service.findMany();
        return { titles: list.items.map((item) => (item as Todo).title) };
      }
    }

    await bootstrap(SelfServingController);
    await request(server()).post("/todos").send({ title: "own route" }).expect(201);

    const response = await request(server()).get("/todos/mine").expect(200);
    expect(response.body).toEqual({ titles: ["own route"] });
  });

  it("overrides all five singular standard operations, alongside manual-method-wins and a disabled operation (issue #21)", async () => {
    const seen: string[] = [];
    const overrideHandler = (id: string): OperationHandler<Todo> => ({
      async execute() {
        seen.push(id);
        return { id: 1, title: id, done: false, priority: 0, deletedAt: null, list: null };
      },
    });

    @Kavo(Todo, {
      operations: {
        createOne: { handler: overrideHandler("createOne") },
        updateOne: { handler: overrideHandler("updateOne") },
        patchOne: { handler: overrideHandler("patchOne") },
        deleteOne: {
          handler: {
            async execute() {
              seen.push("deleteOne");
              return null;
            },
          },
        },
        // findMany is deliberately not named here — a control surface that
        // otherwise touches every id must still leave an unnamed one off.
      },
    })
    @Controller("todos")
    class FullOverrideController {
      // Manual-method-wins over the findOne override too: the two
      // mechanisms are independent and must coexist without conflict.
      @Get(":id")
      findOne(): { manual: boolean } {
        return { manual: true };
      }
    }

    await bootstrap(FullOverrideController);

    const created = await request(server()).post("/todos").send({ title: "x" }).expect(201);
    expect(created.body).toMatchObject({ title: "createOne" });

    const found = await request(server()).get("/todos/1").expect(200);
    expect(found.body).toEqual({ manual: true });

    const updated = await request(server()).put("/todos/1").send({ title: "y" }).expect(200);
    expect(updated.body).toMatchObject({ title: "updateOne" });

    const patched = await request(server()).patch("/todos/1").send({ title: "z" }).expect(200);
    expect(patched.body).toMatchObject({ title: "patchOne" });

    await request(server()).delete("/todos/1").expect(204);

    // Unnamed alongside four overrides: still no route.
    await request(server()).get("/todos").expect(404);

    expect(seen).toEqual(["createOne", "updateOne", "patchOne", "deleteOne"]);
  });
});

describe("@Kavo custom operations (issue #145)", () => {
  /** A handler that marks the row done and reports what it was given. */
  function publishHandler(seen: unknown[]): OperationHandler<Todo> {
    return {
      async execute(input: unknown) {
        seen.push(input);
        const { id } = input as { id: number };
        return { id, title: "published", done: true, priority: 0, deletedAt: null, list: null };
      },
    };
  }

  it("generates the route its meta.routes describes, and runs the whole pipeline", async () => {
    const seen: unknown[] = [];

    @Kavo(Todo, {
      operations: {
        createOne: true,
        findOne: true,
        publishOne: {
          handler: publishHandler(seen),
          meta: { routes: { method: "POST", path: ":id/publish" } },
        },
      },
    })
    @Controller("todos")
    class PublishController {}

    await bootstrap(PublishController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    const response = await request(server()).post("/todos/1/publish").send({ title: "ignored" }).expect(201);

    // The `:id` segment is coerced and paired with the deserialized body,
    // exactly as `createOne` + `updateOne`'s shared branch does.
    expect(seen).toEqual([{ id: 1, body: { title: "ignored" } }]);
    // The response is serialized through the `item` slot and carries an
    // ETag, like any other single-row response (ADR-0020).
    expect(response.body).toMatchObject({ id: 1, title: "published", done: true });
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    // A standard route the config also names stays untouched by the
    // custom operation's presence (issue #257: unlisted ones would not).
    await request(server()).get("/todos/1").expect(200);
  });

  it("falls back to POST /<id> when the operation declares no meta.routes", async () => {
    @Kavo(Todo, { operations: { createOne: true, publishOne: { handler: publishHandler([]) } } })
    @Controller("todos")
    class DefaultRouteController {}

    await bootstrap(DefaultRouteController);
    await request(server()).post("/todos/publishOne").send({}).expect(201);
  });

  it("keeps a custom operation service-only under meta.routes.enabled: false", async () => {
    const seen: unknown[] = [];

    @Kavo(Todo, {
      operations: {
        createOne: true,
        publishOne: { handler: publishHandler(seen), meta: { routes: { enabled: false } } },
      },
    })
    @Controller("todos")
    class ServiceOnlyController {
      @Get("publish-in-code/:id")
      async publish(@Param("id") id: string): Promise<unknown> {
        return boundKavoService<Todo>(this).run("publishOne", { id: Number(id) });
      }
    }

    await bootstrap(ServiceOnlyController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    // No generated route…
    await request(server()).post("/todos/1/publish").expect(404);
    await request(server()).post("/todos/publishOne").expect(404);
    // …but still callable through the typed service surface.
    const response = await request(server()).get("/todos/publish-in-code/1").expect(200);
    expect(response.body).toMatchObject({ title: "published" });
    expect(seen).toHaveLength(1);
  });

  it("generates no route for a custom operation registered disabled", async () => {
    @Kavo(Todo, {
      operations: {
        publishOne: {
          enabled: false,
          handler: publishHandler([]),
          meta: { routes: { method: "POST", path: ":id/publish" } },
        },
      },
    })
    @Controller("todos")
    class DisabledCustomController {}

    await bootstrap(DisabledCustomController);
    await request(server()).post("/todos/1/publish").expect(404);
  });

  it("manual-method-wins applies to a custom id exactly as to a standard one", async () => {
    const seen: unknown[] = [];

    @Kavo(Todo, {
      operations: {
        publishOne: {
          handler: publishHandler(seen),
          meta: { routes: { method: "POST", path: ":id/publish" } },
        },
      },
    })
    @Controller("todos")
    class ManualCustomController {
      // Same name as the operation id: the generated route is suppressed
      // entirely, and this method's own decorators are all it has.
      @Get("publish-manually")
      publishOne(): { manual: boolean } {
        return { manual: true };
      }
    }

    await bootstrap(ManualCustomController);

    const response = await request(server()).get("/todos/publish-manually").expect(200);
    expect(response.body).toEqual({ manual: true });
    await request(server()).post("/todos/1/publish").expect(404);
    expect(seen).toHaveLength(0);
  });

  it("@Override backs a custom operation's generated route with a controller method", async () => {
    @Kavo(Todo, {
      operations: {
        publishOne: {
          handler: publishHandler([]),
          meta: { routes: { method: "POST", path: ":id/publish" } },
        },
      },
    })
    @Controller("todos")
    class OverriddenCustomController {
      @Override("publishOne")
      async publish(id: string, body: unknown): Promise<unknown> {
        return { id: Number(id), overridden: true, body };
      }
    }

    await bootstrap(OverriddenCustomController);

    const response = await request(server()).post("/todos/1/publish").send({ title: "t" }).expect(201);
    expect(response.body).toEqual({ id: 1, overridden: true, body: { title: "t" } });
  });

  it("routes a custom read under GET, with the query parsed the way findMany's is", async () => {
    let received: NormalizedQueryContext<Todo> | null = null;

    @Kavo(Todo, {
      operations: {
        findPublishedMany: {
          kind: "read",
          cardinality: "many",
          handler: {
            async execute(_input: unknown, context: { query: NormalizedQueryContext<Todo> | null }) {
              received = context.query;
              return { entities: [], total: 0 };
            },
          },
          meta: { routes: { method: "GET", path: "published" } },
        },
      },
    })
    @Controller("todos")
    class PublishedController {}

    await bootstrap(PublishedController);

    // `GET /todos/published` reaches its own handler rather than `findOne`'s
    // `GET /todos/:id` — custom entries are registered, and so routed,
    // ahead of the standard table for exactly this reason. Registered after
    // it, this would 400 with "'published' is not a valid number".
    const response = await request(server()).get("/todos/published?filter[done][eq]=true&limit=3").expect(200);

    // The list envelope, not a bare item — cardinality drives the mapping.
    expect(response.body).toMatchObject({ items: [], total: 0, limit: 3 });
    expect(received).not.toBeNull();
    expect(received!.pagination.limit).toBe(3);
  });

  it("documents the custom route in the OpenAPI document", async () => {
    class TodoReceiptDto {
      id = 0;
      publishedAt = "";
    }

    @Kavo(Todo, {
      operations: {
        publishOne: {
          handler: publishHandler([]),
          dto: { output: TodoReceiptDto },
          meta: { routes: { method: "POST", path: ":id/publish" } },
        },
      },
    })
    @Controller("todos")
    class DocumentedCustomController {}

    await bootstrap(DocumentedCustomController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    const operation = (
      document.paths["/todos/{id}/publish"] as {
        post?: {
          operationId?: string;
          tags?: string[];
          "x-kavo-entity"?: string;
          "x-kavo-operation"?: string;
          "x-kavo-cardinality"?: string;
          responses?: Record<string, { content?: Record<string, { schema?: object }> }>;
        };
      }
    )?.post;
    expect(operation?.operationId).toBe("Todo_publishOne");
    // A custom operation carries the same tag/vendor extensions a standard
    // one does (issue #294) — derived from `entity.name`/`descriptor.id`,
    // not the operation's own custom route shape.
    expect(operation?.tags).toEqual(["Todo"]);
    expect(operation?.["x-kavo-entity"]).toBe("Todo");
    expect(operation?.["x-kavo-operation"]).toBe("publishOne");
    expect(operation?.["x-kavo-cardinality"]).toBe("one");
    // The response schema follows `dto.output`, the same class the engine
    // actually serializes through, and carries the same x-kavo-entity link.
    expect(operation?.responses?.["201"]?.content?.["application/json"]?.schema).toMatchObject({
      title: "TodoReceiptDto",
      "x-kavo-entity": "Todo",
    });
  });
});

describe("@Kavo custom operations reaching data (issue #152)", () => {
  /**
   * The wiring the integration docs recommend, and the reason this seam
   * exists: the infrastructure is produced inside `forRootAsync`'s factory,
   * which Nest runs when the module is instantiated — long after every
   * `@Kavo` config literal in this file was evaluated (ADR-0012). The
   * adapter is constructed *in* the factory, so nothing declared above it
   * could have closed over one.
   */
  async function bootstrapAsync(controller: unknown): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => {
            adapter = new InMemoryTodoAdapter();
            return { infrastructure: fakeInfrastructure(adapter) };
          },
        }),
        KavoModule.forFeature([controller as never]),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    httpServer = await listen(app);
  }

  /** Load the row, write a field: the shape issue #145 was written for. */
  @Kavo(Todo, {
    operations: {
      createOne: true,
      findOne: true,
      publishOne: {
        handler: {
          async execute(input: { id: number }, context: KavoContext<Todo>) {
            const todo = await context.repository.findOneById(input.id, null, context);
            if (todo === null) {
              throw new KavoNotFoundException({
                messageParams: { entity: context.entityName, id: String(input.id) },
                context: {
                  entityName: context.entityName,
                  operation: context.operation,
                  correlationId: context.correlationId,
                },
              });
            }
            return context.repository.patch(input.id, { done: true, title: `${todo.title} (published)` }, context);
          },
        },
        meta: { routes: { method: "POST", path: ":id/publish" } },
      },
    },
  })
  @Controller("todos")
  class PublishController {}

  it("persists a write through the request's own repository", async () => {
    await bootstrapAsync(PublishController);
    await request(server()).post("/todos").send({ title: "write docs" }).expect(201);

    const response = await request(server()).post("/todos/1/publish").expect(201);

    expect(response.body).toMatchObject({ id: 1, done: true, title: "write docs (published)" });
    // The row itself changed — the response is not a fabricated object.
    const fetched = await request(server()).get("/todos/1").expect(200);
    expect(fetched.body).toMatchObject({ id: 1, done: true, title: "write docs (published)" });
    expect(adapter.rows[0]).toMatchObject({ done: true, title: "write docs (published)" });
  });

  it("answers the handler's own 404 as problem details when the row is missing", async () => {
    await bootstrapAsync(PublishController);

    const response = await request(server())
      .post("/todos/999/publish")
      .expect(404)
      .expect("Content-Type", /application\/problem\+json/);

    expect(response.body.code).toBe("KAVO_NOT_FOUND");
  });

  /**
   * The other half of ADR-0025: a built-in handler wrapped at decoration
   * time. `builtInHandlers<Todo>()` takes no adapter, so this composes
   * where the old form could not, and the wrap still runs the real
   * `findMany` against the adapter the factory built afterwards.
   */
  @Kavo(Todo, {
    operations: {
      createOne: true,
      findMany: {
        handler: withListMeta(builtInHandlers<Todo>()("findMany"), (result: FindManyResult<Todo>) => ({
          done: result.entities.filter((todo) => todo.done).length,
        })),
      },
    },
  })
  @Controller("todos")
  class ListMetaController {}

  it("runs a decoration-time withListMeta wrap over the built-in findMany", async () => {
    await bootstrapAsync(ListMetaController);
    await request(server()).post("/todos").send({ title: "write docs", done: true }).expect(201);
    await request(server()).post("/todos").send({ title: "write tests" }).expect(201);

    const response = await request(server()).get("/todos").expect(200);

    expect(response.body).toMatchObject({ total: 2, limit: 20, offset: 0, meta: { done: 1 } });
    expect(response.body.items).toHaveLength(2);
  });
});

describe("@Kavo @Override — controller-method overrides that keep generated route metadata (issue #23)", () => {
  it("keeps findOne's generated route/param wiring, delegating to the decorated method", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class OverrideFindOneController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async findOne(id: string, query: WireQuery): Promise<unknown> {
        const item = await this.base.findOne(id as never, query as never);
        return { ...item, viaOverride: true };
      }
    }

    await bootstrap(OverrideFindOneController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    const response = await request(server()).get("/todos/1").expect(200);
    expect(response.body).toMatchObject({ id: 1, title: "x", viaOverride: true });

    // Regression: a wire-format query string must reach the override
    // normalized, not passed through raw — this is what auto-wiring buys
    // (issue #25). The override never calls flattenQuery/WireQuery itself.
    const narrowed = await request(server()).get("/todos/1").query("select=id,title").expect(200);
    expect(Object.keys(narrowed.body).sort()).toEqual(["id", "title", "viaOverride"]);
  });

  it("passes an overridden findOne a WireQuery instance, not a raw query object (issue #25)", async () => {
    let received: unknown;

    @Kavo(Todo)
    @Controller("todos")
    class OverrideFindOneQueryShapeController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async findOne(id: string, query: WireQuery): Promise<unknown> {
        received = query;
        return this.base.findOne(id as never, query as never);
      }
    }

    await bootstrap(OverrideFindOneQueryShapeController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    await request(server()).get("/todos/1").query("select=id,title").expect(200);

    expect(received).toBeInstanceOf(WireQuery);
    expect((received as WireQuery).params).toMatchObject({ select: "id,title" });
  });

  it("passes an overridden findMany a WireQuery instance, not a raw query object (issue #25)", async () => {
    let received: unknown;

    @Kavo(Todo)
    @Controller("todos")
    class OverrideFindManyQueryShapeController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async findMany(query: WireQuery): Promise<unknown> {
        received = query;
        return this.base.findMany(query as never);
      }
    }

    await bootstrap(OverrideFindManyQueryShapeController);
    await request(server()).get("/todos").query("limit=2&offset=1").expect(200);

    expect(received).toBeInstanceOf(WireQuery);
    expect((received as WireQuery).params).toMatchObject({ limit: "2", offset: "1" });
  });

  it("keeps filtering intact when a stale override still manually double-wraps its already-wired query (issue #25 regression)", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class StaleDoubleWrapController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      // Pre-#25 pattern: `query` is already a WireQuery (via WireQueryPipe),
      // but this override still calls flattenQuery/WireQuery on it itself.
      // Without flattenQuery's idempotency guard, this would silently mangle
      // every key one bracket level too deep and drop the filter entirely.
      @Override()
      async findMany(query: WireQuery): Promise<unknown> {
        const rewrapped = new WireQuery(flattenQuery(query as unknown as Record<string, unknown>));
        return this.base.findMany(rewrapped as never);
      }
    }

    await bootstrap(StaleDoubleWrapController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    // The fake adapter doesn't evaluate filters — it only records the
    // normalized query (filter evaluation is @kavo/typeorm's concern) — so
    // assert on the normalized AST itself: without flattenQuery's idempotency
    // guard, the mangled `params[filter[...]]` keys would vanish, leaving an
    // empty filter/sort with no error raised, rather than the AST below.
    await request(server()).get("/todos?filter[title][eq]=x&sort=-priority").expect(200);
    expect(adapter.lastQuery?.filter.root).toMatchObject({ kind: "condition", field: "title", operator: "EQ" });
    expect(adapter.lastQuery?.sort).toEqual([{ field: "priority", direction: "desc" }]);
  });

  it("keeps createOne's generated route/param wiring (body alone, 201, no :id)", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class OverrideCreateOneController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async createOne(body: { title: string }): Promise<unknown> {
        return this.base.createOne({ ...body, title: body.title.toUpperCase() } as never);
      }
    }

    await bootstrap(OverrideCreateOneController);
    const response = await request(server()).post("/todos").send({ title: "loud" }).expect(201);
    expect(response.body).toMatchObject({ title: "LOUD" });
  });

  it("wires an explicit operationId to a differently-named method (id+body write), not just name-matched ones", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class ExplicitIdOverrideController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      // The method name is unrelated to "updateOne" — proves resolution
      // uses the override map's target, not descriptor.id, end to end.
      @Override("updateOne")
      async customUpdate(id: string, body: { title: string }): Promise<unknown> {
        return this.base.updateOne(id as never, { ...body, title: body.title.toUpperCase() } as never);
      }
    }

    await bootstrap(ExplicitIdOverrideController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    const response = await request(server()).put("/todos/1").send({ title: "loud" }).expect(200);
    expect(response.body).toMatchObject({ id: 1, title: "LOUD" });
  });

  it("keeps an overridden operation's own custom meta.routes shape (id-bearing route)", async () => {
    @Kavo(Todo, {
      operations: {
        createOne: true,
        updateOne: { meta: { routes: { method: "POST", path: ":id/activate" } } },
      },
    })
    @Controller("todos")
    class OverrideCustomRouteController {
      @Override("updateOne")
      async activate(id: string): Promise<unknown> {
        const row = adapter.rows.find((candidate) => candidate.id === Number(id));
        if (row !== undefined) {
          row.done = true;
        }
        return row ?? null;
      }
    }

    await bootstrap(OverrideCustomRouteController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    const response = await request(server()).post("/todos/1/activate").expect(200);
    expect(response.body).toMatchObject({ id: 1, done: true });
  });

  it("documents an overridden route with the same Swagger shape a generated one would carry", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class OverrideSwaggerController {
      constructor(@Inject(getKavoServiceToken(Todo)) private readonly base: DefaultKavoService<Todo>) {}

      @Override()
      async findOne(id: string, query: WireQuery): Promise<unknown> {
        return this.base.findOne(id as never, query as never);
      }
    }

    await bootstrap(OverrideSwaggerController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
    const getItem = (
      document.paths["/todos/{id}"] as Record<
        string,
        {
          operationId?: string;
          tags?: string[];
          "x-kavo-entity"?: string;
          "x-kavo-operation"?: string;
          "x-kavo-cardinality"?: string;
          parameters?: { name: string; in: string }[];
          responses?: Record<string, unknown>;
        }
      >
    )?.get;
    expect(getItem?.operationId).toBe("Todo_findOne");
    expect(getItem?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "id", in: "path" })]));
    expect(getItem?.responses).toHaveProperty("200");
    expect(getItem?.responses).toHaveProperty("404");
    // An @Override'd route still carries the same tag/vendor extensions as a
    // generated one (issue #294) — applySwaggerMetadata runs identically for
    // both, keyed off entity.name/descriptor.id, not the method it binds to.
    expect(getItem?.tags).toEqual(["Todo"]);
    expect(getItem?.["x-kavo-entity"]).toBe("Todo");
    expect(getItem?.["x-kavo-operation"]).toBe("findOne");
    expect(getItem?.["x-kavo-cardinality"]).toBe("one");
  });

  it("leaves plain manual-method-wins (no @Override) exactly as before", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class ManualStillWinsController {
      @Get(":id")
      findOne(): { manual: boolean } {
        return { manual: true };
      }
    }

    await bootstrap(ManualStillWinsController);
    const response = await request(server()).get("/todos/1").expect(200);
    expect(response.body).toEqual({ manual: true });
  });

  it("throws at decoration time when two methods override the same operation", () => {
    let error: unknown;
    try {
      @Kavo(Todo)
      @Controller("todos")
      class DuplicateOverrideController {
        @Override("createOne")
        first(): void {}
        @Override("createOne")
        second(): void {}
      }
      void DuplicateOverrideController;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID", messageParams: { path: "override.createOne" } });
  });

  it("throws at decoration time when @Override names an operation that is off by default", () => {
    let error: unknown;
    try {
      @Kavo(Todo)
      @Controller("todos")
      class DisabledOverrideController {
        @Override("purgeOne")
        purge(): void {}
      }
      void DisabledOverrideController;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID", messageParams: { path: "override.purgeOne" } });
  });

  it("throws at decoration time when @Override names an operation id absent from the registry", () => {
    let error: unknown;
    try {
      @Kavo(Todo)
      @Controller("todos")
      class GhostOverrideController {
        @Override("ghost")
        ghost(): void {}
      }
      void GhostOverrideController;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID", messageParams: { path: "override.ghost" } });
  });

  it("throws at decoration time when @Override targets a service-only operation", () => {
    let error: unknown;
    try {
      @Kavo(Todo, {
        operations: {
          deleteOne: { meta: { routes: { enabled: false } } },
        },
      })
      @Controller("todos")
      class ServiceOnlyOverrideController {
        @Override("deleteOne")
        recalc(): void {}
      }
      void ServiceOnlyOverrideController;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID", messageParams: { path: "override.deleteOne" } });
  });

  it("throws at decoration time when the overridden method declares its own @Param/@Body", () => {
    let error: unknown;
    try {
      @Kavo(Todo)
      @Controller("todos")
      class SelfParamOverrideController {
        @Override()
        findOne(@Param("id") id: string): unknown {
          return { id };
        }
      }
      void SelfParamOverrideController;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error).toMatchObject({ code: "KAVO_CONFIG_INVALID", messageParams: { path: "override.findOne" } });
  });
});

describe("KavoExceptionFilter — non-Kavo handler failures", () => {
  const exploding: OperationHandler<Todo> = {
    async execute() {
      throw new Error("connection to shard-7 refused");
    },
  };

  @Kavo(Todo, { operations: { createOne: { handler: exploding } } })
  @Controller("todos")
  class ExplodingController {}

  it("answers with a problem-details document at the catalog status", async () => {
    await bootstrap(ExplodingController);
    const response = await request(server())
      .post("/todos")
      .send({ title: "x" })
      .expect(500)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body).toMatchObject({
      type: "https://kavo.dev/errors/kavo-persistence-failed",
      title: "Persistence failure",
      status: 500,
      code: "KAVO_PERSISTENCE_FAILED",
    });
  });

  it("keeps the driver detail out of the body while exposeInternals is off", async () => {
    await bootstrap(ExplodingController);
    const response = await request(server()).post("/todos").send({ title: "x" }).expect(500);
    expect(JSON.stringify(response.body)).not.toContain("shard-7");
  });

  it("leaks the cause only when exposeInternals is turned on", async () => {
    await bootstrap(ExplodingController, { defaults: { errors: { exposeInternals: true } } });
    const response = await request(server()).post("/todos").send({ title: "x" }).expect(500);
    expect(response.body.detail).toContain("shard-7");
  });

  it("reports the occurrence as a correlation URN", async () => {
    await bootstrap(ExplodingController);
    const response = await request(server()).post("/todos").send({ title: "x" }).expect(500);
    expect(response.body.instance).toMatch(/^urn:kavo:request:/);
  });
});

describe("KavoExceptionFilter — errors that never reach KavoEngine.execute", () => {
  // No `@Kavo` here on purpose, and registered as an ordinary Nest
  // controller rather than through `KavoModule.forFeature` (which only
  // accepts `@Kavo` classes): the filter is registered globally
  // (`APP_FILTER`), so it must also normalize errors from a controller that
  // has nothing to do with Kavo.
  @Controller("diagnostics")
  class DiagnosticsController {
    @Get("boom-http")
    boomHttp(): never {
      throw new NotFoundException("no boom here");
    }

    @Get("boom-unexpected")
    boomUnexpected(): never {
      throw new Error("totally unexpected crash");
    }
  }

  async function bootstrapDiagnostics(options: BootstrapOptions = {}): Promise<void> {
    adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), defaults: options.defaults })],
      controllers: [DiagnosticsController],
    }).compile();
    app = moduleRef.createNestApplication();
    httpServer = await listen(app);
  }

  it("wraps a Nest HttpException thrown outside the engine as problem-details, keeping its own status", async () => {
    await bootstrapDiagnostics();
    const response = await request(server())
      .get("/diagnostics/boom-http")
      .expect(404)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body).toMatchObject({
      type: "https://kavo.dev/errors/kavo-http-error",
      status: 404,
      code: "KAVO_HTTP_ERROR",
    });
    expect(response.body.detail).toContain("no boom here");
  });

  it("wraps an unrecognized thrown error as problem-details at 500", async () => {
    await bootstrapDiagnostics();
    const response = await request(server())
      .get("/diagnostics/boom-unexpected")
      .expect(500)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body).toMatchObject({
      type: "https://kavo.dev/errors/kavo-unexpected-error",
      status: 500,
      code: "KAVO_UNEXPECTED_ERROR",
    });
  });

  it("keeps the unrecognized error's message out of the body while exposeInternals is off", async () => {
    await bootstrapDiagnostics();
    const response = await request(server()).get("/diagnostics/boom-unexpected").expect(500);
    expect(JSON.stringify(response.body)).not.toContain("totally unexpected crash");
  });

  it("leaks the unrecognized error's message only when exposeInternals is turned on", async () => {
    await bootstrapDiagnostics({ defaults: { errors: { exposeInternals: true } } });
    const response = await request(server()).get("/diagnostics/boom-unexpected").expect(500);
    expect(response.body.detail).toContain("totally unexpected crash");
  });

  it("answers an unmatched route with problem-details too, since the filter is global", async () => {
    await bootstrapDiagnostics();
    const response = await request(server())
      .get("/does-not-exist")
      .expect(404)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body).toMatchObject({ code: "KAVO_HTTP_ERROR", status: 404 });
  });

  it("never reports a correlation instance for either synthetic code, unlike a KavoException", async () => {
    await bootstrapDiagnostics();
    const httpError = await request(server()).get("/diagnostics/boom-http").expect(404);
    const unexpectedError = await request(server()).get("/diagnostics/boom-unexpected").expect(500);
    expect(httpError.body).not.toHaveProperty("instance");
    expect(unexpectedError.body).not.toHaveProperty("instance");
  });
});

describe("@Kavo soft-delete routes", () => {
  @Kavo(Todo, {
    softDelete: { strategy: "soft" },
    operations: {
      createOne: true,
      findOne: true,
      findMany: true,
      updateOne: true,
      patchOne: true,
      deleteOne: true,
      restoreOne: true,
      purgeOne: true,
    },
  })
  @Controller("todos")
  class SoftDeleteController {}

  beforeEach(async () => {
    await bootstrap(SoftDeleteController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
  });

  it("soft-deletes on DELETE and hides the row from reads", async () => {
    await request(server()).delete("/todos/1").expect(204);
    expect(adapter.rows[0]?.deletedAt).toBeInstanceOf(Date);
    await request(server()).get("/todos/1").expect(404);
    expect((await request(server()).get("/todos").expect(200)).body.total).toBe(0);
  });

  it("returns deleted rows for withDeleted=true", async () => {
    await request(server()).delete("/todos/1").expect(204);
    const response = await request(server()).get("/todos?withDeleted=true").expect(200);
    expect(response.body.items).toHaveLength(1);
  });

  it("narrows the list to the trash for onlyDeleted=true", async () => {
    // The flag is unit-tested in core; what this pins down is that it
    // survives the wire — the binding hands the engine flat query params,
    // and a flag that never reached the normalizer would read as a
    // plain live listing instead of a 400.
    await request(server()).post("/todos").send({ title: "still here" }).expect(201);
    await request(server()).delete("/todos/1").expect(204);

    const trash = await request(server()).get("/todos?onlyDeleted=true").expect(200);
    expect(trash.body).toMatchObject({ total: 1 });
    expect(trash.body.items).toEqual([expect.objectContaining({ id: 1, title: "x" })]);
    expect(adapter.lastQuery).toMatchObject({ onlyDeleted: true, withDeleted: false });

    // …and the default view is still its complement.
    const live = await request(server()).get("/todos").expect(200);
    expect(live.body.items).toEqual([expect.objectContaining({ id: 2, title: "still here" })]);
  });

  it("applies onlyDeleted to a single-row read too", async () => {
    // The list and the by-id path resolve visibility separately, in every
    // real adapter as well as this fake, so the trash view has to be
    // asserted on both — a by-id read that ignored the flag would 404 the
    // row the list just handed the client.
    await request(server()).delete("/todos/1").expect(204);
    await request(server()).get("/todos/1").expect(404);
    const trashed = await request(server()).get("/todos/1?onlyDeleted=true").expect(200);
    expect(trashed.body).toMatchObject({ id: 1, title: "x" });
  });

  it("maps withDeleted+onlyDeleted together to a 400 problem-details document", async () => {
    const response = await request(server())
      .get("/todos?withDeleted=true&onlyDeleted=true")
      .expect(400)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body).toMatchObject({ status: 400, code: "KAVO_QUERY_INVALID" });
    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ field: "onlyDeleted", code: "KAVO_QUERY_CONFLICTING_PARAMS" }),
    );
  });

  it("rejects onlyDeleted on an entity that is not soft-deletable", async () => {
    @Kavo(Todo, { softDelete: { strategy: "hard" } })
    @Controller("todos")
    class HardDeleteController {}

    await app.close();
    await bootstrap(HardDeleteController);
    const response = await request(server()).get("/todos?onlyDeleted=true").expect(400);
    expect(response.body.errors).toContainEqual(
      expect.objectContaining({ field: "onlyDeleted", code: "KAVO_QUERY_UNSUPPORTED_PARAM" }),
    );
  });

  it("restores through PATCH /:id/restore, returning the item", async () => {
    await request(server()).delete("/todos/1").expect(204);
    const restored = await request(server()).patch("/todos/1/restore").expect(200);
    expect(restored.body).toMatchObject({ id: 1, title: "x" });
    await request(server()).get("/todos/1").expect(200);
  });

  it("maps a restore of a live row to a 409 problem details", async () => {
    const response = await request(server()).patch("/todos/1/restore").expect(409);
    expect(response.body).toMatchObject({
      status: 409,
      code: "KAVO_NOT_DELETED",
    });
  });

  it("purges through DELETE /:id/purge, but only what is already deleted", async () => {
    await request(server()).delete("/todos/1/purge").expect(409);
    await request(server()).delete("/todos/1").expect(204);
    await request(server()).delete("/todos/1/purge").expect(204);
    expect(adapter.rows).toHaveLength(0);
  });

  it("keeps purge unrouted unless it is asked for by name", async () => {
    @Kavo(Todo, { softDelete: { strategy: "soft" } })
    @Controller("todos")
    class RestoreOnlyController {}

    await app.close();
    await bootstrap(RestoreOnlyController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    await request(server()).delete("/todos/1").expect(204);
    await request(server()).patch("/todos/1/restore").expect(200);
    await request(server()).delete("/todos/1/purge").expect(404);
  });
});

describe("@Kavo relation includes", () => {
  @Kavo(Todo, { allowlists: { includable: ["list"] } })
  @Controller("todos")
  class IncludingController {}

  beforeEach(async () => {
    await bootstrap(IncludingController);
  });

  it("parses include= off the wire and embeds the loaded relation", async () => {
    await request(server())
      .post("/todos")
      .send({ title: "x", list: { id: 7 } })
      .expect(201);
    // The fake adapter stores what deserialization produced: an `{ id }`
    // association, which is what a real adapter would resolve.
    expect(adapter.rows[0]?.list).toEqual({ id: 7 });

    const response = await request(server()).get("/todos?include=list").expect(200);
    expect(response.body.items[0]).toMatchObject({ title: "x", list: { id: 7 } });
  });

  it("narrows an included node with select[relation]", async () => {
    await request(server())
      .post("/todos")
      .send({ title: "x", list: { id: 7 } })
      .expect(201);
    const response = await request(server()).get("/todos/1?include=list&select[list]=id").expect(200);
    expect(response.body.list).toEqual({ id: 7 });
  });

  it("rejects a relation-dotted allowlists.selectable entry at bootstrap (ADR-0045)", async () => {
    // `"list.id"` no longer type-checks (`SelectableFieldSelector` is capped
    // to depth 1); the cast stands in for an erased or `as`-cast config, and
    // the bootstrap check is the backstop.
    const config = { allowlists: { includable: ["list"], selectable: ["id", "title", "list.id"] } } as never;
    @Kavo(Todo, config)
    @Controller("todos")
    class CeilingController {}

    await app.close();
    await expect(bootstrap(CeilingController)).rejects.toMatchObject({ code: "KAVO_CONFIG_INVALID" });
  });

  it("rejects a relation that is not includable, with problem details", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class ClosedController {}

    // Replace the including app with one that opted nothing in.
    await app.close();
    await bootstrap(ClosedController);
    const response = await request(server()).get("/todos?include=list").expect(400);
    expect(response.body).toMatchObject({
      code: "KAVO_QUERY_INVALID",
      errors: [{ field: "list", code: "KAVO_QUERY_INVALID_FIELD" }],
    });
  });

  it("carries filter, sort, include and pagination through one request", async () => {
    // Each of these is covered on its own above; what a single request adds
    // is that they survive *together* — one query string, one flatten, one
    // normalization pass. A regression where one section's parse consumed or
    // clobbered another's params is invisible to any single-feature test.
    for (let i = 1; i <= 3; i++) {
      await request(server())
        .post("/todos")
        .send({ title: `t${i}`, priority: i, list: { id: 7 } })
        .expect(201);
    }

    const response = await request(server())
      .get("/todos?filter[done][eq]=false&filter[priority][gte]=1&sort=-priority,title&include=list&limit=2&offset=1")
      .expect(200);

    expect(adapter.lastQuery?.filter.root).toMatchObject({
      kind: "group",
      operator: "AND",
      children: [
        { field: "done", operator: "EQ", value: false },
        { field: "priority", operator: "GTE", value: 1 },
      ],
    });
    expect(adapter.lastQuery?.sort).toEqual([
      { field: "priority", direction: "desc" },
      { field: "title", direction: "asc" },
    ]);
    expect(adapter.lastQuery?.pagination).toEqual({ limit: 2, offset: 1 });
    expect(Object.keys(adapter.lastQuery?.include ?? {})).toEqual(["list"]);

    // The envelope mirrors the request, and the included relation is still
    // embedded on every item of the page. `total: 3` is not evidence the
    // filter ran — this fake's `count()` ignores the filter, and all three
    // rows match it anyway. The load-bearing assertions are the
    // `adapter.lastQuery` ones above; filter *evaluation* belongs to the
    // real adapters.
    expect(response.body).toMatchObject({ limit: 2, offset: 1, total: 3 });
    expect(response.body.items).toHaveLength(2);
    for (const item of response.body.items) {
      expect(item).toMatchObject({ list: { id: 7 } });
    }
  });

  it("documents include and select[relation] in the OpenAPI schema", async () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const include = params.find((param) => param.name === "include");
    // The generic "comma-separated, dot-separated for nesting" syntax now
    // lives only in `KAVO_API_GUIDE`; `include`'s own description
    // carries just the entity-specific allowlist.
    expect(include?.description).toBe("Includable: list.");
    const fieldsList = params.find((param) => param.name === "select[list]");
    expect(fieldsList).toBeDefined();
    // `select[relation]`'s relation name is already the param name, so it
    // carries no description at all.
    expect(fieldsList?.description).toBeUndefined();
  });

  it("omits the include query parameter on an entity that opted nothing in", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class ClosedController {}

    await app.close();
    await bootstrap(ClosedController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    expect(params.find((param) => param.name === "include")).toBeUndefined();
    expect(params.find((param) => param.name.startsWith("select["))).toBeUndefined();
  });

  it("carries no description for an exclude-shaped includable allowlist, and no fields[relation] params", async () => {
    // `{ exclude }` cannot be resolved at decoration time — no ORM metadata
    // exists yet (ADR-0012) — so `include` is still emitted (the set may be
    // non-empty) but undescribed, the same treatment `filterable`/`sortable`/
    // `selectable` already get for their own `{ exclude }` form.
    @Kavo(Todo, { allowlists: { includable: { exclude: [] } } })
    @Controller("todos")
    class ExcludingIncludableController {}

    await app.close();
    await bootstrap(ExcludingIncludableController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const include = params.find((param) => param.name === "include");
    expect(include).toBeDefined();
    expect(include?.description).toBeUndefined();
    expect(params.find((param) => param.name.startsWith("select["))).toBeUndefined();
  });
});

describe("@Kavo Swagger allowlist-aware query docs", () => {
  @Kavo(Todo, { allowlists: { filterable: ["title", "priority"], sortable: ["priority"] } })
  @Controller("todos")
  class RestrictedController {}

  beforeEach(async () => {
    await bootstrap(RestrictedController);
  });

  it("names the entity's explicit filterable and sortable allowlists in the generated docs", async () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const filter = params.find((param) => param.name === "filter");
    const sort = params.find((param) => param.name === "sort");
    // The generic filter/sort syntax now lives only in
    // `KAVO_API_GUIDE`, so the per-route description carries
    // nothing but what that shared guide can't say.
    expect(filter?.description).toBe("Allowed fields: title, priority.");
    expect(sort?.description).toBe("Allowed fields: priority.");
  });

  it("carries no description when an allowlist has no explicit array", async () => {
    // `selectable` is unconfigured here, so its actual base set can only be
    // resolved with ORM metadata — unavailable at decoration time. There is
    // nothing entity-specific to say, so the param defers entirely to
    // `KAVO_API_GUIDE` rather than claim a narrower list than the
    // entity really allows.
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const select = params.find((param) => param.name === "select");
    expect(select?.description).toBeUndefined();
  });

  it("carries no description for an exclude-shaped allowlist", async () => {
    @Kavo(Todo, { allowlists: { filterable: { exclude: ["id"] } } })
    @Controller("todos")
    class ExcludingController {}

    await app.close();
    await bootstrap(ExcludingController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const filter = params.find((param) => param.name === "filter");
    expect(filter?.description).toBeUndefined();
  });

  it("documents an explicit empty allowlist as a closed door, not a blank description", async () => {
    @Kavo(Todo, { allowlists: { sortable: [] } })
    @Controller("todos")
    class NoSortController {}

    await app.close();
    await bootstrap(NoSortController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const sort = params.find((param) => param.name === "sort");
    expect(sort?.description).toBe("No field is allowed.");
  });

  it("carries no description at all on limit/offset — their syntax is always generic", async () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    // `applyPaginationDocs` (bind time) is what declares `limit`/`offset` at
    // all now (issue #225) — `?.description` alone would pass identically
    // whether the param exists undescribed or is missing outright, so the
    // param's presence is asserted first.
    const limit = params.find((param) => param.name === "limit");
    const offset = params.find((param) => param.name === "offset");
    expect(limit).toBeDefined();
    expect(offset).toBeDefined();
    expect(limit?.description).toBeUndefined();
    expect(offset?.description).toBeUndefined();
  });

  it("documents limit/offset as unsupported when the entity's own config declares pagination.strategy: 'none'", async () => {
    @Kavo(Todo, { pagination: { strategy: "none" } })
    @Controller("todos")
    class UnpaginatedController {}

    await app.close();
    await bootstrap(UnpaginatedController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const expected =
      "Not supported: this entity does not paginate ('pagination.strategy' is 'none') — every request serves the whole match set.";
    expect(params.find((param) => param.name === "limit")?.description).toBe(expected);
    expect(params.find((param) => param.name === "offset")?.description).toBe(expected);
  });

  it("documents limit/offset as unsupported when only a global default declares pagination.strategy: 'none'", async () => {
    // The actual reason `applyPaginationDocs` is deferred to bind time
    // (`swagger.ts`'s doc comment): `pagination.strategy` resolves through
    // global → entity → operation, and a plain `@Kavo(Todo)` with no
    // pagination config of its own has nothing for decoration time to see.
    @Kavo(Todo)
    @Controller("todos")
    class GloballyUnpaginatedController {}

    await app.close();
    await bootstrap(GloballyUnpaginatedController, { defaults: { pagination: { strategy: "none" } } });
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const expected =
      "Not supported: this entity does not paginate ('pagination.strategy' is 'none') — every request serves the whole match set.";
    expect(params.find((param) => param.name === "limit")?.description).toBe(expected);
    expect(params.find((param) => param.name === "offset")?.description).toBe(expected);
  });
});

/**
 * `search[query]`/`search[mode]`/`search[fields]` docs (issue #156) are
 * applied later than the rest — deferred to `KavoModule`'s discovery binder
 * (`applySearchQueryDocs`), because whether they belong on the route
 * depends on whether `query.search` resolved to an object through the full precedence
 * chain, and `allowlists.searchable`'s default/`{ exclude }` cases need ORM
 * metadata that doesn't exist at `@Kavo` decoration time.
 */
describe("@Kavo Swagger search[...] query docs (issue #156)", () => {
  it("documents search[query]/search[mode]/search[fields] with the resolved searchable allowlist when enabled", async () => {
    @Kavo(Todo, { query: { search: {} } })
    @Controller("todos")
    class SearchDocsController {}

    await bootstrap(SearchDocsController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const query = params.find((param) => param.name === "search[query]");
    const mode = params.find((param) => param.name === "search[mode]");
    const fields = params.find((param) => param.name === "search[fields]");
    expect(query).toBeDefined();
    expect(mode).toBeDefined();
    // Unlike `filter`/`sort`/`fields` at decoration time, this is the fully
    // *resolved* allowlist (ORM metadata already exists by the time this
    // runs) — `title` is Todo's one string-kind column, the zero-config
    // default.
    expect(fields?.description).toBe("Allowed fields: title.");
  });

  it("omits search[...] params entirely when search is not enabled", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class NoSearchController {}

    await bootstrap(NoSearchController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    expect(params.find((param) => param.name === "search[query]")).toBeUndefined();
    expect(params.find((param) => param.name === "search[mode]")).toBeUndefined();
    expect(params.find((param) => param.name === "search[fields]")).toBeUndefined();
  });

  it("documents an explicit empty searchable allowlist as a closed door", async () => {
    @Kavo(Todo, { query: { search: {} }, allowlists: { searchable: [] } })
    @Controller("todos")
    class EmptySearchableController {}

    await bootstrap(EmptySearchableController);
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const params = (document.paths["/todos"]?.get?.parameters ?? []) as { name: string; description?: string }[];
    const fields = params.find((param) => param.name === "search[fields]");
    expect(fields?.description).toBe("No field is searchable.");
  });
});

describe("KAVO_API_GUIDE", () => {
  it("documents the generic filter/sort/limit/offset/fields syntax once, for apps to splice into their own document description", () => {
    expect(KAVO_API_GUIDE).toContain("filter[field][operator]=value");
    expect(KAVO_API_GUIDE).toContain("'-' prefix = descending");
    expect(KAVO_API_GUIDE).toContain("clamped to the configured maximum");
    expect(KAVO_API_GUIDE).toContain("zero-based index");
    expect(KAVO_API_GUIDE).toContain("sparse fieldset");
  });

  it("documents the generic include/select[relation] syntax", () => {
    expect(KAVO_API_GUIDE).toContain("dot-separated for nesting");
    expect(KAVO_API_GUIDE).toContain("sparse fieldset for an included relation node");
  });

  it("documents the generic If-None-Match/If-Match conditional-request semantics", () => {
    expect(KAVO_API_GUIDE).toContain("a matching entity-tag answers 304 with no body");
    expect(KAVO_API_GUIDE).toContain("Take the tag from an unnarrowed read");
  });
});

describe("@Kavo Swagger conditional-request headers carry no per-route description", () => {
  @Kavo(Todo)
  @Controller("todos")
  class ConditionalController {}

  beforeEach(async () => {
    await bootstrap(ConditionalController);
  });

  it("documents If-None-Match/If-Match with no description — the semantics live only in KAVO_API_GUIDE", async () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    type HeaderParam = { name: string; in: string; description?: string };
    const getParams = (document.paths["/todos/{id}"]?.get?.parameters ?? []) as HeaderParam[];
    const putParams = (document.paths["/todos/{id}"]?.put?.parameters ?? []) as HeaderParam[];
    const ifNoneMatch = getParams.find((p) => p.name === "If-None-Match" && p.in === "header");
    const ifMatch = putParams.find((p) => p.name === "If-Match" && p.in === "header");
    expect(ifNoneMatch?.description).toBeUndefined();
    expect(ifMatch?.description).toBeUndefined();
  });
});

/**
 * ORM-derived fields over the wire (issue #373): `@kavo/nest` needs no
 * changes for them either — generated routes go through the same engine,
 * so the serializer reads a derived value straight off the row and the
 * allowlists gate it exactly as they do programmatically. This is the
 * wire-level evidence for that claim, using a fake `FieldMetadata` entry
 * with a `derivedExpression` marker in place of a real ORM's virtual
 * column (`@kavo/typeorm`'s own suite covers the actual SQL translation).
 */
describe("@Kavo ORM-derived fields over the wire (issue #373)", () => {
  const derivedTodoMetadata: EntityMetadata<Todo> = {
    ...todoMetadata,
    fields: [
      ...todoMetadata.fields,
      { name: "slug", kind: "string", nullable: true, generated: false, derivedExpression: "lower(title)" },
    ],
  };

  function fakeDerivedInfrastructure(fakeAdapter: InMemoryTodoAdapter): KavoInfrastructure {
    return {
      metadataFor<Entity extends object>(entity: ClassRef<Entity>) {
        if ((entity as ClassRef) === Todo) {
          return derivedTodoMetadata as unknown as EntityMetadata<Entity>;
        }
        return fakeInfrastructure(fakeAdapter).metadataFor(entity);
      },
      adapterFor<Entity extends object>() {
        return fakeAdapter as unknown as RepositoryAdapter<Entity>;
      },
    };
  }

  it("excludes an un-opted-in derived field from the generated read routes", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class TodoController {}

    adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRoot({ infrastructure: fakeDerivedInfrastructure(adapter) }),
        KavoModule.forFeature([TodoController as never]),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    httpServer = await listen(app);
    adapter.rows.push({ ...new Todo(), id: 1, title: "Write Docs", slug: "write-docs" } as never);

    expect((await request(server()).get("/todos/1").expect(200)).body).not.toHaveProperty("slug");
  });

  it("emits an opted-in derived field, read straight off the row", async () => {
    @Kavo(Todo, { allowlists: { selectable: ["id", "title", "done", "priority", "slug" as never] } })
    @Controller("todos")
    class TodoController {}

    adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRoot({ infrastructure: fakeDerivedInfrastructure(adapter) }),
        KavoModule.forFeature([TodoController as never]),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    httpServer = await listen(app);
    adapter.rows.push({ ...new Todo(), id: 1, title: "Write Docs", slug: "write-docs" } as never);

    expect((await request(server()).get("/todos/1").expect(200)).body).toMatchObject({ slug: "write-docs" });
    expect((await request(server()).get("/todos/1?select=id,slug").expect(200)).body).toEqual({
      id: 1,
      slug: "write-docs",
    });
  });

  it("rejects it as a filter or sort field with problem details when not opted in", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class TodoController {}

    adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRoot({ infrastructure: fakeDerivedInfrastructure(adapter) }),
        KavoModule.forFeature([TodoController as never]),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    httpServer = await listen(app);

    for (const query of ["filter[slug][eq]=write-docs", "sort=slug"]) {
      const response = await request(server()).get(`/todos?${query}`).expect(400);
      expect(response.body).toMatchObject({
        code: "KAVO_QUERY_INVALID",
        errors: [{ field: "slug", code: "KAVO_QUERY_INVALID_FIELD" }],
      });
    }
  });

  it("never reaches the adapter from a request body", async () => {
    @Kavo(Todo, { allowlists: { selectable: ["id", "title", "done", "priority", "slug" as never] } })
    @Controller("todos")
    class TodoController {}

    adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRoot({ infrastructure: fakeDerivedInfrastructure(adapter) }),
        KavoModule.forFeature([TodoController as never]),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    httpServer = await listen(app);

    await request(server()).post("/todos").send({ title: "Ship It", slug: "hijacked" }).expect(201);
    expect(adapter.rows[0]).not.toHaveProperty("slug");
  });

  it("fails at bind time when a registered create DTO declares the derived field", async () => {
    // The wire consequence this closes: `@ApiBody` is built from the DTO's
    // runtime shape, so a DTO naming a derived field made OpenAPI advertise
    // a property the engine unconditionally discards. Rejected at
    // `createCrud` now, which in a Nest app is provider instantiation.
    class CreateTodoDto {
      title = "";
      slug = "";
    }

    @Kavo(Todo, { dto: { create: CreateTodoDto } })
    @Controller("todos")
    class DerivedDtoController {}

    const bind = async (): Promise<unknown> => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          KavoModule.forRoot({ infrastructure: fakeDerivedInfrastructure(new InMemoryTodoAdapter()) }),
          KavoModule.forFeature([DerivedDtoController as never]),
        ],
      }).compile();
      return moduleRef.createNestApplication().init();
    };
    await expect(bind()).rejects.toMatchObject({
      code: "KAVO_CONFIG_INVALID",
      messageParams: { entity: "Todo", path: "dto.create" },
    });
  });
});

describe("@Kavo Swagger — per-operation DTO overrides are what gets documented", () => {
  /**
   * The engine deserializes through `descriptor.input` and serializes
   * through `descriptor.output` ahead of the entity's root slots, so
   * documenting the slot alone would publish a shape no request or
   * response actually has. `packages/core` covers the registry side of
   * this; nothing covered the OpenAPI side, which meant an override could
   * ship documented as the wrong shape with no test to catch it.
   */
  class RootCreateDto {
    title = "";
    priority = 0;
  }
  class OverrideCreateDto {
    title = "";
    urgency = 0;
  }
  class RootUpdateDto {
    title = "";
    done = false;
  }
  class RootItemDto {
    id = 0;
    title = "";
  }
  class OverrideCreatedDto {
    id = 0;
    done = false;
  }

  @Kavo(Todo, {
    dto: { create: RootCreateDto, update: RootUpdateDto, item: RootItemDto },
    operations: {
      findOne: true,
      updateOne: true,
      createOne: { dto: { input: OverrideCreateDto, output: OverrideCreatedDto } },
    },
  })
  @Controller("todos")
  class OverriddenDtoController {}

  type Schema = { properties?: Record<string, unknown> };

  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeEach(async () => {
    await bootstrap(OverriddenDtoController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
  });

  const requestSchema = (path: string, verb: string): Schema | undefined =>
    (document.paths[path] as Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>)?.[
      verb
    ]?.requestBody?.content?.["application/json"]?.schema;

  const responseSchema = (path: string, verb: string, status: string): Schema | undefined =>
    (
      document.paths[path] as Record<
        string,
        { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }
      >
    )?.[verb]?.responses?.[status]?.content?.["application/json"]?.schema;

  it("documents the operation's input override ahead of the entity's create slot", () => {
    expect(Object.keys(requestSchema("/todos", "post")?.properties ?? {})).toEqual(["title", "urgency"]);
  });

  it("documents the operation's output override ahead of the entity's item slot", () => {
    expect(Object.keys(responseSchema("/todos", "post", "201")?.properties ?? {})).toEqual(["id", "done"]);
  });

  it("leaves operations that declared no override on the root slots", () => {
    // The override is scoped, not global: `findOne` still documents `item`.
    expect(Object.keys(responseSchema("/todos/{id}", "get", "200")?.properties ?? {})).toEqual(["id", "title"]);
  });

  it("does not leak an operation's input override onto a sibling operation's body", () => {
    // `updateOne` declared no override, so it documents the root `update`
    // slot — not `createOne`'s override and not `createOne`'s slot either.
    expect(Object.keys(requestSchema("/todos/{id}", "put")?.properties ?? {})).toEqual(["title", "done"]);
  });
});

describe("@Kavo Swagger request-body schemas", () => {
  class CreateTodoDto {
    title = "";
    priority = 0;
    done = false;
  }

  class TodoItemDto {
    id = 0;
    title = "";
    done = false;
  }

  class TodoListDto {
    id = 0;
    title = "";
  }

  @Kavo(Todo, {
    dto: { create: CreateTodoDto, item: TodoItemDto, list: TodoListDto },
  })
  @Controller("todos")
  class DocumentedController {}

  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeEach(async () => {
    await bootstrap(DocumentedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
  });

  type Schema = {
    type?: string;
    properties?: Record<string, Schema>;
    items?: Schema;
    required?: string[];
    additionalProperties?: boolean;
    description?: string;
    "x-kavo-entity"?: string;
  };

  const responseSchema = (op: string, status: string): Schema | undefined =>
    (
      document.paths["/todos"] as Record<
        string,
        { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }
      >
    )?.[op]?.responses?.[status]?.content?.["application/json"]?.schema;

  const itemSchema = (op: string, path: string, status: string): Schema | undefined =>
    (
      document.paths[path] as Record<
        string,
        { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }
      >
    )?.[op]?.responses?.[status]?.content?.["application/json"]?.schema;

  it("documents the create body with the DTO's runtime shape", async () => {
    const schema = (
      document.paths["/todos"] as Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>
    )?.["post"]?.requestBody?.content?.["application/json"]?.schema;

    // The body renders with real fields (not an empty {}): the bug was an
    // empty schema because @nestjs/swagger can't read runtime initializers.
    expect(schema?.properties).toBeDefined();
    expect(Object.keys(schema?.properties ?? {})).toEqual(["title", "priority", "done"]);
    expect(schema?.properties?.title).toEqual({ type: "string" });
    expect(schema?.properties?.priority).toEqual({ type: "integer" });
    expect(schema?.properties?.done).toEqual({ type: "boolean" });
    // Links the schema back to the entity it belongs to (issue #294).
    expect(schema?.["x-kavo-entity"]).toBe("Todo");
  });

  it("distinguishes the JSON number types a field initializer can imply", async () => {
    // `jsonSchemaForValue` reads the runtime initializer, so an integer and
    // a fractional default are different documented types, and a `bigint`
    // documents as an integer rather than falling through to `{}`.
    class NumericDto {
      count = 0;
      ratio = 1.5;
      ticket = 0n;
    }
    @Kavo(Todo, { dto: { create: NumericDto } })
    @Controller("todos")
    class NumericController {}

    await app.close();
    await bootstrap(NumericController);
    const numericDocument = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("t").setVersion("0").build(),
    );
    const schema = (
      numericDocument.paths["/todos"] as Record<
        string,
        { requestBody?: { content?: Record<string, { schema?: Schema }> } }
      >
    )?.["post"]?.requestBody?.content?.["application/json"]?.schema;

    expect(schema?.properties?.count).toEqual({ type: "integer" });
    expect(schema?.properties?.ratio).toEqual({ type: "number" });
    expect(schema?.properties?.ticket).toEqual({ type: "integer" });
  });

  it("keeps a field whose initializer says nothing about its type, as an open schema", async () => {
    // The key still has to appear: dropping it would publish a body schema
    // that omits a field the DTO genuinely accepts.
    class LooseDto {
      title = "";
      note = undefined;
    }
    @Kavo(Todo, { dto: { create: LooseDto } })
    @Controller("todos")
    class LooseController {}

    await app.close();
    await bootstrap(LooseController);
    const looseDocument = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("t").setVersion("0").build(),
    );
    const schema = (
      looseDocument.paths["/todos"] as Record<
        string,
        { requestBody?: { content?: Record<string, { schema?: Schema }> } }
      >
    )?.["post"]?.requestBody?.content?.["application/json"]?.schema;

    expect(Object.keys(schema?.properties ?? {})).toContain("note");
    expect(schema?.properties?.note).toEqual({});
  });

  it("defers to Swagger's own introspection for a DTO with no runtime own properties", async () => {
    // A declared-only DTO (`title!: string`) erases at runtime, so there
    // are no initializers to read. Emitting an empty inline schema would
    // publish "this endpoint takes nothing"; handing Swagger the class
    // lets its own decorators answer instead.
    class DeclaredOnlyDto {
      title!: string;
    }
    @Kavo(Todo, { dto: { create: DeclaredOnlyDto } })
    @Controller("todos")
    class DeclaredOnlyController {}

    await app.close();
    await bootstrap(DeclaredOnlyController);
    const declaredDocument = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("t").setVersion("0").build(),
    );
    const body = (
      declaredDocument.paths["/todos"] as Record<
        string,
        { requestBody?: { content?: Record<string, { schema?: Schema & { $ref?: string } }> } }
      >
    )?.["post"]?.requestBody?.content?.["application/json"]?.schema;

    expect(body?.properties).toBeUndefined();
    expect(body?.$ref).toContain("DeclaredOnlyDto");
  });

  it("documents create/put/patch/get-item responses with the item DTO", () => {
    for (const [op, path, status] of [
      ["post", "/todos", "201"],
      ["put", "/todos/{id}", "200"],
      ["patch", "/todos/{id}", "200"],
      ["get", "/todos/{id}", "200"],
    ] as const) {
      const schema = itemSchema(op, path, status);
      expect(Object.keys(schema?.properties ?? {})).toEqual(["id", "title", "done"]);
    }
  });

  it("documents the collection response with the list envelope", () => {
    const schema = responseSchema("get", "200");
    expect(Object.keys(schema?.properties ?? {})).toEqual(["items", "limit", "offset", "total", "meta"]);
    // Envelope items use the leaner `list` DTO projection.
    expect(Object.keys(schema?.properties?.items?.items?.properties ?? {})).toEqual(["id", "title"]);
    // The list-envelope element carries the entity link too (issue #294).
    expect(schema?.properties?.items?.items?.["x-kavo-entity"]).toBe("Todo");
  });

  it("marks meta as the one envelope field a client cannot assume is present", () => {
    // `meta` is omitted from the body unless a `findMany` handler
    // contributes, so the published schema has to say so — otherwise
    // generated clients type it as always-there and read `.meta.x`.
    const schema = responseSchema("get", "200");
    expect(schema?.required).toEqual(["items", "limit", "offset", "total"]);
    expect(schema?.required).not.toContain("meta");
  });

  it("documents meta as an open bag rather than an object with no permitted keys", () => {
    // `ListMetaDto` has no static shape to enumerate at decoration time, so
    // this is the one envelope field `schemaFromDto` cannot describe. A bare
    // `{ type: "object" }` with no `properties` reads to most OpenAPI
    // generators as "no keys allowed", which is the opposite of the truth.
    const meta = responseSchema("get", "200")?.properties?.meta;
    expect(meta?.type).toBe("object");
    expect(meta?.additionalProperties).toBe(true);
    expect(meta?.description).toContain("findMany");
  });

  type Operation = {
    parameters?: readonly { name: string; in: string }[];
    responses?: Record<string, { headers?: Record<string, unknown>; description?: string }>;
  };
  const operation = (path: string, verb: string): Operation | undefined =>
    (document.paths[path] as Record<string, Operation> | undefined)?.[verb];
  const headerNames = (path: string, verb: string): readonly string[] =>
    (operation(path, verb)?.parameters ?? []).filter((p) => p.in === "header").map((p) => p.name);

  it("documents the conditional-request surface the routes actually serve", () => {
    // The sibling 409 on restore/purge was documented from the start;
    // 412/304 and the two request headers were the gap.
    expect(headerNames("/todos/{id}", "get")).toContain("If-None-Match");
    expect(operation("/todos/{id}", "get")?.responses?.["304"]).toBeDefined();

    for (const verb of ["put", "patch", "delete"] as const) {
      expect(headerNames("/todos/{id}", verb)).toContain("If-Match");
      expect(operation("/todos/{id}", verb)?.responses?.["412"]).toBeDefined();
    }
  });

  it("documents the ETag response header on tagged responses only", () => {
    expect(operation("/todos/{id}", "get")?.responses?.["200"]?.headers).toHaveProperty("ETag");
    expect(operation("/todos", "post")?.responses?.["201"]?.headers).toHaveProperty("ETag");
    // A collection carries no tag, and a 204 carries no body to tag.
    expect(operation("/todos", "get")?.responses?.["200"]?.headers).toBeUndefined();
    expect(operation("/todos/{id}", "delete")?.responses?.["204"]?.headers).toBeUndefined();
  });

  it("stays idempotent across the repeated bootstraps `beforeEach` gives DocumentedController (issue #198)", () => {
    // `applyConditionalRequestDocs` runs again on every `onModuleInit`, but
    // `DocumentedController`'s decorated methods are the same function
    // objects across every `it` in this block — a second boot must not
    // double up the header/response metadata `@nestjs/swagger` only ever
    // appends or merges onto them.
    expect(headerNames("/todos/{id}", "get").filter((name) => name === "If-None-Match")).toHaveLength(1);
    expect(operation("/todos/{id}", "get")?.responses?.["200"]?.description).toBe("Success");
  });

  it("documents nothing conditional when cache.etag is off for the entity", async () => {
    @Kavo(Todo, { cache: { etag: false } })
    @Controller("todos")
    class UncachedController {}
    await app.close();
    await bootstrap(UncachedController);
    const uncached = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
    const patch = (uncached.paths["/todos/{id}"] as Record<string, Operation>)["patch"];

    expect((patch?.parameters ?? []).filter((p) => p.in === "header")).toHaveLength(0);
    expect(patch?.responses?.["412"]).toBeUndefined();
    expect(patch?.responses?.["200"]?.headers).toBeUndefined();
  });

  it("documents nothing conditional when cache.etag is off at the global scope (issue #198)", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class GlobalUncachedController {}
    await app.close();
    await bootstrap(GlobalUncachedController, { defaults: { cache: { etag: false } } });
    const uncached = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
    const get = (uncached.paths["/todos/{id}"] as Record<string, Operation>)["get"];
    const patch = (uncached.paths["/todos/{id}"] as Record<string, Operation>)["patch"];

    expect((get?.parameters ?? []).filter((p) => p.in === "header")).toHaveLength(0);
    expect(get?.responses?.["304"]).toBeUndefined();
    expect(get?.responses?.["200"]?.headers).toBeUndefined();
    expect((patch?.parameters ?? []).filter((p) => p.in === "header")).toHaveLength(0);
    expect(patch?.responses?.["412"]).toBeUndefined();
    expect(patch?.responses?.["200"]?.headers).toBeUndefined();
  });

  it("an entity-scoped cache.etag still wins over a global default (issue #198)", async () => {
    @Kavo(Todo, { cache: { etag: true } })
    @Controller("todos")
    class ReenabledCachingController {}
    await app.close();
    await bootstrap(ReenabledCachingController, { defaults: { cache: { etag: false } } });
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
    const get = (document.paths["/todos/{id}"] as Record<string, Operation>)["get"];

    expect((get?.parameters ?? []).filter((p) => p.in === "header").map((p) => p.name)).toContain("If-None-Match");
    expect(get?.responses?.["304"]).toBeDefined();
    expect(get?.responses?.["200"]?.headers).toHaveProperty("ETag");
  });
});

describe("@Kavo Swagger fallback request-body schema when no DTO is configured (issue #264)", () => {
  type Schema = {
    type?: string;
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean;
    description?: string;
    "x-kavo-entity"?: string;
  };

  const bodySchema = (path: string, verb: string): Schema | undefined =>
    (document.paths[path] as Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>)?.[
      verb
    ]?.requestBody?.content?.["application/json"]?.schema;

  let document: ReturnType<typeof SwaggerModule.createDocument>;

  // A tiny entity whose writable columns cover both nullability cases and an
  // all-nullable case, so `required` derivation can be pinned without
  // touching the shared `Todo` fixture every other test asserts exact keys
  // against.
  const withMetadata = async (
    fields: EntityMetadata<object>["fields"],
    relations: EntityMetadata<object>["relations"] = [],
    config?: unknown,
  ) => {
    class Note {}
    const metadata: EntityMetadata<object> = {
      entity: Note,
      name: "Note",
      idField: "id",
      fields,
      relations,
    };
    const adapter = {
      findOneById: async () => null,
      findOne: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async (data: unknown) => data,
      update: async (_id: unknown, data: unknown) => data,
      patch: async (_id: unknown, data: unknown) => data,
      delete: async () => {},
      restore: async () => {
        throw new Error("not exercised");
      },
      purge: async () => {},
    } as unknown as RepositoryAdapter<object>;
    const infrastructure: KavoInfrastructure = {
      metadataFor: () => metadata as never,
      adapterFor: () => adapter as never,
    };

    @Controller("notes")
    class NoteController {}
    Kavo(Note, config as Parameters<typeof Kavo>[1])(NoteController);

    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure }), KavoModule.forFeature([NoteController])],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
  };

  it("lists non-nullable writable columns in `required` for create/update, but never for patch", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class NoDtoController {}
    await bootstrap(NoDtoController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    // Every writable `Todo` column (`title`/`done`/`priority`) is non-nullable.
    expect(bodySchema("/todos", "post")?.required).toEqual(["title", "done", "priority"]);
    expect(bodySchema("/todos/{id}", "put")?.required).toEqual(["title", "done", "priority"]);
    // A partial update requires nothing regardless of nullability.
    expect(bodySchema("/todos/{id}", "patch")?.required).toBeUndefined();
  });

  it("omits a nullable writable column from `required`", async () => {
    await withMetadata([
      { name: "id", kind: "number", nullable: false, generated: true },
      { name: "title", kind: "string", nullable: false, generated: false },
      { name: "note", kind: "string", nullable: true, generated: false },
    ]);
    expect(Object.keys(bodySchema("/notes", "post")?.properties ?? {})).toEqual(["title", "note"]);
    expect(bodySchema("/notes", "post")?.required).toEqual(["title"]);
  });

  it("omits `required` entirely when every writable column is nullable", async () => {
    await withMetadata([
      { name: "id", kind: "number", nullable: false, generated: true },
      { name: "note", kind: "string", nullable: true, generated: false },
    ]);
    const schema = bodySchema("/notes", "post");
    expect(Object.keys(schema?.properties ?? {})).toEqual(["note"]);
    expect(schema?.required).toBeUndefined();
  });

  it("documents create/update/patch bodies from creatable/updatable when no DTO is registered", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class NoDtoController {}
    await bootstrap(NoDtoController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    // `id` (the primary key) and `deletedAt` (generated) are excluded —
    // `creatable`'s/`updatable`'s own unconfigured default already excludes
    // them (`resolve-entity-config.ts`'s `writableBase`), and this schema
    // must document exactly that set, not every column on the entity.
    for (const [verb, path] of [
      ["post", "/todos"],
      ["put", "/todos/{id}"],
      ["patch", "/todos/{id}"],
    ] as const) {
      const schema = bodySchema(path, verb);
      // `list` is a to-one relation on `Todo` — it has no `metadata.fields`
      // entry but is on the default `creatable`/`updatable` allowlist
      // (associable by id, ADR-0014), so it must be documented, not dropped
      // (issue #339).
      expect(Object.keys(schema?.properties ?? {})).toEqual(["title", "done", "priority", "list"]);
      expect(schema?.properties?.title).toEqual({ type: "string" });
      expect(schema?.properties?.done).toEqual({ type: "boolean" });
      expect(schema?.properties?.priority).toEqual({ type: "number" });
      expect(schema?.properties?.list).toEqual({
        type: "object",
        nullable: true,
        // `id` is typed from `TodoList`'s own metadata (a number column),
        // not left as a bare `{}` (issue #339 follow-up).
        properties: { id: { type: "number" } },
        required: ["id"],
        description: "Associate by id (ADR-0014); pass `null` to disassociate.",
      });
      // A relation never joins the outer `required` list — no nullability
      // is derivable for it.
      expect(schema?.required ?? []).not.toContain("list");
      // `creatable`/`updatable` narrow silently (an unknown body key is
      // dropped, not rejected), so the synthesized schema must not declare
      // itself closed — that would tell a validating client a body Kavo
      // actually accepts is invalid.
      expect(schema?.additionalProperties).toBeUndefined();
      // The fallback schema still links back to the entity (issue #294).
      expect(schema?.["x-kavo-entity"]).toBe("Todo");
    }
  });

  it("documents an explicit empty creatable/updatable allowlist as closed via description, not silence", async () => {
    @Kavo(Todo, { allowlists: { creatable: [], updatable: [] } })
    @Controller("todos")
    class ClosedController {}
    await bootstrap(ClosedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    const schema = bodySchema("/todos", "post");
    expect(schema?.properties).toEqual({});
    expect(schema?.description).toBe("No field is writable.");
  });

  it("documents a relation-only writable projection instead of an empty, bodyless-looking schema (issue #339)", async () => {
    await withMetadata(
      // The whole entity is a generated id plus two relations — nothing the
      // scalar-column loop can match.
      [{ name: "id", kind: "string", nullable: false, generated: true }],
      [
        { name: "word", target: () => class {}, cardinality: "one", includable: false, strategy: "auto" },
        { name: "tags", target: () => class {}, cardinality: "many", includable: false, strategy: "auto" },
      ],
    );

    const schema = bodySchema("/notes", "post");
    // Before #339 this was `{}` with no `description` — read by a client
    // generator as "POST /notes takes no body", which is false.
    expect(Object.keys(schema?.properties ?? {})).toEqual(["word", "tags"]);
    expect(schema?.description).toBeUndefined();
    // `id` is typed from the resolved target metadata (this fixture's
    // `metadataFor` yields a string-id entity for every target).
    expect(schema?.properties?.word).toEqual({
      type: "object",
      nullable: true,
      properties: { id: { type: "string" } },
      required: ["id"],
      description: "Associate by id (ADR-0014); pass `null` to disassociate.",
    });
    // A to-many relation takes an array of reference objects (ADR-0014).
    expect(schema?.properties?.tags).toEqual({
      type: "array",
      nullable: true,
      items: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        description: "Associate by id (ADR-0014); pass `null` to disassociate.",
      },
    });
    // No nullability is derivable for a relation, so none joins `required`.
    expect(schema?.required).toBeUndefined();
    // Still not declared closed — an unknown body key is dropped, not rejected.
    expect(schema?.additionalProperties).toBeUndefined();
  });

  it("still reads as closed when a non-empty allowlist resolves to zero documentable properties", async () => {
    // `creatable` explicitly names a `generated` column — a real, non-empty
    // allowlist — but the synthesized-schema loop skips generated columns,
    // so it produces zero properties. The "no body" description must still
    // appear: it is gated on the property count, not the allowlist length.
    await withMetadata([{ name: "id", kind: "string", nullable: false, generated: true }], [], {
      allowlists: { creatable: ["id"], updatable: ["id"] },
    });

    const schema = (
      document.paths["/notes"] as Record<
        string,
        { requestBody?: { content?: Record<string, { schema?: { properties?: object; description?: string } }> } }
      >
    )?.post?.requestBody?.content?.["application/json"]?.schema;
    expect(schema?.properties).toEqual({});
    expect(schema?.description).toBe("No field is writable.");
  });

  it("narrows the documented body to an explicit creatable/updatable allowlist", async () => {
    @Kavo(Todo, { allowlists: { creatable: ["title"], updatable: ["done"] } })
    @Controller("todos")
    class NarrowedController {}
    await bootstrap(NarrowedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    expect(Object.keys(bodySchema("/todos", "post")?.properties ?? {})).toEqual(["title"]);
    expect(Object.keys(bodySchema("/todos/{id}", "put")?.properties ?? {})).toEqual(["done"]);
    expect(Object.keys(bodySchema("/todos/{id}", "patch")?.properties ?? {})).toEqual(["done"]);
  });

  it("leaves a configured DTO's own documented body untouched", async () => {
    class CreateTodoDto {
      title = "";
    }
    @Kavo(Todo, { dto: { create: CreateTodoDto } })
    @Controller("todos")
    class DtoController {}
    await bootstrap(DtoController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    // The create body comes from the DTO alone; the fallback must not also
    // run and, say, widen it back out to every writable column.
    expect(Object.keys(bodySchema("/todos", "post")?.properties ?? {})).toEqual(["title"]);
    // No DTO is registered for update/patch, so those still fall back.
    expect(Object.keys(bodySchema("/todos/{id}", "put")?.properties ?? {})).toEqual([
      "title",
      "done",
      "priority",
      "list",
    ]);
  });

  it("stays idempotent across repeated bootstraps of the same controller", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class RepeatedController {}
    await bootstrap(RepeatedController);
    await app.close();
    await bootstrap(RepeatedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    // A second `ApiBody` application would overwrite rather than duplicate
    // properties here, so this mainly documents that no crash/duplicate
    // registration happens across repeated `onModuleInit` runs.
    expect(Object.keys(bodySchema("/todos", "post")?.properties ?? {})).toEqual(["title", "done", "priority", "list"]);
  });

  // Boot a relation-only entity against an infrastructure that resolves the
  // routed entity and each relation target separately, so the `{ id }`
  // reference object's type can be pinned to the *target's* metadata rather
  // than the source's (the pre-change code read neither — it emitted `{}`).
  const withDiscriminatingMetadata = async (
    source: EntityMetadata<object>,
    resolve: (entity: unknown) => EntityMetadata<object>,
    config?: unknown,
  ) => {
    const adapter = {
      findOneById: async () => null,
      findOne: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async (data: unknown) => data,
      update: async (_id: unknown, data: unknown) => data,
      patch: async (_id: unknown, data: unknown) => data,
      delete: async () => {},
      restore: async () => {
        throw new Error("not exercised");
      },
      purge: async () => {},
    } as unknown as RepositoryAdapter<object>;
    const infrastructure: KavoInfrastructure = {
      metadataFor: ((entity: unknown) => (entity === source.entity ? source : resolve(entity))) as never,
      adapterFor: () => adapter as never,
    };
    @Controller("notes")
    class NoteController {}
    Kavo(source.entity as new () => object, config as Parameters<typeof Kavo>[1])(NoteController);
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure }), KavoModule.forFeature([NoteController])],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
  };

  const relationOnlySource = (): EntityMetadata<object> => {
    class Note {}
    return {
      entity: Note,
      name: "Note",
      idField: "id",
      // A number id on the source, so a target with a string id proves the
      // reference-object `id` is read from the target, not from here.
      fields: [{ name: "id", kind: "number", nullable: false, generated: true }],
      relations: [
        { name: "word", target: () => class Word {}, cardinality: "one", includable: false, strategy: "auto" },
      ],
    };
  };

  it("types the reference-object `id` from the relation target's metadata, not the source entity's (issue #339)", async () => {
    class Word {}
    const wordMetadata: EntityMetadata<object> = {
      entity: Word,
      name: "Word",
      idField: "id",
      fields: [{ name: "id", kind: "string", nullable: false, generated: true }],
      relations: [],
    };
    await withDiscriminatingMetadata(relationOnlySource(), () => wordMetadata, {
      allowlists: { creatable: ["word"], updatable: ["word"] },
    });

    expect(bodySchema("/notes", "post")?.properties?.word).toEqual({
      type: "object",
      nullable: true,
      properties: { id: { type: "string" } },
      required: ["id"],
      description: "Associate by id (ADR-0014); pass `null` to disassociate.",
    });
  });

  it("leaves the reference-object `id` untyped when the relation target's metadata is unresolvable (issue #339)", async () => {
    await withDiscriminatingMetadata(
      relationOnlySource(),
      () => {
        throw new Error("no metadata for this relation target from this root");
      },
      { allowlists: { creatable: ["word"], updatable: ["word"] } },
    );

    // Bootstrap survived the throw, and the field falls back to the
    // pre-change untyped shape rather than being dropped.
    expect(bodySchema("/notes", "post")?.properties?.word).toEqual({
      type: "object",
      nullable: true,
      properties: { id: {} },
      required: ["id"],
      description: "Associate by id (ADR-0014); pass `null` to disassociate.",
    });
  });

  it("leaves the reference-object `id` untyped for a composite-key relation target (issue #339)", async () => {
    class Word {}
    const wordMetadata: EntityMetadata<object> = {
      entity: Word,
      name: "Word",
      idField: "orgId",
      compositeIdFields: ["orgId", "lemma"],
      fields: [
        { name: "orgId", kind: "string", nullable: false, generated: false },
        { name: "lemma", kind: "string", nullable: false, generated: false },
      ],
      relations: [],
    };
    await withDiscriminatingMetadata(relationOnlySource(), () => wordMetadata, {
      allowlists: { creatable: ["word"], updatable: ["word"] },
    });

    // A single scalar `id` would be a wrong assertion for a two-column key,
    // so it stays `{}` — honestly vague beats confidently wrong.
    expect(bodySchema("/notes", "post")?.properties?.word?.properties).toEqual({ id: {} });
  });

  it.each([
    {
      label: "date",
      field: { name: "id", kind: "date", nullable: false, generated: true },
      expected: { type: "string", format: "date-time" },
    },
    {
      label: "enum",
      field: { name: "id", kind: "enum", nullable: false, generated: false, enumValues: ["a", "b"] },
      expected: { type: "string", enum: ["a", "b"] },
    },
  ])("types the reference-object `id` for a $label target id kind (issue #339)", async ({ field, expected }) => {
    class Word {}
    const wordMetadata: EntityMetadata<object> = {
      entity: Word,
      name: "Word",
      idField: "id",
      fields: [field as EntityMetadata<object>["fields"][number]],
      relations: [],
    };
    await withDiscriminatingMetadata(relationOnlySource(), () => wordMetadata, {
      allowlists: { creatable: ["word"], updatable: ["word"] },
    });
    expect(bodySchema("/notes", "post")?.properties?.word?.properties?.id).toEqual(expected);
  });
});

describe("@Kavo Swagger fallback success-response schema when no item/list DTO is configured (issue #264)", () => {
  type Schema = {
    type?: string;
    properties?: Record<string, Schema>;
    items?: Schema;
    required?: string[];
    description?: string;
    $ref?: string;
    "x-kavo-entity"?: string;
  };

  const itemBody = (path: string, verb: string, status: string): Schema | undefined =>
    (
      document.paths[path] as Record<
        string,
        { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }
      >
    )?.[verb]?.responses?.[status]?.content?.["application/json"]?.schema;

  let document: ReturnType<typeof SwaggerModule.createDocument>;

  /** `todoMetadata` plus an ORM-derived `titleUpper` field (issue #373). */
  const derivedTodoMetadata: EntityMetadata<Todo> = {
    ...todoMetadata,
    fields: [
      ...todoMetadata.fields,
      { name: "titleUpper", kind: "string", nullable: true, generated: false, derivedExpression: "upper(title)" },
    ],
  };

  async function bootstrapDerived(controller: unknown): Promise<void> {
    const derivedInfrastructure: KavoInfrastructure = {
      metadataFor: (entity) =>
        (entity as ClassRef) === Todo
          ? (derivedTodoMetadata as never)
          : fakeInfrastructure(adapter).metadataFor(entity),
      adapterFor: () => adapter as never,
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRoot({ infrastructure: derivedInfrastructure }),
        KavoModule.forFeature([controller as never]),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }

  it("narrows the item response to selectable when no item DTO is registered", async () => {
    @Kavo(Todo, { allowlists: { selectable: ["id", "title"] } })
    @Controller("todos")
    class NarrowedController {}
    await bootstrap(NarrowedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    for (const [verb, path, status] of [
      ["post", "/todos", "201"],
      ["put", "/todos/{id}", "200"],
      ["patch", "/todos/{id}", "200"],
      ["get", "/todos/{id}", "200"],
    ] as const) {
      const schema = itemBody(path, verb, status);
      expect(Object.keys(schema?.properties ?? {})).toEqual(["id", "title"]);
      // The fallback response schema still links back to the entity
      // (issue #294).
      expect(schema?.["x-kavo-entity"]).toBe("Todo");
    }
  });

  it("narrows the list envelope's element to selectable when no list/item DTO is registered", async () => {
    @Kavo(Todo, { allowlists: { selectable: ["id", "title"] } })
    @Controller("todos")
    class NarrowedController {}
    await bootstrap(NarrowedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    const items = itemBody("/todos", "get", "200")?.properties?.items;
    expect(Object.keys(items?.items?.properties ?? {})).toEqual(["id", "title"]);
    expect(items?.items?.["x-kavo-entity"]).toBe("Todo");
  });

  it("documents every own column when selectable is left unconfigured, relations excluded", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class UnconfiguredController {}
    await bootstrap(UnconfiguredController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    // `selectable`'s own unconfigured default is every own column
    // (`resolve-entity-config.ts`), and `list` (the to-one relation) isn't
    // one of `EntityMetadata.fields`. A relation only appears here when it
    // is on `allowlists.includable` (issue #349), which it is not here, so
    // the synthesized item schema stays scalar-only.
    expect(Object.keys(itemBody("/todos/{id}", "get", "200")?.properties ?? {})).toEqual([
      "id",
      "title",
      "done",
      "priority",
      "deletedAt",
    ]);
  });

  it("lists non-nullable selectable columns in `required` on the item and list-element schemas", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class UnconfiguredController {}
    await bootstrap(UnconfiguredController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    // `deletedAt` is the one nullable `Todo` column, so it stays optional.
    const single = itemBody("/todos/{id}", "get", "200");
    expect(single?.required).toEqual(["id", "title", "done", "priority"]);

    const envelope = itemBody("/todos", "get", "200");
    // The envelope's own `required` is unchanged.
    expect(envelope?.required).toEqual(["items", "limit", "offset", "total"]);
    expect(envelope?.properties?.items?.items?.required).toEqual(["id", "title", "done", "priority"]);
  });

  it("keeps a nullable, opted-in derived field out of the synthesized response `required` (issue #302, #373)", async () => {
    @Kavo(Todo, { allowlists: { selectable: ["id", "title", "done", "priority", "titleUpper" as never] } })
    @Controller("todos")
    class DerivedController {}
    await bootstrapDerived(DerivedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    expect(itemBody("/todos/{id}", "get", "200")?.required).not.toContain("titleUpper");
  });

  it("leaves a configured item DTO's own documented response untouched", async () => {
    class TodoItemDto {
      id = 0;
      title = "";
    }
    @Kavo(Todo, { dto: { item: TodoItemDto }, allowlists: { selectable: ["id"] } })
    @Controller("todos")
    class DtoController {}
    await bootstrap(DtoController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    // The item DTO's own runtime shape wins over `selectable` entirely —
    // narrower or not — the same precedence `bodyDtoFor` already gives a
    // registered write DTO.
    expect(Object.keys(itemBody("/todos/{id}", "get", "200")?.properties ?? {})).toEqual(["id", "title"]);
  });

  it("wins over decoration time's { type } fallback for an entity with no own enumerable properties", async () => {
    // A real ORM entity typically declares columns without initializers
    // (`title!: string`), so `new Entity()` has no own properties and
    // `successBodyFor` documents `{ type: entity }` at decoration time, not
    // `{ schema }`. `applyResponseSchemaDocs` must still win: a lingering
    // `type` on the merged response entry would make `@nestjs/swagger`
    // ignore the narrowed `schema` outright and emit a `$ref` instead
    // (`ResponseObjectFactory.create` branches on `type` truthiness).
    class DeclaredOnlyEntity {
      id!: number;
      title!: string;
      secret!: string;
    }
    const declaredMetadata: EntityMetadata<DeclaredOnlyEntity> = {
      entity: DeclaredOnlyEntity,
      name: "DeclaredOnlyEntity",
      idField: "id",
      fields: [
        { name: "id", kind: "number", nullable: false, generated: true },
        { name: "title", kind: "string", nullable: false, generated: false },
        { name: "secret", kind: "string", nullable: false, generated: false },
      ],
      relations: [],
    };
    const declaredAdapter: RepositoryAdapter<DeclaredOnlyEntity> = {
      findOneById: async () => null,
      findOne: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async (data) => data as DeclaredOnlyEntity,
      update: async (_id, data) => data as DeclaredOnlyEntity,
      patch: async (_id, data) => data as DeclaredOnlyEntity,
      delete: async () => {},
      restore: async () => {
        throw new Error("not exercised");
      },
      purge: async () => {},
    };
    const declaredInfrastructure: KavoInfrastructure = {
      metadataFor: () => declaredMetadata as never,
      adapterFor: () => declaredAdapter as never,
    };

    @Kavo(DeclaredOnlyEntity, { allowlists: { selectable: ["id", "title"] } })
    @Controller("declared")
    class DeclaredOnlyController {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRoot({ infrastructure: declaredInfrastructure }),
        KavoModule.forFeature([DeclaredOnlyController]),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const declaredDocument = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("t").setVersion("0").build(),
    );

    const schema = (
      declaredDocument.paths["/declared/{id}"] as Record<
        string,
        { responses?: Record<string, { content?: Record<string, { schema?: Schema & { $ref?: string } }> }> }
      >
    )?.["get"]?.responses?.["200"]?.content?.["application/json"]?.schema;

    expect(schema?.$ref).toBeUndefined();
    expect(Object.keys(schema?.properties ?? {})).toEqual(["id", "title"]);
  });

  it("adds an opted-in derived field to the synthesized item and list schemas, typed like any other field (issue #302, #373)", async () => {
    @Kavo(Todo, { allowlists: { selectable: ["id", "title", "done", "priority", "titleUpper" as never] } })
    @Controller("todos")
    class DerivedController {}
    await bootstrapDerived(DerivedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    const single = itemBody("/todos/{id}", "get", "200");
    expect(Object.keys(single?.properties ?? {})).toEqual(["id", "title", "done", "priority", "titleUpper"]);
    // Typed from its own `FieldMetadata` — `kind: "string"`, `nullable: true`
    // — exactly like any other field, unlike the untyped `computed` fragment
    // this replaced.
    expect(single?.properties?.titleUpper).toMatchObject({ type: "string" });

    const listElement = itemBody("/todos", "get", "200")?.properties?.items?.items;
    expect(Object.keys(listElement?.properties ?? {})).toContain("titleUpper");
  });

  it("omits an un-opted-in derived field, the same as any other field left off selectable (issue #373)", async () => {
    @Kavo(Todo, { allowlists: { selectable: ["id", "title"] } })
    @Controller("todos")
    class NarrowedController {}
    await bootstrapDerived(NarrowedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    expect(Object.keys(itemBody("/todos/{id}", "get", "200")?.properties ?? {})).toEqual(["id", "title"]);
  });

  it("leaves a registered item DTO's response untouched even when a derived field is opted in (issue #373)", async () => {
    class TodoItemDto {
      id = 0;
      title = "";
    }
    @Kavo(Todo, {
      dto: { item: TodoItemDto },
      allowlists: { selectable: ["id", "title", "titleUpper" as never] },
    })
    @Controller("todos")
    class DtoDerivedController {}
    await bootstrapDerived(DtoDerivedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    expect(Object.keys(itemBody("/todos/{id}", "get", "200")?.properties ?? {})).toEqual(["id", "title"]);
  });

  it("emits an optional property for an includable relation, deferring to the target's own config (issue #349)", async () => {
    @Kavo(Todo, { allowlists: { includable: ["list"] } })
    @Controller("todos")
    class IncludableController {}
    await bootstrap(IncludableController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    const single = itemBody("/todos/{id}", "get", "200");
    // Appended after the scalar columns, never reordering them.
    expect(Object.keys(single?.properties ?? {})).toEqual(["id", "title", "done", "priority", "deletedAt", "list"]);
    // Only present when `include=` asks for it, so it never joins `required`.
    expect(single?.required ?? []).not.toContain("list");
    // A to-one relation is documented as the object directly, no array wrap.
    expect(single?.properties?.list?.type).toBe("object");
    // The target's own config governs its projection (ADR-0026 decision 4)
    // — this schema does not reproduce it inline.
    expect(single?.properties?.list?.properties).toBeUndefined();
    expect(single?.properties?.list?.description).toContain("include=list");

    // The same optional property rides the list-envelope element (`<Entity>ListItem`).
    const listElement = itemBody("/todos", "get", "200")?.properties?.items?.items;
    expect(Object.keys(listElement?.properties ?? {})).toContain("list");
    expect(listElement?.required ?? []).not.toContain("list");
  });

  it("adds no relation property when nothing is includable (issue #349)", async () => {
    @Kavo(Todo, { allowlists: { selectable: ["id", "title"] } })
    @Controller("todos")
    class NoIncludeController {}
    await bootstrap(NoIncludeController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());

    // `list` is a relation on `Todo` but not on `allowlists.includable`, so
    // the synthesized schema stays exactly the scalar `selectable` set.
    expect(Object.keys(itemBody("/todos/{id}", "get", "200")?.properties ?? {})).toEqual(["id", "title"]);
  });
});

describe("@Kavo Swagger recursive includable-relation $ref composition (issue #356)", () => {
  type Schema = {
    type?: string;
    properties?: Record<string, Schema>;
    items?: Schema;
    required?: string[];
    description?: string;
    $ref?: string;
    "x-kavo-entity"?: string;
    "x-kavo-includable-ref"?: string;
  };
  type Doc = {
    paths: Record<
      string,
      Record<string, { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }>
    >;
    components?: { schemas?: Record<string, Schema> };
  };

  const stubAdapter = (): RepositoryAdapter<object> =>
    ({
      findOneById: async () => null,
      findOne: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async (data: unknown) => data,
      update: async (_id: unknown, data: unknown) => data,
      patch: async (_id: unknown, data: unknown) => data,
      delete: async () => {},
      restore: async () => {
        throw new Error("not exercised");
      },
      purge: async () => {},
    }) as unknown as RepositoryAdapter<object>;

  const buildDoc = async (infrastructure: KavoInfrastructure, controllers: unknown[]): Promise<Doc> => {
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure }), KavoModule.forFeature(controllers as never[])],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("t").setVersion("0").build(),
    ) as unknown as Doc;
  };

  const itemSchema = (doc: Doc, path: string, verb: string, status: string): Schema | undefined =>
    doc.paths[path]?.[verb]?.responses?.[status]?.content?.["application/json"]?.schema;

  /** Every `$ref` anywhere in the document points at a component that exists. */
  const collectRefs = (node: unknown, acc: string[] = []): string[] => {
    if (Array.isArray(node)) {
      for (const child of node) {
        collectRefs(child, acc);
      }
      return acc;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") {
          acc.push(value);
        } else {
          collectRefs(value, acc);
        }
      }
    }
    return acc;
  };
  const expectEveryRefResolves = (doc: Doc): void => {
    const names = Object.keys(doc.components?.schemas ?? {});
    for (const ref of collectRefs(doc)) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      expect(names).toContain(ref.slice("#/components/schemas/".length));
    }
  };

  /** Follow a `{ $ref }` (or an array's `items.$ref`) to the named component. */
  const deref = (doc: Doc, node: Schema | undefined): Schema | undefined => {
    const ref = node?.$ref ?? node?.items?.$ref;
    if (ref === undefined) {
      return undefined;
    }
    return doc.components?.schemas?.[ref.slice("#/components/schemas/".length)];
  };

  it("resolves an unbounded includable relation to a $ref to the target's <Entity>Item, recursively", async () => {
    // `Todo.list -> TodoList`, `TodoList.list -> TodoTag` — all three routed;
    // each relation defers wholly to its target (ADR-0026 decision 4) and
    // composes by shared component. Exact
    // component names are not asserted: entity `TodoList` collides with
    // `Todo`'s own `<Entity>ListItem` envelope element, so `registerKavoSchemas`
    // legitimately lands `TodoList`'s item on `TodoListItem_2` — the marker
    // resolution records whichever name it actually got.
    @Kavo(Todo, { allowlists: { includable: ["list"] } })
    @Controller("todos")
    class TodoC {}
    @Kavo(TodoList, { allowlists: { includable: ["list"] } })
    @Controller("lists")
    class ListC {}
    @Kavo(TodoTag, {})
    @Controller("tags")
    class TagC {}

    adapter = new InMemoryTodoAdapter();
    const doc = await buildDoc(fakeInfrastructure(adapter), [TodoC, ListC, TagC]);
    registerKavoSchemas(doc);

    // `TodoItem.list` -> entity TodoList's item component (has `name`, TodoList's
    // own scalar) -> its `list` -> entity TodoTag's item component.
    const todoListItem = deref(doc, doc.components?.schemas?.TodoItem?.properties?.list);
    expect(todoListItem?.["x-kavo-entity"]).toBe("TodoList");
    expect(Object.keys(todoListItem?.properties ?? {})).toContain("name");

    const todoTagItem = deref(doc, todoListItem?.properties?.list);
    expect(todoTagItem?.["x-kavo-entity"]).toBe("TodoTag");

    expectEveryRefResolves(doc);
  });

  it("degrades to a plain object when the relation target has no synthesized item component", async () => {
    // `TodoList` is not routed, so no `TodoListItem` is ever registered.
    @Kavo(Todo, { allowlists: { includable: ["list"] } })
    @Controller("todos")
    class TodoOnlyC {}

    adapter = new InMemoryTodoAdapter();
    const doc = await buildDoc(fakeInfrastructure(adapter), [TodoOnlyC]);
    registerKavoSchemas(doc);

    const list = doc.components?.schemas?.TodoItem?.properties?.list;
    expect(list?.$ref).toBeUndefined();
    expect(list?.type).toBe("object");
    expect(list?.description).toContain("not published");
    // No dangling reference anywhere.
    expectEveryRefResolves(doc);
  });

  it("leaves an includable relation a generic object when the target's metadata is unresolvable", async () => {
    class Post {}
    const postMetadata: EntityMetadata<object> = {
      entity: Post,
      name: "Post",
      idField: "id",
      fields: [
        { name: "id", kind: "number", nullable: false, generated: true },
        { name: "title", kind: "string", nullable: false, generated: false },
      ],
      relations: [
        { name: "author", target: () => class Author {}, cardinality: "one", includable: false, strategy: "auto" },
      ],
    };
    const infrastructure: KavoInfrastructure = {
      metadataFor: ((entity: unknown) => {
        if (entity === Post) {
          return postMetadata;
        }
        throw new Error("no metadata for this relation target from this root");
      }) as never,
      adapterFor: () => stubAdapter() as never,
    };

    @Controller("posts")
    class PostController {}
    const postConfig: unknown = { allowlists: { includable: ["author"] } };
    Kavo(Post, postConfig as Parameters<typeof Kavo>[1])(PostController);
    // `metadataFor` throwing for the target must not abort bootstrap.
    const doc = await buildDoc(infrastructure, [PostController]);
    registerKavoSchemas(doc);

    const author = doc.components?.schemas?.PostItem?.properties?.author;
    // No target name to reference, so no marker and no `$ref` — a generic
    // object with a prose description (ADR-0026 decision 4).
    expect(author?.$ref).toBeUndefined();
    expect(author?.["x-kavo-includable-ref"]).toBeUndefined();
    expect(author?.type).toBe("object");
    expect(author?.description).toContain("include=author");
    expectEveryRefResolves(doc);
  });

  it("produces a valid document for a relation cycle (mutual $ref)", async () => {
    class Author {}
    class Book {}
    const authorMetadata: EntityMetadata<object> = {
      entity: Author,
      name: "Author",
      idField: "id",
      fields: [
        { name: "id", kind: "number", nullable: false, generated: true },
        { name: "name", kind: "string", nullable: false, generated: false },
      ],
      relations: [{ name: "books", target: () => Book, cardinality: "many", includable: true, strategy: "auto" }],
    };
    const bookMetadata: EntityMetadata<object> = {
      entity: Book,
      name: "Book",
      idField: "id",
      fields: [
        { name: "id", kind: "number", nullable: false, generated: true },
        { name: "title", kind: "string", nullable: false, generated: false },
      ],
      relations: [{ name: "author", target: () => Author, cardinality: "one", includable: true, strategy: "auto" }],
    };
    const infrastructure: KavoInfrastructure = {
      metadataFor: ((entity: unknown) => (entity === Author ? authorMetadata : bookMetadata)) as never,
      adapterFor: () => stubAdapter() as never,
    };

    @Controller("authors")
    class AuthorC {}
    @Controller("books")
    class BookC {}
    // `Author`/`Book` have no declared fields, so the config's relation-name
    // types infer to `never`; apply the decorator as a plain cast call, the
    // same escape hatch the fallback-schema blocks above use.
    const authorConfig: unknown = { allowlists: { includable: ["books"] } };
    const bookConfig: unknown = { allowlists: { includable: ["author"] } };
    Kavo(Author, authorConfig as Parameters<typeof Kavo>[1])(AuthorC);
    Kavo(Book, bookConfig as Parameters<typeof Kavo>[1])(BookC);

    const doc = await buildDoc(infrastructure, [AuthorC, BookC]);
    registerKavoSchemas(doc);

    const schemas = doc.components?.schemas ?? {};
    expect(schemas.AuthorItem?.properties?.books).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/BookItem" },
    });
    expect(schemas.BookItem?.properties?.author).toEqual({ $ref: "#/components/schemas/AuthorItem" });
    // The component graph is cyclic — legal OpenAPI 3.x — and every ref still
    // resolves.
    expectEveryRefResolves(doc);
  });

  it("keeps a defaultInclude relation optional, still $ref'd (write responses carry no relations, ADR-0020)", async () => {
    @Kavo(Todo, {
      allowlists: { includable: ["list"] },
      relations: { edges: { list: { defaultInclude: true } } },
    })
    @Controller("todos")
    class DefaultIncludeC {}
    @Kavo(TodoList, {})
    @Controller("lists")
    class ListC {}

    adapter = new InMemoryTodoAdapter();
    const doc = await buildDoc(fakeInfrastructure(adapter), [DefaultIncludeC, ListC]);
    registerKavoSchemas(doc);

    const item = doc.components?.schemas?.TodoItem;
    expect(item?.properties?.list?.$ref).toBeDefined();
    expect(deref(doc, item?.properties?.list)?.["x-kavo-entity"]).toBe("TodoList");
    // Shared with the create/update/patch responses, which never resolve
    // `include=`, so promoting it to `required` would make those lie.
    expect(item?.required ?? []).not.toContain("list");
    expectEveryRefResolves(doc);
  });

  it("composes to the target's configured item shape when it registers a plain-class item DTO", async () => {
    // A plain-class `item` DTO is still hoisted by Kavo under the target's
    // `<Entity>Item` name (from the DTO's runtime shape), so the marker
    // resolves to it — the relation reflects whatever the target publishes,
    // not the raw column set.
    class TodoListItemDto {
      id = 0;
      name = "";
    }
    @Kavo(Todo, { allowlists: { includable: ["list"] } })
    @Controller("todos")
    class TodoC {}
    @Kavo(TodoList, { dto: { item: TodoListItemDto } })
    @Controller("lists")
    class ListC {}

    adapter = new InMemoryTodoAdapter();
    const doc = await buildDoc(fakeInfrastructure(adapter), [TodoC, ListC]);
    registerKavoSchemas(doc);

    const list = doc.components?.schemas?.TodoItem?.properties?.list;
    expect(list?.$ref).toBeDefined();
    const target = deref(doc, list);
    expect(target?.["x-kavo-entity"]).toBe("TodoList");
    // The DTO's shape, not `TodoList`'s full column set.
    expect(Object.keys(target?.properties ?? {})).toEqual(["id", "name"]);
    expectEveryRefResolves(doc);
  });

  it("leaves the marker inline (and valid) when registerKavoSchemas is not run", async () => {
    @Kavo(Todo, { allowlists: { includable: ["list"] } })
    @Controller("todos")
    class TodoC {}
    @Kavo(TodoList, {})
    @Controller("lists")
    class ListC {}

    adapter = new InMemoryTodoAdapter();
    const doc = await buildDoc(fakeInfrastructure(adapter), [TodoC, ListC]);

    const list = itemSchema(doc, "/todos/{id}", "get", "200")?.properties?.list;
    // Un-hoisted: the marker rides inline as a plain object schema plus a
    // vendor extension — still a valid schema, just not `$ref`-composed.
    expect(list?.["x-kavo-includable-ref"]).toBe("TodoList");
    expect(list?.type).toBe("object");
    expect(list?.description).toContain("include=list");
  });
});

describe("@Kavo Swagger DTO slot fallbacks", () => {
  class UpdateTodoDto {
    title = "";
    done = false;
  }

  class TodoOnlyItemDto {
    id = 0;
    title = "";
  }

  // `patch` and `list` are deliberately left unregistered. The core
  // resolver falls `patch` back to `update` and `list` back to `item`, and
  // the docs must follow the same chain the engine will actually use —
  // otherwise the published schema advertises a shape the API never emits.
  @Kavo(Todo, { dto: { update: UpdateTodoDto, item: TodoOnlyItemDto } })
  @Controller("todos")
  class FallbackController {}

  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeEach(async () => {
    await bootstrap(FallbackController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
  });

  type Schema = {
    type?: string;
    properties?: Record<string, Schema>;
    items?: Schema;
  };

  it("documents the patch body from the update DTO when no patch DTO is registered", () => {
    const schema = (
      document.paths["/todos/{id}"] as Record<
        string,
        { requestBody?: { content?: Record<string, { schema?: Schema }> } }
      >
    )?.["patch"]?.requestBody?.content?.["application/json"]?.schema;
    expect(Object.keys(schema?.properties ?? {})).toEqual(["title", "done"]);
  });

  it("documents the list envelope from the item DTO when no list DTO is registered", () => {
    const schema = (
      document.paths["/todos"] as Record<
        string,
        { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }
      >
    )?.["get"]?.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(Object.keys(schema?.properties?.items?.items?.properties ?? {})).toEqual(["id", "title"]);
  });
});

describe("@Kavo Swagger schema hints (enum, oneOf)", () => {
  class VariantA {
    id = 0;
    a = "";
  }
  class VariantB {
    id = 0;
    b = 0;
  }

  class CreateHintedDto {
    title = "";
    size = enumProp(["small", "medium", "large"], { example: "medium" });
  }
  class HintedItemDto {
    id = 0;
    size = enumProp(["small", "medium", "large"]);
    children = oneOfArray<VariantA | VariantB>([VariantA, VariantB]);
  }

  @Kavo(Todo, { dto: { create: CreateHintedDto, item: HintedItemDto } })
  @Controller("todos")
  class HintedController {}

  type HintSchema = {
    type?: string;
    properties?: Record<string, HintSchema>;
    items?: HintSchema;
    enum?: readonly (string | number)[];
    example?: string | number;
    oneOf?: readonly HintSchema[];
    title?: string;
    "x-kavo-entity"?: string;
  };

  let document: ReturnType<typeof SwaggerModule.createDocument>;
  beforeEach(async () => {
    await bootstrap(HintedController);
    document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build());
  });

  const bodySchema = (): HintSchema | undefined =>
    (document.paths["/todos"] as { post?: { requestBody?: { content?: Record<string, { schema?: HintSchema }> } } })
      ?.post?.requestBody?.content?.["application/json"]?.schema;

  const itemSchema = (): HintSchema | undefined =>
    (
      document.paths["/todos/{id}"] as Record<
        string,
        { responses?: Record<string, { content?: Record<string, { schema?: HintSchema }> }> }
      >
    )?.get?.responses?.["200"]?.content?.["application/json"]?.schema;

  it("documents an enum field with its allowed values", () => {
    expect(bodySchema()?.properties?.size).toEqual({
      type: "string",
      enum: ["small", "medium", "large"],
      example: "medium",
    });
  });

  it("documents an enum field without an example when none is given", () => {
    expect(itemSchema()?.properties?.size).toEqual({ type: "string", enum: ["small", "medium", "large"] });
  });

  it("documents a oneOf array field with per-variant schemas", () => {
    const children = itemSchema()?.properties?.children;
    expect(children?.type).toBe("array");
    expect(children?.items?.oneOf).toEqual([
      {
        title: "VariantA",
        type: "object",
        properties: { id: { type: "integer" }, a: { type: "string" } },
        "x-kavo-entity": "Todo",
      },
      {
        title: "VariantB",
        type: "object",
        properties: { id: { type: "integer" }, b: { type: "integer" } },
        "x-kavo-entity": "Todo",
      },
    ]);
  });
});

describe("@Kavo Swagger named component schemas (issue #310)", () => {
  class CreateTodoDto {
    title = "";
    priority = 0;
    done = false;
  }
  class TodoItemDto {
    id = 0;
    title = "";
    done = false;
  }
  class TodoListDto {
    id = 0;
    title = "";
  }

  @Kavo(Todo, { dto: { create: CreateTodoDto, item: TodoItemDto, list: TodoListDto } })
  @Controller("todos")
  class NamedSchemaController {}

  type Schema = {
    $ref?: string;
    type?: string;
    title?: string;
    required?: string[];
    additionalProperties?: boolean;
    description?: string;
    allOf?: Schema[];
    properties?: Record<string, Schema>;
    items?: Schema;
    "x-kavo-entity"?: string;
    "x-kavo-error"?: boolean;
    "x-kavo-operation-scoped"?: boolean;
  };
  type Doc = {
    components?: { schemas?: Record<string, Schema> };
    paths: Record<
      string,
      Record<
        string,
        {
          requestBody?: { content?: Record<string, { schema?: Schema }> };
          responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
        }
      >
    >;
  };

  let document: Doc;
  const schemas = (): Record<string, Schema> => document.components?.schemas ?? {};
  const reqSchema = (path: string, verb: string): Schema | undefined =>
    document.paths[path]?.[verb]?.requestBody?.content?.["application/json"]?.schema;
  const resSchema = (path: string, verb: string, status: string): Schema | undefined =>
    document.paths[path]?.[verb]?.responses?.[status]?.content?.["application/json"]?.schema;

  beforeEach(async () => {
    await bootstrap(NamedSchemaController);
    document = registerKavoSchemas(
      SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build()) as unknown as Doc,
    );
  });

  it("hoists request bodies to <Entity>Create/Update/Patch and $refs them", () => {
    expect(reqSchema("/todos", "post")).toEqual({ $ref: "#/components/schemas/TodoCreate" });
    expect(reqSchema("/todos/{id}", "put")).toEqual({ $ref: "#/components/schemas/TodoUpdate" });
    expect(reqSchema("/todos/{id}", "patch")).toEqual({ $ref: "#/components/schemas/TodoPatch" });
    expect(Object.keys(schemas().TodoCreate?.properties ?? {})).toEqual(["title", "priority", "done"]);
    // The update/patch bodies come from the #264 bind-time fallback (no
    // `dto.update` configured) and still get a stable name.
    expect(Object.keys(schemas().TodoUpdate?.properties ?? {})).toContain("title");
  });

  it("hoists the single-row response to <Entity>Item, keeping x-kavo-entity and dropping title", () => {
    expect(resSchema("/todos/{id}", "get", "200")).toEqual({ $ref: "#/components/schemas/TodoItem" });
    expect(Object.keys(schemas().TodoItem?.properties ?? {})).toEqual(["id", "title", "done"]);
    expect(schemas().TodoItem?.["x-kavo-entity"]).toBe("Todo");
    expect(schemas().TodoItem?.title).toBeUndefined();
  });

  it("hoists the list envelope, its element and its meta bag to distinct components", () => {
    expect(resSchema("/todos", "get", "200")).toEqual({ $ref: "#/components/schemas/TodoList" });
    const list = schemas().TodoList;
    expect(list?.properties?.items?.items).toEqual({ $ref: "#/components/schemas/TodoListItem" });
    expect(list?.properties?.meta).toEqual({ $ref: "#/components/schemas/TodoListMeta" });
    expect(list?.required).toEqual(["items", "limit", "offset", "total"]);
    expect(Object.keys(schemas().TodoListItem?.properties ?? {})).toEqual(["id", "title"]);
    expect(schemas().TodoListMeta).toMatchObject({ type: "object", additionalProperties: true });
    expect(schemas().TodoListMeta?.description).toContain("findMany");
    expect(schemas().TodoListMeta?.["x-kavo-entity"]).toBe("Todo");
  });

  it("points every non-400 error response at the shared KavoProblemDetails, and every 400 at TodoValidationError", () => {
    for (const [path, verb, status, name] of [
      ["/todos", "post", "400", "TodoValidationError"],
      ["/todos/{id}", "put", "400", "TodoValidationError"],
      ["/todos/{id}", "patch", "400", "TodoValidationError"],
      ["/todos", "get", "400", "TodoValidationError"],
      ["/todos/{id}", "get", "404", "KavoProblemDetails"],
      ["/todos/{id}", "put", "412", "KavoProblemDetails"],
      ["/todos/{id}", "patch", "412", "KavoProblemDetails"],
    ] as const) {
      expect(resSchema(path, verb, status)).toEqual({ $ref: `#/components/schemas/${name}` });
    }
    expect(schemas().KavoProblemDetails?.["x-kavo-error"]).toBe(true);
    expect(schemas().KavoProblemDetails?.properties?.errors?.items).toEqual({
      $ref: "#/components/schemas/KavoProblemDetailError",
    });
    expect(schemas().KavoProblemDetailError?.["x-kavo-error"]).toBe(true);
  });

  it("retags the 400 as <Entity>ValidationError — an allOf over KavoProblemDetails, no field enumeration", () => {
    const validation = schemas().TodoValidationError;
    expect(validation?.["x-kavo-entity"]).toBe("Todo");
    expect(validation?.allOf).toEqual([{ $ref: "#/components/schemas/KavoProblemDetails" }]);
    // Deliberately generic: enumerating the resolved write/query allowlist
    // here would disagree with the request-body schema on the same route
    // (an explicit DTO replaces the allowlist) and leak column names.
    expect(validation?.description).toContain("Todo");
    expect(validation?.description).not.toContain("title");
  });

  it("names a per-operation output DTO for its operation, not the shared TodoItem", async () => {
    class SpotlightDto {
      id = 0;
      headline = "";
    }
    @Kavo(Todo, {
      dto: { item: TodoItemDto },
      operations: { findOne: true, createOne: { dto: { output: SpotlightDto } } },
    })
    @Controller("todos")
    class PerOpController {}
    await app.close();
    await bootstrap(PerOpController);
    const doc = registerKavoSchemas(
      SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build()) as unknown as Doc,
    );
    const s = doc.components?.schemas ?? {};
    // createOne serves its own output shape → its own component.
    expect(doc.paths["/todos"]?.["post"]?.responses?.["201"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/TodoCreateOne",
    });
    expect(Object.keys(s.TodoCreateOne?.properties ?? {})).toEqual(["id", "headline"]);
    // findOne still serves the root item slot → the shared name, undisturbed.
    expect(doc.paths["/todos/{id}"]?.["get"]?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/TodoItem",
    });
    expect(s.TodoItem_2).toBeUndefined();
    expect(s.TodoCreateOne?.["x-kavo-operation-scoped"]).toBeUndefined();
  });

  it("leaves a declarative DTO on Swagger's own $ref — no empty named component", async () => {
    class DeclaredOnlyDto {
      title!: string;
    }
    @Kavo(Todo, { dto: { create: DeclaredOnlyDto } })
    @Controller("todos")
    class DeclarativeController {}
    await app.close();
    await bootstrap(DeclarativeController);
    const doc = registerKavoSchemas(
      SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build()) as unknown as Doc,
    );
    const body = doc.paths["/todos"]?.["post"]?.requestBody?.content?.["application/json"]?.schema;
    expect(body?.$ref).toContain("DeclaredOnlyDto");
    expect(doc.components?.schemas?.TodoCreate).toBeUndefined();
  });

  it("keeps a second document built from the same app self-contained", () => {
    // `applySwaggerMetadata` shares one `PROBLEM_DETAILS_SCHEMA` reference
    // across every error response; a hoist that mutated it in place would
    // leave the next document $ref-ing a component only the first one added.
    registerKavoSchemas(
      SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build()) as unknown as Doc,
    );
    const second = registerKavoSchemas(
      SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build()) as unknown as Doc,
    );
    expect(second.components?.schemas?.KavoProblemDetailError).toBeDefined();
    expect(second.components?.schemas?.KavoProblemDetails?.properties?.errors?.items).toEqual({
      $ref: "#/components/schemas/KavoProblemDetailError",
    });
  });

  it("does not touch the un-processed document — createDocument alone still emits inline schemas", async () => {
    // Parity guard: `registerKavoSchemas` is opt-in. The raw document keeps
    // the inline shape every existing consumer relies on.
    const raw = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("t").setVersion("0").build(),
    ) as unknown as Doc;
    expect(
      raw.paths["/todos/{id}"]?.["get"]?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    ).toBeUndefined();
    expect(
      raw.paths["/todos/{id}"]?.["get"]?.responses?.["200"]?.content?.["application/json"]?.schema?.properties,
    ).toBeDefined();
  });
});

describe("@Kavo Swagger query-shape component schemas (issue #313)", () => {
  type Schema = {
    type?: string;
    description?: string;
    properties?: Record<string, Schema>;
    items?: Schema;
    enum?: string[];
    "x-kavo-entity"?: string;
  };
  type Doc = {
    components?: { schemas?: Record<string, Schema> };
    paths: Record<string, Record<string, { "x-kavo-query-schemas"?: unknown }>>;
  };

  const build = (): Doc =>
    registerKavoSchemas(
      SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build()) as unknown as Doc,
    );
  const schemas = (doc: Doc): Record<string, Schema> => doc.components?.schemas ?? {};

  it("produces <Entity>Pagination/Include/Sort from the resolved config at bind time", async () => {
    @Kavo(Todo, { allowlists: { includable: ["list"], sortable: ["title", "priority"] } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    expect(schemas(doc).TodoPagination).toEqual({
      type: "object",
      properties: {
        limit: { type: "integer", description: "Page size, clamped to the configured maximum." },
        offset: { type: "integer", description: "Zero-based index of the first returned row." },
      },
      "x-kavo-entity": "Todo",
    });
    expect(schemas(doc).TodoInclude?.items?.enum).toEqual(["list"]);
    expect(schemas(doc).TodoInclude?.["x-kavo-entity"]).toBe("Todo");
    expect(schemas(doc).TodoSort?.items?.enum).toEqual(["title", "priority", "-title", "-priority"]);
    expect(schemas(doc).TodoSort?.["x-kavo-entity"]).toBe("Todo");
    // The plumbing extension is gone from every route once hoisted.
    for (const pathItem of Object.values(doc.paths)) {
      for (const op of Object.values(pathItem)) {
        expect(op["x-kavo-query-schemas"]).toBeUndefined();
      }
    }
  });

  it("omits <Entity>Include when nothing is includable, still emits Pagination and Sort", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    expect(schemas(doc).TodoInclude).toBeUndefined();
    expect(schemas(doc).TodoPagination).toBeDefined();
    // Unconfigured `sortable` resolves to every own column — the same
    // fully-resolved allowlist `applySearchQueryDocs` publishes for
    // `searchable`, and the same set the fallback `item`/`list` response
    // schema documents ("documents every own column when selectable is left
    // unconfigured" elsewhere in this file). `<Entity>Sort` mirrors it
    // verbatim (soft-delete column included) with the `-` descending forms
    // appended — pinned exactly so a change to that default set is a visible
    // diff, never a silent one.
    expect(schemas(doc).TodoSort?.items?.enum).toEqual([
      "id",
      "title",
      "done",
      "priority",
      "deletedAt",
      "-id",
      "-title",
      "-done",
      "-priority",
      "-deletedAt",
    ]);
  });

  it("emits no Pagination/Sort when the entity has no list route, but still Include on the single-row read", async () => {
    // `operations` is an explicit whitelist once declared — naming everything
    // except `findMany` keeps `findOne` (a single-row read) with no list
    // route. `pagination`/`sort` are list-only, so only `<Entity>Include`
    // survives.
    @Kavo(Todo, {
      operations: { createOne: true, findOne: true, updateOne: true, patchOne: true, deleteOne: true },
      allowlists: { includable: ["list"] },
    })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    expect(schemas(doc).TodoInclude?.items?.enum).toEqual(["list"]);
    expect(schemas(doc).TodoPagination).toBeUndefined();
    expect(schemas(doc).TodoSort).toBeUndefined();
  });

  it("stamps no extension at all when a non-list read has nothing includable", async () => {
    // Same no-list-route shape, but `includable` unconfigured — every slot
    // is empty, so `applyQuerySchemaDocs` hits its empty-slots early return.
    @Kavo(Todo, {
      operations: { createOne: true, findOne: true, updateOne: true, patchOne: true, deleteOne: true },
    })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const raw = SwaggerModule.createDocument(app, new DocumentBuilder().build()) as unknown as Doc;
    const itemBlob = raw.paths["/todos/{id}"]?.["get"]?.["x-kavo-query-schemas"];
    expect(itemBlob).toBeUndefined();
    const doc = build();
    expect(schemas(doc).TodoInclude).toBeUndefined();
    expect(schemas(doc).TodoPagination).toBeUndefined();
    expect(schemas(doc).TodoSort).toBeUndefined();
  });

  it("annotates <Entity>Pagination as unsupported under pagination.strategy: 'none'", async () => {
    @Kavo(Todo, { pagination: { strategy: "none" } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    expect(schemas(doc).TodoPagination?.description).toBe(
      "Not supported: this entity does not paginate ('pagination.strategy' is 'none') — every request serves the whole match set.",
    );
    // Still carries the shape and the entity marker.
    expect(Object.keys(schemas(doc).TodoPagination?.properties ?? {})).toEqual(["limit", "offset"]);
  });

  it("reads a global-default pagination.strategy through the precedence chain", async () => {
    @Kavo(Todo)
    @Controller("todos")
    class C {}

    await bootstrap(C, { defaults: { pagination: { strategy: "none" } } });
    const doc = build();

    expect(schemas(doc).TodoPagination?.description).toContain("does not paginate");
  });

  it("shapes <Entity>Pagination to the page strategy's wire keys", async () => {
    @Kavo(Todo, { pagination: { strategy: "page" } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    expect(schemas(doc).TodoPagination).toEqual({
      type: "object",
      properties: {
        "page[number]": { type: "integer", description: "1-based page number." },
        "page[size]": { type: "integer", description: "Page size, clamped to the configured maximum." },
      },
      "x-kavo-entity": "Todo",
    });
  });

  it("shapes <Entity>Pagination to the cursor strategy's wire keys, cursor as an opaque string", async () => {
    @Kavo(Todo, { pagination: { strategy: "cursor" } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    expect(schemas(doc).TodoPagination).toEqual({
      type: "object",
      properties: {
        limit: { type: "integer", description: "Page size, clamped to the configured maximum." },
        cursor: {
          type: "string",
          description: "Opaque page token — pass back `meta.nextCursor` from the previous page verbatim.",
        },
      },
      "x-kavo-entity": "Todo",
    });
  });

  it("shapes <Entity>Pagination to the since strategy's wire keys, since as a plain string", async () => {
    @Kavo(Todo, { pagination: { strategy: "since", since: { field: "title" } } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    expect(schemas(doc).TodoPagination).toEqual({
      type: "object",
      properties: {
        limit: { type: "integer", description: "Page size, clamped to the configured maximum." },
        since: {
          type: "string",
          description: "Seek boundary — pass back `meta.nextSince` from the previous poll verbatim.",
        },
      },
      "x-kavo-entity": "Todo",
    });
  });

  it("documents an explicit empty sortable allowlist as a closed door", async () => {
    @Kavo(Todo, { allowlists: { sortable: [] } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    expect(schemas(doc).TodoSort?.items?.enum).toEqual([]);
    expect(schemas(doc).TodoSort?.description).toBe("No field is sortable.");
  });

  it("namespaces the three components per entity across a multi-entity document", async () => {
    @Kavo(Todo, { allowlists: { includable: ["list"], sortable: ["title"] } })
    @Controller("todos")
    class TodoC {}
    @Kavo(TodoList, { allowlists: { sortable: ["name"] } })
    @Controller("lists")
    class ListC {}

    adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter) }),
        KavoModule.forFeature([TodoC as never, ListC as never]),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const doc = build();

    expect(schemas(doc).TodoSort?.items?.enum).toEqual(["title", "-title"]);
    expect(schemas(doc).TodoListSort?.items?.enum).toEqual(["name", "-name"]);
    expect(schemas(doc).TodoInclude?.items?.enum).toEqual(["list"]);
    expect(schemas(doc).TodoListInclude).toBeUndefined();
  });

  it("leaves the raw blob on the route when registerKavoSchemas is not run, split by route cardinality", async () => {
    @Kavo(Todo, { allowlists: { sortable: ["title"], includable: ["list"] } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const raw = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("t").setVersion("0").build(),
    ) as unknown as Doc;

    // The list route carries all five slots.
    const listBlob = raw.paths["/todos"]?.["get"]?.["x-kavo-query-schemas"] as Record<string, Schema> | undefined;
    expect(Object.keys(listBlob ?? {}).sort()).toEqual(["filter", "include", "pagination", "query", "sort"]);
    expect(listBlob?.sort?.items?.enum).toEqual(["title", "-title"]);

    // A single-row read carries `include` only — `pagination`/`sort` are
    // list-only (`descriptor.cardinality === "many"`).
    const itemBlob = raw.paths["/todos/{id}"]?.["get"]?.["x-kavo-query-schemas"] as Record<string, Schema> | undefined;
    expect(Object.keys(itemBlob ?? {})).toEqual(["include"]);
    expect(itemBlob?.include?.items?.enum).toEqual(["list"]);
  });
});

describe("@Kavo Swagger <Entity>Filter/<Entity>Query component schemas (issue #314, ADR-0042)", () => {
  type OperatorMap = {
    type?: string;
    properties?: Record<string, { type?: string; format?: string }>;
  };
  type Schema = {
    type?: string;
    description?: string;
    properties?: Record<string, unknown>;
    items?: { $ref?: string; type?: string; enum?: string[] };
    "x-kavo-entity"?: string;
    $ref?: string;
  };
  type Doc = {
    components?: { schemas?: Record<string, Schema> };
    paths: Record<string, Record<string, { "x-kavo-query-schemas"?: unknown }>>;
  };

  const build = (): Doc =>
    registerKavoSchemas(
      SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build()) as unknown as Doc,
    );
  const schemas = (doc: Doc): Record<string, Schema> => doc.components?.schemas ?? {};

  it("produces <Entity>Filter with one operator map per filterable own column, and <Entity>Query referencing its siblings", async () => {
    @Kavo(Todo, { allowlists: { includable: ["list"], sortable: ["title"] } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    const filter = schemas(doc).TodoFilter;
    expect(filter?.["x-kavo-entity"]).toBe("Todo");
    // Unconfigured `filterable` resolves to every own column, mirroring
    // `sortable`'s own default (soft-delete marker included).
    expect(Object.keys(filter?.properties ?? {}).sort()).toEqual([
      "and",
      "deletedAt",
      "done",
      "id",
      "not",
      "or",
      "priority",
      "title",
    ]);

    const idOps = filter?.properties?.id as OperatorMap;
    expect(idOps.properties?.eq).toEqual({ type: "number" });
    expect(idOps.properties?.between).toBeDefined();
    // like/ilike are string-kind only (doc 05 §1's one kind-specific rule).
    expect(idOps.properties?.like).toBeUndefined();

    const titleOps = filter?.properties?.title as OperatorMap;
    expect(titleOps.properties?.like).toEqual({ type: "string" });
    expect(titleOps.properties?.ilike).toEqual({ type: "string" });

    const doneOps = filter?.properties?.done as OperatorMap;
    expect(doneOps.properties?.eq).toEqual({ type: "boolean" });
    expect(doneOps.properties?.like).toBeUndefined();

    // and/or/not self-reference the entity's own expected Filter name.
    const filterRef = { $ref: "#/components/schemas/TodoFilter" };
    expect((filter?.properties?.and as { items?: unknown })?.items).toEqual(filterRef);
    expect((filter?.properties?.or as { items?: unknown })?.items).toEqual(filterRef);
    expect(filter?.properties?.not).toEqual(filterRef);

    const query = schemas(doc).TodoQuery;
    expect(query?.["x-kavo-entity"]).toBe("Todo");
    expect(query?.properties?.filter).toEqual(filterRef);
    expect(query?.properties?.sort).toEqual({ $ref: "#/components/schemas/TodoSort" });
    expect(query?.properties?.pagination).toEqual({ $ref: "#/components/schemas/TodoPagination" });
    expect(query?.properties?.include).toEqual({ $ref: "#/components/schemas/TodoInclude" });
    // `search` isn't a component of its own — inlined only.
    const select = query?.properties?.select as { items?: { enum?: string[] } };
    expect(select.items?.enum).toEqual(["id", "title", "done", "priority", "deletedAt"]);
    // `query.search` resolves `false` by default — no `search` property.
    expect(query?.properties?.search).toBeUndefined();
  });

  it("documents an explicit empty filterable allowlist as a closed door", async () => {
    @Kavo(Todo, { allowlists: { filterable: [] } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    expect(schemas(doc).TodoFilter?.properties).toEqual({
      and: { type: "array", items: { $ref: "#/components/schemas/TodoFilter" } },
      or: { type: "array", items: { $ref: "#/components/schemas/TodoFilter" } },
      not: { $ref: "#/components/schemas/TodoFilter" },
    });
    expect(schemas(doc).TodoFilter?.description).toBe("No field is filterable.");
  });

  it("inlines a search property on <Entity>Query only when query.search resolves to an object", async () => {
    @Kavo(Todo, { query: { search: { mode: "words" } }, allowlists: { searchable: ["title"] } })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const doc = build();

    const search = schemas(doc).TodoQuery?.properties?.search as {
      type?: string;
      properties?: Record<string, { type?: string; enum?: string[] }>;
    };
    expect(search.type).toBe("object");
    expect(search.properties?.query).toEqual({ type: "string" });
    expect(search.properties?.mode).toEqual({ type: "string", enum: ["substring", "words"] });
    expect(search.properties?.fields).toEqual({ type: "array", items: { type: "string", enum: ["title"] } });
  });

  it("omits <Entity>Filter/<Entity>Query from a single-row read — both are list-only", async () => {
    @Kavo(Todo, {
      operations: { createOne: true, findOne: true, updateOne: true, patchOne: true, deleteOne: true },
    })
    @Controller("todos")
    class C {}

    await bootstrap(C);
    const raw = SwaggerModule.createDocument(app, new DocumentBuilder().build()) as unknown as Doc;
    const itemBlob = raw.paths["/todos/{id}"]?.["get"]?.["x-kavo-query-schemas"] as Record<string, unknown> | undefined;
    expect(itemBlob).toBeUndefined();
  });
});
