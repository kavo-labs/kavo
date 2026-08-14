# MCP

`@kavo/mcp` exposes a `createCrud` service's standard operations as [Model Context Protocol](https://modelcontextprotocol.io) tools. Every tool handler calls straight into the same engine REST uses — no parallel request path, no second copy of validation or error handling.

## Zero-config mounting

`KavoModule`'s `mcp` option mounts a default controller exposing every `@Kavo` entity's full standard toolset — no per-entity opt-in step, unlike GraphQL:

```ts
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  mcp: true, // mounts POST /mcp
});

// Or choose the path:
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  mcp: { path: "api/mcp" },
});
```

Setting `mcp` implies `provideServices`, the same way `graphql` does. It requires `@modelcontextprotocol/sdk` installed.

The default controller uses the SDK's **Streamable HTTP** transport, run **stateless** — a fresh server instance per request, connected, driven through that one request, then closed, with plain JSON-RPC responses rather than an SSE stream. Only `POST` is wired; Streamable HTTP's `GET` (server-initiated stream) and `DELETE` (session termination) exist only for stateful mode, which the default controller never enters.

## Every entity's full toolset

`crudTools` always produces the same eight tools per entity, unconditionally — no per-entity config:

| Tool                  | Args                                              |
| --------------------- | ------------------------------------------------- |
| `<entity>.findOne`    | `{ id }`                                          |
| `<entity>.findMany`   | `{ limit?, offset?, sort?, filter? }`             |
| `<entity>.createOne`  | any fields (forwarded straight to the create DTO) |
| `<entity>.updateOne`  | `{ id, ...anyFields }`                            |
| `<entity>.patchOne`   | `{ id, ...anyFields }`                            |
| `<entity>.deleteOne`  | `{ id }`                                          |
| `<entity>.restoreOne` | `{ id }`                                          |
| `<entity>.purgeOne`   | `{ id }`                                          |

An entity that never declared soft delete still gets `restoreOne`/`purgeOne` tools; calling either surfaces `OperationDisabledException` as a normal `isError` tool result, exactly like the equivalent disabled REST route would. `findMany`'s `filter`/`sort` args use the same raw-AST/`-field` convention [GraphQL](/integrations/protocols/graphql) does.

A successful call returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`. A `KavoException` — not found, disabled operation, a conflict — is caught and turned into `isError: true` with `${code}: ${detail}` as the text, MCP's own convention for an expected domain failure. Anything the engine didn't itself raise still propagates as a protocol-level error.

## No auth guard by default

The zero-config controller carries **no guard, interceptor, or other route-level protection** — a guard on an entity's `@Kavo`-decorated REST controller does not extend to `POST /mcp`. Setting `mcp: true` exposes every entity's full standard toolset, including every write operation, to anyone who can reach that route. If the MCP surface needs auth, write your own controller instead (below) and leave `mcp` unset.

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

Wire your own `@modelcontextprotocol/sdk` server (`Server`/`McpServer`, whichever transport you want — stdio, SSE, streamable HTTP) around `listTools()`/`callTool()`. Pick one mounting approach per app — the zero-config option and a hand-written controller are alternatives, never both at the same path.

## Outside Nest

`@kavo/mcp` is host-framework-agnostic — it imports `@kavo/core` and the `@modelcontextprotocol/sdk` peer (for types only) and never `@kavo/nest`. `crudTools`/`resolveKavoMcpTools` build a toolset directly from one or more `createCrud` services, for any host that can run an MCP server.

## Installing it

`@modelcontextprotocol/sdk` is an optional peer of both `@kavo/nest` and `@kavo/mcp`, so a REST-only install pulls in neither:

::: code-group

```bash [pnpm]
pnpm add @modelcontextprotocol/sdk
```

```bash [npm]
npm install @modelcontextprotocol/sdk
```

:::

See [Installation](/getting-started/installation#graphql-and-mcp) for the full peer-dependency picture.

## What's not covered yet

Every tool's `inputSchema` for `createOne`/`updateOne`/`patchOne` is deliberately unconstrained (`{ type: "object" }`) rather than a real per-DTO JSON Schema; there's no per-entity opt-out (every `@Kavo` entity gets the full toolset); and stateful MCP sessions (resumable streams, server-initiated notifications) aren't supported by the default controller — a hand-written one can still wire a stateful transport itself. See [MCP binding](/internals/architecture/16-mcp-binding) for the full design, including the same one-directional `frameworks/* → protocols/*` boundary ([ADR-0016](/internals/adr/0016-graphql-protocols-package)) GraphQL uses.
