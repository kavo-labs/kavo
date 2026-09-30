import { Body, Controller, Post, Req, Res, UseGuards, type CanActivate, type Type } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BaseKavoMcpController } from "./base-kavo-mcp.controller.js";
import { loadMcpSdk } from "./load-mcp-sdk.js";

/** `KavoModule.forRoot`/`forRootAsync({ mcp: true })`'s default mount path when no `path` override is given. */
export const DEFAULT_MCP_PATH = "mcp";

/**
 * Builds the zero-config MCP controller at `path` — one `POST <path>`
 * speaking the MCP Streamable HTTP transport, mounted by
 * `KavoModule.forRoot`/`forRootAsync` when `mcp` is set, with no
 * hand-written controller needed. A fresh class per call (never a shared
 * singleton), same reasoning as `createDefaultGraphQLController`: two
 * independently-configured Kavo modules in one process must never fight
 * over one `@Controller` path, and `emitDecoratorMetadata` only emits
 * `design:paramtypes` for a class tsc sees a real decorator applied to.
 *
 * Runs **stateless**: a fresh `Server` + `StreamableHTTPServerTransport`
 * per request (`sessionIdGenerator: undefined`), connected, driven through
 * exactly this one request, then closed — the pattern
 * `StreamableHTTPServerTransport`'s own doc comment recommends for
 * stateless mode. This matches every other Kavo route: no session, no
 * server-held connection state between calls, each request independent.
 * Only `POST` is wired — the streamable HTTP spec's `GET` (server-initiated
 * SSE stream) and `DELETE` (session termination) exist for *stateful* mode
 * only, which this controller deliberately never enters.
 *
 * Requires a Node `http`-compatible adapter (Express, which is what every
 * example and test in this repo runs on) — `@Req()`/`@Res()` here are
 * `IncomingMessage`/`ServerResponse` themselves, which
 * `transport.handleRequest` writes to directly; `@kavo/nest` does not
 * attempt to support a non-Node-http platform adapter (e.g. Fastify's raw
 * request/response) for this controller.
 *
 * Carries exactly the `guards` it is handed (`mcp: { guards }`, issue #498)
 * and no other route-level protection — same as
 * `createDefaultGraphQLController`. They go on the class with `UseGuards`,
 * so Nest resolves guard classes through DI like any controller's; applying
 * it after the class body is safe because the real `@Controller` already
 * made tsc emit `design:paramtypes`. With no
 * guards the route is unguarded: a guard attached to an entity's
 * `@Kavo`-decorated REST controller does **not** extend to it, so it exposes
 * that entity's full write surface (`createOne`/`updateOne`/`deleteOne`/etc.)
 * to anyone who can reach `path`. A consumer wanting a different method or
 * transport writes their own controller extending `BaseKavoMcpController`
 * instead and leaves `mcp` unset — this factory and a custom controller are
 * alternatives, never both at once.
 */
export function createDefaultMcpController(
  path: string = DEFAULT_MCP_PATH,
  guards: readonly (Type<CanActivate> | CanActivate)[] = [],
): Type<BaseKavoMcpController> {
  @Controller(path)
  class DefaultMcpController extends BaseKavoMcpController {
    constructor(moduleRef: ModuleRef) {
      super(moduleRef);
    }

    @Post()
    async handle(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Body() body: unknown): Promise<void> {
      const { Server, StreamableHTTPServerTransport, ListToolsRequestSchema, CallToolRequestSchema } =
        await loadMcpSdk();

      const server = new Server({ name: "kavo", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.listTools() }));
      server.setRequestHandler(CallToolRequestSchema, (request) =>
        this.callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
      );

      // `enableJsonResponse: true` — a plain JSON-RPC response instead of an
      // SSE stream (the transport's default). Every Kavo MCP tool handler
      // is a single request/response call with no server-initiated
      // notifications, so there's nothing an SSE stream would carry that a
      // plain response doesn't.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    }
  }

  if (guards.length > 0) {
    UseGuards(...guards)(DefaultMcpController);
  }
  return DefaultMcpController;
}
