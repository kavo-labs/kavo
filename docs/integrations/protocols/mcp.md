# MCP

`@kavo/mcp` exposes a `createCrud` service's standard operations as [Model Context Protocol](https://modelcontextprotocol.io) tools. Every tool handler calls straight into the same engine REST uses. There's no parallel request path and no second copy of validation or error handling.

## Zero-config mounting

`KavoModule`'s `mcp` option mounts a default controller exposing every `@Kavo` entity's full standard toolset. Unlike GraphQL, there's no per-entity opt-in step:

```ts
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  mcp: true, // mounts POST /mcp, unguarded: see "No auth guard by default"
});

// Or choose the path, and guard it:
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  mcp: { path: "api/mcp", guards: [McpAuthGuard] },
});
```

Setting `mcp` implies `provideServices`, the same way `graphql` does. It requires `@modelcontextprotocol/sdk` installed.

**Without `guards`, the zero-config route has no auth guard.** Anyone who can reach `POST /mcp` can call every entity's tools, writes included. See [No auth guard by default](#no-auth-guard-by-default) before you set `mcp: true`.

The default controller uses the SDK's Streamable HTTP transport, run stateless. Each request gets a fresh server instance: connected, driven through that one request, then closed, with plain JSON-RPC responses rather than an SSE stream. Only `POST` is wired. Streamable HTTP's `GET` (server-initiated stream) and `DELETE` (session termination) exist only for stateful mode, which the default controller never enters.

## Every entity's full toolset

`crudTools` always produces the same eight tools per entity, with no per-entity config. The one exception is an operation marked service-only (`meta.routes.enabled: false`): it gets no REST route, and no tool either, standard or custom.

| Tool                  | Args                                                 |
| --------------------- | ---------------------------------------------------- |
| `<entity>.findOne`    | `{ id }`                                             |
| `<entity>.findMany`   | `{ limit?, offset?, sort?, filter? }`                |
| `<entity>.createOne`  | any fields (forwarded straight to the create schema) |
| `<entity>.updateOne`  | `{ id, ...anyFields }`                               |
| `<entity>.patchOne`   | `{ id, ...anyFields }`                               |
| `<entity>.deleteOne`  | `{ id }`                                             |
| `<entity>.restoreOne` | `{ id }`                                             |
| `<entity>.purgeOne`   | `{ id }`                                             |

An entity that never declared soft delete still gets `restoreOne` and `purgeOne` tools. Calling either surfaces `OperationDisabledException` as a normal `isError` tool result, exactly like the equivalent disabled REST route would. `findMany`'s `filter` and `sort` args use the same raw-AST/`-field` convention [GraphQL](/integrations/protocols/graphql) does.

## Custom operations

A [custom operation](/core/custom-operations) reaches this toolset too, with no per-entity config: `crudTools` walks the same operation registry route generation reads, so an enabled custom id gets a `<entity>.<operationId>` tool as long as its `operations.<id>.schema.output` is declared — a custom id has no entity-derived schema fallback the way the standard eight do, so one with nothing declared has nothing to build even a loose schema from, and is left out. The tool's schema follows the same shape the standard eight use: `{ id }` when the operation is single-row and declares no `schema.input`, `{ id, ...anyFields }` when it also declares one, and the equivalent id-less shapes for a many-cardinality operation.

