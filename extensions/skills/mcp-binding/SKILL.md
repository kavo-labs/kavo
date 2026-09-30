---
name: mcp-binding
description: Reference for @kavo/mcp and its Nest binding — the standard per-entity toolset, findMany's raw-AST filter/sort args, flat update/patch args, isError result mapping, the zero-config KavoModule mcp option, and the fact that the default MCP route carries no auth guard. Use when exposing entities to an MCP client, or answering "how do I add MCP tools to this entity" questions.
---

# MCP binding reference

`@kavo/mcp` exposes a `createCrud` service's standard operations as
[MCP](https://modelcontextprotocol.io) tools. Every tool handler calls
directly into the same engine pipeline REST binds to — no parallel request
path, no second copy of filter/sort/pagination validation, no separate error
handling.

`@kavo/mcp` is host-framework-agnostic: it imports `@kavo/core` and the
`@modelcontextprotocol/sdk` peer **for types only**, never `@kavo/nest`.
`@kavo/nest` depends on `@kavo/mcp`, not the other way around (ADR-0016).

## One entity's toolset

```ts
import { crudTools } from "@kavo/mcp";

const bindings = crudTools({
  name: "Owner",
  service: ownerService, // whatever createCrud(Owner, ...) returned
});
```

Each `KavoMcpToolBinding` pairs one MCP `Tool` definition with its handler.
**There is no per-entity config** — `crudTools` always produces the full
standard set:

| Tool               | Args                                              |
| ------------------ | ------------------------------------------------- |
| `owner.findOne`    | `{ id }`                                          |
| `owner.findMany`   | `{ limit?, offset?, sort?, filter? }`             |
| `owner.createOne`  | any fields (forwarded straight to the create DTO) |
| `owner.updateOne`  | `{ id, ...anyFields }`                            |
| `owner.patchOne`   | `{ id, ...anyFields }`                            |
| `owner.deleteOne`  | `{ id }`                                          |
| `owner.restoreOne` | `{ id }`                                          |
| `owner.purgeOne`   | `{ id }`                                          |

This mirrors `@Kavo` enabling every standard operation by default. **There is
no cross-check against the `OperationRegistry`**: an entity that never
declared soft delete still gets `restoreOne`/`purgeOne` tools, and calling
one returns an `OperationDisabledException` as a normal error result —
exactly what calling the equivalent disabled REST route would do.

The write tools' `inputSchema` is deliberately unconstrained about _fields_:
JSON Schema permits additional properties by default, so whatever a caller
sends lands on the DTO as-is and the engine's own DTO layer validates it —
the same trust boundary REST has. `createOne` is a bare
`{ type: "object" }`; `updateOne` and `patchOne` are
`{ type: "object", properties: { id }, required: ["id"] }`, so **`id` is a
declared, required property** on those two even though every other field is
free-form.

### `findMany` args are the programmatic surface, not REST's

- **`sort`** — REST's `-field` convention (`["-createdAt", "name"]`).
- **`filter`** — Kavo's **raw filter AST**, not REST's wire grammar:
  - leaf: `{ kind: "condition", field, operator, value }`
  - group: `{ kind: "group", operator: "AND"|"OR"|"NOT", children: [...] }`
  - operators are `SCREAMING_SNAKE` (`EQ`, `GTE`, `IN`, …) — the camelCase
    wire tokens (`eq`, `gte`, `in`) do **not** work here.

This matches `@kavo/graphql`'s query-root args exactly.

### Update/patch args are flat, not wrapped

An MCP tool call takes one JSON object, so `owner.updateOne` merges `id`
directly into the DTO schema's own `properties`/`required` rather than
nesting the DTO under an `input` key — one flat object, unlike GraphQL's
`(id, input)` pair.

## Results and errors

A successful call returns its result JSON-stringified as MCP `text` content.
The result is not always the entity — do not assume an item shape:

| Tool                                                          | Result                            |
| ------------------------------------------------------------- | --------------------------------- |
| `findOne`, `createOne`, `updateOne`, `patchOne`, `restoreOne` | the item                          |
| `findMany`                                                    | `{ items, total, limit, offset }` |
| `deleteOne`                                                   | `{ deleted: true }`               |
| `purgeOne`                                                    | `{ purged: true }`                |

A `KavoException` the engine raises becomes an **`isError: true`** tool
result with `${code}: ${detail}` as the text, MCP's convention for an
expected domain failure: the _call_ succeeded, the _operation_ didn't. Any
other error becomes an `isError` result with `KAVO_UNEXPECTED_ERROR` and a
generic message; its own message is appended only when `exposeInternals` is
on, so a runtime error never leaks internals into the JSON-RPC response.

## Many entities

`resolveKavoMcpTools` takes a list of `{ entity }` refs plus a
`resolveService(entity)` callback and returns one flat tool list. Unlike
GraphQL's `mergeKavoGraphQLSchemas`, it **never throws on an empty result** —
a toolset with zero tools is a valid MCP `ListToolsResult`.

## The Nest binding

Two ways to mount it, pick one per app — never both at the same path:

1. **Concrete controller** (full control over transport and auth):

   ```ts
   @Injectable()
   export class McpToolset extends BaseKavoMcpController {
     constructor(moduleRef: ModuleRef) {
       super(moduleRef);
     } // must be declared

     tools() {
       return this.listTools();
     }
     run(name: string, args: Record<string, unknown>) {
       return this.callTool(name, args);
     }
   }
   ```

   `onModuleInit` resolves every `@Kavo` entity's toolset; you wire your own
   `@modelcontextprotocol/sdk` server and transport (stdio, SSE, streamable
   HTTP) and feed it those two methods.

2. **Zero-code path**: `KavoModule.forRoot({ infrastructure, mcp: true })`
   mounts `POST /mcp`; `{ mcp: { path: "api/mcp" } }` mounts it elsewhere.
   Setting `mcp` implies `provideServices`. The default controller picks one
   transport — **Streamable HTTP, stateless**: a fresh server and transport
   per request with `enableJsonResponse: true`, so the response is a plain
   JSON-RPC body. Only `POST` is wired; Streamable HTTP's `GET` and `DELETE`
   exist for stateful mode, which this controller never enters.

### ⚠️ The default MCP route has no auth guard unless you give it one

`mcp: true` mounts a separate, **unguarded** `POST /mcp` exposing every
entity's full standard toolset — **including every write operation** — to
anyone who can reach it. A guard on an entity's `@Kavo`-decorated REST
controller does **not** extend to this route.

Pass guards to protect it: `mcp: { guards: [McpAuthGuard] }` (a class or an
instance). They go on the generated controller with `@UseGuards`, so a
denial stops the request before any tool runs (`403` when the guard returns
`false`). A guard class is built inside `KavoModule`, so its dependencies
must come from a global module or from `forRootAsync({ imports })`, and it
must stay singleton-scoped: a request-scoped guard leaves the rebuilt
controller with no tools. An app-wide `APP_GUARD` covers the route too.

A guard gates the route; it does not identify the caller to the engine.
`context.app` is `{}` for every MCP call, guarded or not, so per-caller
`policy` or `filter.apply` rules see no caller there.

## Where to go next

- The same idea over GraphQL → `graphql-binding`
- What the underlying operations do → `kavo-decorator`
- Filter AST operators and their REST equivalents → `query-grammar`
- Exception codes that become `isError` text → `error-handling`
