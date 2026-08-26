import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Controller, UseGuards, type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { KavoContext, OperationHandler, WireQuery } from "@kavo/core";
import { ConfigurationException } from "@kavo/core";
import type { KavoPrincipalOption, KavoPrincipalRequest } from "@kavo/nest";
import { Kavo, KavoModule, Override, boundKavoPrincipal, boundKavoService } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * The principal over **real HTTP**, which is the whole point of this file:
 * every existing test of `KavoContext.principal` drives the programmatic
 * surface (`crud.findOne(id, query, { principal })`), and that path always
 * worked — the generated routes were the ones sending `options: null`, so
 * a computed field or a handler reading `context.principal` got `null` from
 * every caller, silently (issue #142).
 *
 * Authentication is deliberately a guard here rather than anything Kavo
 * owns: `principal` only moves an identity someone else established from
 * the request onto the context.
 */

let app: INestApplication;
let adapter: InMemoryTodoAdapter;
let httpServer: SupertestTarget | undefined;

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

async function bootstrap(controller: unknown, principal?: KavoPrincipalOption): Promise<void> {
  adapter = new InMemoryTodoAdapter();
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), principal }),
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

/** `context.principal`'s id, or the marker for "nobody is signed in". */
const viewerOf = (context: KavoContext<Todo>): string =>
  (context.principal as { id: string } | null)?.id ?? "anonymous";

describe("KavoContext.principal over HTTP — computed fields (issue #142)", () => {
  // The exact shape docs/features/computed-fields.md documents: a
  // computed field whose value varies by caller.
  @Kavo(Todo, { computed: { viewer: { resolve: (_todo: Todo, context) => viewerOf(context) } } })
  @Controller("todos")
  @UseGuards(new HeaderUserGuard())
  class ViewerController {}

  it("resolves a computed field from the caller the guard authenticated", async () => {
    await bootstrap(ViewerController, true);
    await request(server()).post("/todos").send({ title: "x" }).set("x-user", "u-7").expect(201);

    const item = await request(server()).get("/todos/1").set("x-user", "u-7").expect(200);
    expect(item.body).toMatchObject({ id: 1, title: "x", viewer: "u-7" });
  });

  it("gives every caller their own value and none of them the last one's", async () => {
    // The regression this file exists for is silent, so "per request, never
    // cached" has to be asserted rather than assumed: three requests, three
    // answers, one of them anonymous, all against one bound controller.
    await bootstrap(ViewerController, true);
    await request(server()).post("/todos").send({ title: "x" }).set("x-user", "u-7").expect(201);

    const first = await request(server()).get("/todos/1").set("x-user", "u-7").expect(200);
    const second = await request(server()).get("/todos/1").set("x-user", "u-9").expect(200);
    const anonymous = await request(server()).get("/todos/1").expect(200);

    expect([first.body.viewer, second.body.viewer, anonymous.body.viewer]).toEqual(["u-7", "u-9", "anonymous"]);
  });

  it("carries the principal into a list response too, per served row", async () => {
    await bootstrap(ViewerController, true);
    await request(server()).post("/todos").send({ title: "a" }).set("x-user", "u-7").expect(201);
    await request(server()).post("/todos").send({ title: "b" }).set("x-user", "u-7").expect(201);

    const list = await request(server()).get("/todos").set("x-user", "u-9").expect(200);
    expect(list.body.items.map((item: { viewer: string }) => item.viewer)).toEqual(["u-9", "u-9"]);
  });

  it("leaves the principal null when the module configures no extractor", async () => {
    // The upgrade path: an app that never sets the option keeps exactly the
    // behavior it had, rather than starting to see `request.user` or a throw.
    await bootstrap(ViewerController);
    await request(server()).post("/todos").send({ title: "x" }).set("x-user", "u-7").expect(201);

    const item = await request(server()).get("/todos/1").set("x-user", "u-7").expect(200);
    expect(item.body.viewer).toBe("anonymous");
  });

  it("reads a custom property when the extractor names one", async () => {
    // `request.user` is a convention, not a rule — an app whose guard leaves
    // the caller elsewhere configures the lookup instead of renaming it.
    await bootstrap(ViewerController, (incoming: KavoPrincipalRequest) => {
      const session = incoming["session"] as { account: string } | undefined;
      return session === undefined ? null : { id: session.account };
    });
    await request(server()).post("/todos").send({ title: "x" }).set("x-user", "u-7").expect(201);

    const item = await request(server()).get("/todos/1").set("x-user", "u-7").expect(200);
    expect(item.body.viewer).toBe("session-u-7");
  });

  it("leaves the principal null when the extractor is switched off explicitly", async () => {
    await bootstrap(ViewerController, false);
    await request(server()).post("/todos").send({ title: "x" }).set("x-user", "u-7").expect(201);

    const item = await request(server()).get("/todos/1").set("x-user", "u-7").expect(200);
    expect(item.body.viewer).toBe("anonymous");
  });
});