A successful call returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`. A `KavoException` (not found, disabled operation, a conflict) is caught and turned into `isError: true` with `${code}: ${detail}` as the text, MCP's own convention for an expected domain failure. Any other error becomes an `isError` result with `KAVO_UNEXPECTED_ERROR: <generic message>`, and its own message is appended only when `errors.exposeInternals` is on.

## No auth guard by default

Unless you pass `guards`, the zero-config controller carries no guard, interceptor, or other route-level protection. A guard on an entity's `@Kavo`-decorated REST controller does not extend to `POST /mcp`. Setting `mcp: true` exposes every entity's full standard toolset, including every write operation, to anyone who can reach that route. To gate it, hand the option your guards:

```ts
KavoModule.forRoot({ infrastructure, mcp: { guards: [McpAuthGuard] } });
```

They go on the generated controller with `@UseGuards`, so a denial stops the request before any tool runs, with the guard's own error (`403` when it returns `false`). A guard class is built inside `KavoModule`, so its dependencies must come from a global module or from `forRootAsync`'s `imports`, and it must stay singleton-scoped ([Guarding the zero-config routes](/guides/configuration/module-setup#guarding-the-zero-config-routes)). An app-wide `APP_GUARD` also covers the route.

A guard decides whether a request gets in. It does not tell the engine who is calling, and nothing else that lives on a REST controller carries over either. Tool handlers call the entity's service directly, so an `@Override`'d method's own authorization, Nest's `ValidationPipe`, and the module's `app` context extractor never run for an MCP call; `context.app` is `{}`, guards or not. The engine's own rules (field allowlists, write-body stripping, `policy`, `filter.apply`, `set`) still apply, so a per-caller rule (an `owner()` policy, a tenant `filter.apply`) sees no caller over MCP. That is true of a hand-written `BaseKavoMcpController` too, which has no way to pass one.

## Mounting your own controller

```ts
@Injectable()
export class McpToolset extends BaseKavoMcpController {
  constructor(moduleRef: ModuleRef) {
    super(moduleRef);
  }

  tools() {
    return this.listTools();
  }

  run(name: string, args: Record<string, unknown>) {
    return this.callTool(name, args);
  }
}
```

Wire your own `@modelcontextprotocol/sdk` server (`Server` or `McpServer`, whichever transport you want: stdio, SSE, streamable HTTP) around `listTools()` and `callTool()`. Pick one mounting approach per app. The zero-config option and a hand-written controller are alternatives, never both at the same path.

## Outside Nest

`@kavo/mcp` is host-framework-agnostic: it imports `@kavo/core` and the `@modelcontextprotocol/sdk` peer (for types only) and never `@kavo/nest`. `crudTools` and `resolveKavoMcpTools` build a toolset directly from one or more `createCrud` services, for any host that can run an MCP server.

## Installing it

`@modelcontextprotocol/sdk` is an optional peer of both `@kavo/nest` and `@kavo/mcp`, so a REST-only install pulls in neither.

Inside a Nest app, `@kavo/nest` already depends on `@kavo/mcp`. Add just the peer:

<CodeGroup>

```bash pnpm
pnpm add @modelcontextprotocol/sdk
```

```bash npm
npm install @modelcontextprotocol/sdk
```

```bash yarn
yarn add @modelcontextprotocol/sdk
```

```bash bun
bun add @modelcontextprotocol/sdk
```

</CodeGroup>

Outside Nest, add `@kavo/mcp` yourself too, alongside `@kavo/core` and whichever ORM adapter you use:

<CodeGroup>

```bash pnpm
pnpm add @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

```bash npm
npm install @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

```bash yarn
yarn add @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

```bash bun
bun add @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

</CodeGroup>

See [Peer dependencies](/reference/peer-dependencies) for the full version table.

## What's not covered yet

- Every tool's `inputSchema` for `createOne`, `updateOne`, and `patchOne` is deliberately unconstrained (`{ type: "object" }`) rather than a real per-schema JSON Schema.
- There's no per-entity opt-out. Every `@Kavo` entity gets the full toolset.
- Stateful MCP sessions (resumable streams, server-initiated notifications) aren't supported by the default controller, though a hand-written one can still wire a stateful transport itself.

See [MCP binding](/internals/architecture/16-mcp-binding) for the full design, including the same one-directional `frameworks/* → protocols/*` boundary ([ADR-0016](/internals/adr/0016-graphql-protocols-package)) GraphQL uses.
