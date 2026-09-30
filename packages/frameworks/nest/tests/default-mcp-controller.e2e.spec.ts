import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Controller } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { Kavo, KavoModule } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";
import { listen, type SupertestTarget } from "./support/listen.js";

/**
 * Proves the zero-controller path: `KavoModule.forRoot({ mcp: true })`
 * mounts `POST /mcp` on its own, speaking the MCP Streamable HTTP
 * transport in stateless mode — no `McpController` anywhere in this file,
 * unlike `base-kavo-mcp.controller.e2e.spec.ts`, which covers the opt-out
 * (a hand-written controller extending `BaseKavoMcpController`). Every
 * `@Kavo` entity gets the full standard toolset unconditionally — no
 * per-entity MCP config.
 */
@Kavo(Todo)
@Controller("todos")
class TodoController {}

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

describe("KavoModule.forRoot({ mcp: true })", () => {
  it("mounts POST /mcp with no controller of its own, resolving tools/list and tools/call", async () => {
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), mcp: true })],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    const listed = await mcpRequest(server).send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    const toolNames = (listed.body.result.tools as { name: string }[]).map((tool) => tool.name).sort();
    expect(toolNames).toEqual(
      [
        "todo.createOne",
        "todo.deleteOne",
        "todo.findMany",
        "todo.findOne",
        "todo.patchOne",
        "todo.purgeOne",
        "todo.restoreOne",
        "todo.updateOne",
      ].sort(),
    );

    const called = await mcpRequest(server).send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "todo.createOne", arguments: { title: "from mcp http", done: false } },
    });
    expect(called.status).toBe(200);
    expect(called.body.result.isError).toBeUndefined();
    const created = JSON.parse(called.body.result.content[0].text);
    expect(created).toMatchObject({ id: 1, title: "from mcp http", done: false });
  });

  it("mounts at a custom path when { path } is given instead of true", async () => {
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), mcp: { path: "api/mcp" } })],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    await mcpRequest(server, "/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(404);

    const listed = await mcpRequest(server, "/api/mcp").send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(listed.status).toBe(200);
    expect((listed.body.result.tools as { name: string }[]).map((tool) => tool.name).sort()).toEqual(
      [
        "todo.createOne",
        "todo.deleteOne",
        "todo.findMany",
        "todo.findOne",
        "todo.patchOne",
        "todo.purgeOne",
        "todo.restoreOne",
        "todo.updateOne",
      ].sort(),
    );
  });

  it("mounts no controller at all when mcp is left unset", async () => {
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter) })],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    await mcpRequest(server).send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }).expect(404);
  });

  it("falls back to the default path when given an options object that omits one", async () => {
    // `mcp: {}` is what an app writes when it builds the option object
    // programmatically and has no path to contribute. It has to mean the
    // same thing as `mcp: true`, not "mount at undefined".
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), mcp: {} })],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    const listed = await mcpRequest(server).send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
  });

  it("mounts the same way under forRootAsync", async () => {
    // The async form resolves its options through a factory, so the
    // controller is built from a different branch than `forRoot`'s.
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({ useFactory: () => ({ infrastructure: fakeInfrastructure(adapter) }), mcp: true }),
      ],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    const listed = await mcpRequest(server).send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    expect((listed.body.result.tools as { name: string }[]).length).toBeGreaterThan(0);
  });

  it("treats a tools/call with no arguments key as an empty argument object", async () => {
    // An MCP client legitimately omits `arguments` for a tool that needs
    // none, so reading it unguarded would turn a valid call into a crash.
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), mcp: true })],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    const called = await mcpRequest(server).send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "todo.findMany" },
    });

    expect(called.status).toBe(200);
    expect(called.body.result.isError).toBeUndefined();
    expect(JSON.parse(called.body.result.content[0].text)).toMatchObject({ items: [] });
  });

  it("answers a malformed argument with a KAVO_QUERY_* tool result, never a raw runtime message (#523)", async () => {
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), mcp: true })],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    const called = await mcpRequest(server).send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "todo.findMany", arguments: { sort: "-title" } },
    });

    expect(called.status).toBe(200);
    expect(called.body.error).toBeUndefined();
    expect(called.body.result.isError).toBe(true);
    expect(called.body.result.content[0].text).toMatch(/^KAVO_QUERY_INVALID: /);
  });

  it("maps a not-found id to an isError tool result over HTTP", async () => {
    const adapter = new InMemoryTodoAdapter();
    const moduleRef = await Test.createTestingModule({
      imports: [KavoModule.forRoot({ infrastructure: fakeInfrastructure(adapter), mcp: true })],
      controllers: [TodoController],
    }).compile();
    app = moduleRef.createNestApplication();
    const server = await listen(app);

    const called = await mcpRequest(server).send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "todo.findOne", arguments: { id: 999 } },
    });
    expect(called.status).toBe(200);
    expect(called.body.result.isError).toBe(true);
    expect(called.body.result.content[0].text).toContain("KAVO_NOT_FOUND");
  });
});