describe("KavoContext.principal over HTTP — operation handlers (issue #142)", () => {
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

  it("hands a custom handler on a custom route the caller's principal", async () => {
    await bootstrap(ClaimController, true);
    const claimed = await request(server()).post("/todos/1/claim").send({}).set("x-user", "u-7").expect(200);
    expect(claimed.body).toMatchObject({ id: 1, title: "u-7" });
  });

  it("hands the same handler a null principal when nobody is signed in", async () => {
    await bootstrap(ClaimController, true);
    const claimed = await request(server()).post("/todos/1/claim").send({}).expect(200);
    expect(claimed.body).toMatchObject({ title: "anonymous" });
  });

  it("reaches a standard write handler too, not only reads", async () => {
    const seen: unknown[] = [];
    const createHandler: OperationHandler<Todo> = {
      async execute(_input, context) {
        seen.push(context.principal);
        return { id: 1, title: "x", done: false, priority: 0, deletedAt: null, list: null };
      },
    };

    @Kavo(Todo, { operations: { createOne: { handler: createHandler } } })
    @Controller("todos")
    @UseGuards(new HeaderUserGuard())
    class CreatingController {}

    await bootstrap(CreatingController, true);
    await request(server()).post("/todos").send({ title: "x" }).set("x-user", "u-7").expect(201);
    expect(seen).toEqual([{ id: "u-7" }]);
  });
});

describe("boundKavoPrincipal — the methods Kavo does not generate", () => {
  @Kavo(Todo)
  @Controller("todos")
  @UseGuards(new HeaderUserGuard())
  class OverridingController {
    // The generated layout's trailing parameter, which is exactly why the
    // request is in it: an override reaches the engine itself, so it passes
    // the principal itself — through the app's configured extractor rather
    // than by re-deciding where the caller lives.
    @Override()
    async findOne(id: string, query: WireQuery, _preconditions: unknown, incoming: KavoPrincipalRequest) {
      const principal = boundKavoPrincipal(this, incoming);
      const item = await boundKavoService<Todo>(this).findOne(id as never, query as never, { principal });
      return { ...item, viewer: (principal as { id: string } | null)?.id ?? "anonymous" };
    }
  }

  it("runs the configured extractor for an @Override'd method", async () => {
    await bootstrap(OverridingController, true);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    const item = await request(server()).get("/todos/1").set("x-user", "u-7").expect(200);
    expect(item.body).toMatchObject({ id: 1, viewer: "u-7" });
  });

  it("answers null for the same method when no extractor is configured", async () => {
    await bootstrap(OverridingController);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);

    const item = await request(server()).get("/todos/1").set("x-user", "u-7").expect(200);
    expect(item.body.viewer).toBe("anonymous");
  });

  it("throws on an object the binder never visited, rather than answering null", () => {
    // "no extractor configured" and "this isn't a @Kavo controller" would
    // otherwise be the same silent `null` — the failure mode issue #142 is
    // about, reintroduced one layer up.
    class PlainService {}
    let error: unknown;
    try {
      boundKavoPrincipal(new PlainService(), {});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error).toMatchObject({
      code: "KAVO_CONFIG_INVALID",
      messageParams: { entity: "PlainService", path: "principal" },
    });
  });
});
