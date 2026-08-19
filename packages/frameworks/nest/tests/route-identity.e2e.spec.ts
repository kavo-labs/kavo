import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Controller, Get, UseGuards, UseInterceptors, type CallHandler, type CanActivate, type ExecutionContext, type INestApplication, type NestInterceptor } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Observable } from "rxjs";
import type { OperationId, WireQuery } from "@kavo/core";
import { Kavo, KavoModule, Override, boundKavoService, getOperation, getResource } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * `getResource`/`getOperation` read route identity off Nest's
 * `ExecutionContext` (issue #238) — the only context shape that exists in a
 * `Guard`/`Interceptor`, which run before the controller method and so
 * before Kavo's own `KavoContext`. The metadata read is what this file
 * pins: a guard records what the helpers answer on each real request, and
 * the array-mutation coverage drives a synthetic `ExecutionContext` (those
 * routes carry the same per-method metadata; serving them over HTTP needs
 * an adapter `array-mutation-route-reachable.e2e.spec.ts` already
 * exercises at the bootstrap level).
 */

let app: INestApplication;
let httpServer: SupertestTarget | undefined;

/** What `getResource`/`getOperation` answered for one request, in order. */
const seen: Array<{ resource: string | undefined; operation: OperationId | undefined }> = [];

class RecordingGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    seen.push({ resource: getResource(context), operation: getOperation(context) });
    return true;
  }
}

class RecordingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    seen.push({ resource: getResource(context), operation: getOperation(context) });
    return next.handle();
  }
}

async function bootstrap(controllers: readonly unknown[]): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) }),
      KavoModule.forFeature(controllers as never),
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

/** A synthetic `ExecutionContext` for decoration-level metadata reads. */
function contextFor(handler: unknown, clazz: unknown): ExecutionContext {
  return { getHandler: () => handler, getClass: () => clazz } as ExecutionContext;
}

describe("getResource/getOperation — a generated route (issue #238)", () => {
  @Kavo(Todo)
  @Controller("todos")
  @UseGuards(new RecordingGuard())
  @UseInterceptors(new RecordingInterceptor())
  class TodosController {}

  beforeEach(async () => {
    seen.length = 0;
    await bootstrap([TodosController]);
  });

  it("reports the entity name and operation id from a guard", async () => {
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    expect(seen[0]).toEqual({ resource: "Todo", operation: "createOne" });
  });

  it("reports findMany for a list request", async () => {
    await request(server()).get("/todos").expect(200);
    expect(seen[0]).toEqual({ resource: "Todo", operation: "findMany" });
  });

  it("reports findOne for an id-addressed request", async () => {
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    await request(server()).get("/todos/1").expect(200);
    expect(seen.at(-1)).toEqual({ resource: "Todo", operation: "findOne" });
  });

  it("answers the same from an interceptor, which runs later in the same request", async () => {
    await request(server()).get("/todos").expect(200);
    // Guard first, interceptor second — both see the same identity.
    expect(seen).toEqual([
      { resource: "Todo", operation: "findMany" },
      { resource: "Todo", operation: "findMany" },
    ]);
  });
});

describe("getResource/getOperation — an @Override'd route", () => {
  @Kavo(Todo)
  @Controller("todos")
  @UseGuards(new RecordingGuard())
  class OverridingController {
    @Override()
    async findOne(id: string, query: WireQuery) {
      return boundKavoService<Todo>(this).findOne(id as never, query as never);
    }
  }

  it("reports the operation id for the @Override'd method", async () => {
    seen.length = 0;
    await bootstrap([OverridingController]);
    await request(server()).post("/todos").send({ title: "x" }).expect(201);
    await request(server()).get("/todos/1").expect(200);

    expect(seen.at(-1)).toEqual({ resource: "Todo", operation: "findOne" });
  });
});

describe("getResource/getOperation — a non-Kavo controller", () => {
  @Controller("health")
  @UseGuards(new RecordingGuard())
  class HealthController {
    @Get()
    health(): string {
      return "ok";
    }
  }

  it("answers undefined for both, rather than throwing", async () => {
    seen.length = 0;
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) })],
      controllers: [HealthController],
    }).compile();
    app = moduleRef.createNestApplication();
    httpServer = await listen(app);

    await request(server()).get("/health").expect(200);
    expect(seen[0]).toEqual({ resource: undefined, operation: undefined });
  });
});

describe("getResource/getOperation — a synthesized arrayMutation sub-collection route", () => {
  class Tag {
    id = 0;
    name = "";
  }

  class Post {
    id = 0;
    title = "";
    tags: Tag[] = [];
  }

  it("reports the synthesized replace<Relation> operation id", () => {
    @Kavo(Post, { arrayMutation: { strategy: "replace" }, relations: { edges: { tags: { write: true } } } } as never)
    class PostController {}

    const handler = (PostController.prototype as Record<string, unknown>).replaceTags as (...args: unknown[]) => unknown;
    const context = contextFor(handler, PostController);
    expect(getResource(context)).toBe("Post");
    expect(getOperation(context)).toBe("replaceTags");
  });

  it("reports the synthesized list<Relation> operation id of the resource strategy", () => {
    @Kavo(Post, { arrayMutation: { strategy: "resource" }, relations: { edges: { tags: { write: true } } } } as never)
    class PostController {}

    const handler = (PostController.prototype as Record<string, unknown>).listTags as (...args: unknown[]) => unknown;
    const context = contextFor(handler, PostController);
    expect(getResource(context)).toBe("Post");
    expect(getOperation(context)).toBe("listTags");
  });
});