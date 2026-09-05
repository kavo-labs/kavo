import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Controller, UseGuards, type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { KavoAppContext, KavoContext, OperationHandler, WireQuery } from "@kavo/core";
import { ConfigurationException } from "@kavo/core";
import type { KavoAppContextExtractor, KavoAppContextRequest } from "@kavo/nest";
import { Kavo, KavoModule, Override, boundKavoAppContext, boundKavoService } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * `KavoContext.app` over **real HTTP**, which is the whole point of this
 * file: every other test of the app context drives the programmatic surface
 * (`crud.findOne(id, query, { app })`), and that path always worked — the
 * generated routes were the ones sending `options: null`, so a computed
 * field or a handler reading `context.app` got `{}` from every caller,
 * silently (issue #142).
 *
 * Authentication is deliberately a guard here rather than anything Kavo
 * owns: the `app` extractor only moves a context someone else established
 * from the request onto `KavoContext.app`.
 */

let app: INestApplication;
let adapter: InMemoryTodoAdapter;
let httpServer: SupertestTarget | undefined;

/** Reads `request.user` — the conventional place a guard leaves the caller. */
const fromRequestUser: KavoAppContextExtractor = (request) => (request.user as KavoAppContext | undefined) ?? {};

/** Stands in for whatever an app's real auth guard does. */
class HeaderUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const incoming = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
      session?: unknown;
    }>();
    const id = incoming.headers["x-user"];
    if (id === undefined) {
      return true;
    }
    incoming.user = { id };
    incoming.session = { account: `session-${id}` };
    return true;
  }
}

async function bootstrap(controller: unknown, appExtractor?: KavoAppContextExtractor): Promise<void> {
  adapter = new InMemoryTodoAdapter();
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), app: appExtractor }),
      KavoModule.forFeature([controller as never]),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  httpServer = await listen(app);
}

afterEach(async () => {
  httpServer = undefined;
  await app.close();
});

function server(): SupertestTarget {
  return boundServer(httpServer);
}

/** `context.app`'s id, or the marker for "nobody is signed in". */
const viewerOf = (context: KavoContext<Todo>): string => (context.app as { id?: string }).id ?? "anonymous";

// `KavoContext.app` over HTTP for a per-caller-varying **computed** field
// (issue #142) was covered here until issue #373 removed `computed`
// entirely: a derived field is now an ORM expression, evaluated by the
// database, so nothing about it can vary by caller the way a
// `resolve(entity, context)` function could. That capability has no
// replacement (issue #373's documented regression) — `context.app` is still
// available to custom operation handlers and policies, covered below.

describe("KavoContext.app over HTTP — operation handlers (issue #142)", () => {
  /**
   * A hand-written handler on an operation given its own route shape —
   * `EntityConfig` registers no new operation ids, so this is the
   * custom-operation surface Kavo actually has, and it exercises the
   * generator's non-standard-route branch as well as the handler's context.
   */
  const claimHandler: OperationHandler<Todo> = {
    async execute(_input, context) {
      return {
        id: 1,
        title: viewerOf(context as KavoContext<Todo>),
        done: true,
        priority: 0,
        deletedAt: null,
        list: null,
      };
    },
  };

  @Kavo(Todo, {
    operations: {
      updateOne: { handler: claimHandler, meta: { routes: { method: "POST", path: ":id/claim" } } },
    },
  })
  @Controller("todos")
  @UseGuards(new HeaderUserGuard())
  class ClaimController {}

  it("hands a custom handler on a custom route the caller's app context", async () => {
    await bootstrap(ClaimController, fromRequestUser);
    const claimed = await request(server()).post("/todos/1/claim").send({}).set("x-user", "u-7").expect(200);
    expect(claimed.body).toMatchObject({ id: 1, title: "u-7" });
  });

  it("hands the same handler an empty app context when nobody is signed in", async () => {
    await bootstrap(ClaimController, fromRequestUser);
    const claimed = await request(server()).post("/todos/1/claim").send({}).expect(200);
    expect(claimed.body).toMatchObject({ title: "anonymous" });
  });

  it("reaches a standard write handler too, not only reads", async () => {
    const seen: unknown[] = [];
    const createHandler: OperationHandler<Todo> = {
      async execute(_input, context) {
        seen.push(context.app);
        return { id: 1, title: "x", done: false, priority: 0, deletedAt: null, list: null };
      },
    };

    @Kavo(Todo, { operations: { createOne: { handler: createHandler } } })
    @Controller("todos")
    @UseGuards(new HeaderUserGuard())
    class CreatingController {}

    await bootstrap(CreatingController, fromRequestUser);
    await request(server()).post("/todos").send({ title: "x" }).set("x-user", "u-7").expect(201);
    expect(seen).toEqual([{ id: "u-7" }]);
  });

  it("hands the handler an empty object — not null/undefined — when the module configures no extractor", async () => {
    const seen: unknown[] = [];
    const createHandler: OperationHandler<Todo> = {
      async execute(_input, context) {
        seen.push(context.app);
        return { id: 1, title: "x", done: false, priority: 0, deletedAt: null, list: null };
      },
    };

    @Kavo(Todo, { operations: { createOne: { handler: createHandler } } })
    @Controller("todos")
    @UseGuards(new HeaderUserGuard())
    class UnconfiguredController {}

    await bootstrap(UnconfiguredController); // no `app` extractor
    await request(server()).post("/todos").send({ title: "x" }).set("x-user", "u-7").expect(201);
    expect(seen).toEqual([{}]);
  });
});

describe("boundKavoAppContext — the methods Kavo does not generate", () => {
  @Kavo(Todo)
  @Controller("todos")
  @UseGuards(new HeaderUserGuard())
  class OverridingController {
    // The generated layout's trailing parameter, which is exactly why the
    // request is in it: an override reaches the engine itself, so it passes
    // the app context itself — through the app's configured extractor rather
    // than by re-deciding where the caller lives.
    @Override()
    async findOne(id: string, query: WireQuery, _preconditions: unknown, incoming: KavoAppContextRequest) {
      const appContext = boundKavoAppContext(this, incoming);
      const item = await boundKavoService<Todo>(this).findOne(id as never, query as never, { app: appContext });
      return { ...item, viewer: (appContext as { id?: string }).id ?? "anonymous" };
    }
  }

  it("runs the configured extractor for an @Override'd method", async () => {
    await bootstrap(OverridingController, fromRequestUser);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    const item = await request(server()).get("/todos/1").set("x-user", "u-7").expect(200);
    expect(item.body).toMatchObject({ id: 1, viewer: "u-7" });
  });

  it("answers an empty app context for the same method when no extractor is configured", async () => {
    await bootstrap(OverridingController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    const item = await request(server()).get("/todos/1").set("x-user", "u-7").expect(200);
    expect(item.body.viewer).toBe("anonymous");
  });

  it("throws on an object the binder never visited, rather than answering an empty context", () => {
    // "no extractor configured" and "this isn't a @Kavo controller" would
    // otherwise be the same silent `{}` — the failure mode issue #142 is
    // about, reintroduced one layer up.
    class PlainService {}
    let error: unknown;
    try {
      boundKavoAppContext(new PlainService(), {});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error).toMatchObject({
      code: "KAVO_CONFIG_INVALID",
      messageParams: { entity: "PlainService", path: "app" },
    });
  });
});
