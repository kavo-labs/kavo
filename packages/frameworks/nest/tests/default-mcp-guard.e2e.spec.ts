import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Controller, Injectable, Module } from "@nestjs/common";
import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { Kavo, KavoModule, type KavoMcpOption } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { listen, type SupertestTarget } from "./support/listen.js";

/**
 * `mcp: { guards }` (issue #498): the zero-config MCP route carries the
 * guards it is given, resolved through DI like any controller's, and a
 * denying guard stops the request before any tool — so any engine call —
 * runs. `default-mcp-controller.e2e.spec.ts` covers the unguarded mount.
 */
@Kavo(Todo)
@Controller("todos")
class TodoController {}

@Injectable()
class DenyAll implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Injectable()
class AllowAll implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

/** A dependency the guard below can only get through DI. */
@Injectable()
class ApiKeys {
  readonly valid = new Set(["secret"]);
}

@Module({ providers: [ApiKeys], exports: [ApiKeys] })
class ApiKeysModule {}

@Injectable()
class ApiKeyGuard implements CanActivate {
  constructor(private readonly keys: ApiKeys) {}

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers[
      "x-api-key"
    ];
    return header !== undefined && this.keys.valid.has(header);
  }
}

let app: INestApplication;

afterEach(async () => {
  await app.close();
});

function mcpRequest(server: SupertestTarget, path = "/mcp") {
  return request(server)
    .post(path)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json");
}

const createCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "todo.createOne", arguments: { title: "guarded", done: false } },
};

async function boot(adapter: InMemoryTodoAdapter, mcp: KavoMcpOption) {
  const moduleRef = await Test.createTestingModule({
    imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), mcp })],
    controllers: [TodoController],
  }).compile();
  app = moduleRef.createNestApplication();
  return listen(app);
}

describe("KavoModule.forRoot({ mcp: { guards } })", () => {
  it("still serves the route unguarded when no guards are given", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { path: "mcp" });

    const called = await mcpRequest(server).send(createCall);

    expect(called.status).toBe(200);
    expect(adapter.rows).toHaveLength(1);
  });

  it("refuses with 403 when a guard denies, before any tool or engine call runs", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { guards: [DenyAll] });

    const called = await mcpRequest(server).send(createCall);
    const read = await mcpRequest(server).send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "todo.findMany", arguments: {} },
    });
    const listed = await mcpRequest(server).send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });

    expect([called.status, read.status, listed.status]).toEqual([403, 403, 403]);
    // Neither the write nor the read reached the adapter.
    expect(adapter.rows).toEqual([]);
    expect(adapter.lastQuery).toBeNull();
  });

  it("is covered by an app-wide APP_GUARD with no guards option", async () => {
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), mcp: true })],
      controllers: [TodoController],
      providers: [{ provide: APP_GUARD, useClass: DenyAll }],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    await mcpRequest(server).send(createCall).expect(403);
    expect(adapter.rows).toEqual([]);
  });

  it("serves the route when every guard allows", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { guards: [AllowAll] });

    const called = await mcpRequest(server).send(createCall);

    expect(called.status).toBe(200);
    expect(called.body.result.isError).toBeUndefined();
    expect(adapter.rows).toHaveLength(1);
  });

  it("applies a guard given as an instance rather than a class", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { guards: [new DenyAll()] });

    await mcpRequest(server).send(createCall).expect(403);
    expect(adapter.rows).toEqual([]);
  });

  it("keeps a custom path alongside the guards", async () => {
    const adapter = new InMemoryTodoAdapter();
    const server = await boot(adapter, { path: "api/mcp", guards: [DenyAll] });

    await mcpRequest(server, "/api/mcp").send(createCall).expect(403);
    await mcpRequest(server, "/mcp").send(createCall).expect(404);
  });

  it("resolves a guard's own dependency through DI under forRootAsync", async () => {
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          imports: [ApiKeysModule],
          useFactory: () => ({ infrastructure: fakeInfrastructure(adapter) }),
          mcp: { guards: [ApiKeyGuard] },
        }),
      ],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    await mcpRequest(server).send(createCall).expect(403);
    await mcpRequest(server).set("x-api-key", "wrong").send(createCall).expect(403);
    expect(adapter.rows).toEqual([]);

    const allowed = await mcpRequest(server).set("x-api-key", "secret").send(createCall);
    expect(allowed.status).toBe(200);
    expect(adapter.rows).toHaveLength(1);
  });
});
