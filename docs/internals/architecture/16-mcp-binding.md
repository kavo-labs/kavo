# 16 — MCP Binding

`@kavo/mcp` (`packages/protocols/mcp`) exposes a `createCrud` service's
standard operations as [MCP](https://modelcontextprotocol.io) tools. Every
tool handler is a direct call into the same `DefaultKavoService`/engine
pipeline REST binds to — no parallel request path, no second copy of
filter/sort/pagination validation, no separate error handling. `@kavo/nest`
(`packages/frameworks/nest`) depends on `@kavo/mcp` to provide a ready-made
`BaseKavoMcpController`; the package topology and the one-directional
dependency this implies are ADR-0016's subject (the same ADR that already
governs `@kavo/graphql`) — this doc covers what the binding actually does.

## 1. Package boundary

`@kavo/mcp` is host-framework-agnostic: it imports `@kavo/core` and the
`@modelcontextprotocol/sdk` peer only, never `@kavo/nest` or any other
framework package (`protocol-bindings-only-import-core` in `.dependency-cruiser.cjs`). It
has no idea Nest, Express, or any other host exists. This is what makes its
discovery helper (§2) reusable by a future host binding with zero changes to
`@kavo/mcp` itself.

## 2. Building one entity's toolset

```ts
import { crudTools } from "@kavo/mcp";

const bindings = crudTools({
  name: "Owner",
  service: ownerService, // whatever createCrud(Owner, ...) returned
});
```

Each `KavoMcpToolBinding` pairs one MCP `Tool` definition with the handler
that runs it. There is no per-entity config — `crudTools` always produces
the full standard set, unconditionally:

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

This mirrors how `@Kavo` itself enables every standard operation by
default: no hand-authored per-entity JSON Schema to keep in sync, and no
`OperationRegistry` cross-check either — an entity that never declared
soft delete still gets `owner.restoreOne`/`owner.purgeOne` tools, and
calling either surfaces `OperationDisabledException` as a normal `isError`
result (§3), exactly like calling the equivalent disabled REST route
would. `createOne`/`updateOne`/`patchOne`'s `inputSchema` is deliberately
unconstrained (`{ type: "object" }`, or `{ type: "object", properties: {
id }, required: ["id"] }` for the two that also need an id) — JSON Schema
permits additional properties by default, so whatever fields a caller
sends land on the DTO as-is; the engine's own DTO layer is what actually
validates them, the same trust boundary REST already has.

`resolveKavoMcpTools` (`discovery.ts`) is the host-agnostic pipeline that
collects `crudTools` output across every entity a host hands it: given a
list of `{ entity }` refs and a `resolveService(entity)` callback, it
builds one flat list. **How to resolve one entity's bound service** is the
one thing left to the caller, supplied per host — `@kavo/nest`'s
`ModuleRef` + `getKavoServiceToken`, a plain `Map`, or whatever DI
container that host uses (the same split doc 13 §4 describes for
GraphQL's "resolve a service" half — this binding has no "which entities"
half to split out, since every entity handed to it is exposed
unconditionally). Unlike `mergeKavoGraphQLSchemas` (which must fail fast
on an empty `Query` type — GraphQL has no such thing as a schema with zero
fields), `resolveKavoMcpTools` never throws on an empty result: a toolset
with zero tools is a perfectly valid MCP `ListToolsResult`, so an empty
entity list is not treated as an error.

**`findMany`'s args** mirror `@kavo/graphql`'s query-root args: `sort` is
REST's own `-field` convention (`["-createdAt", "name"]`), translated into
`Sort[]` objects locally, and `filter` carries Kavo's raw filter AST
directly (`{ kind: "condition", field, operator, value }` for a leaf) — the
programmatic `QueryContext` surface, not REST's wire-string/camelCase form.

**Update/patch args are flat, not wrapped.** GraphQL's mutations take `(id,
input)` as two separate arguments because GraphQL has native argument
lists; an MCP tool call takes one JSON object, so `owner.updateOne`'s
`inputSchema` merges `id` directly into the DTO schema's own `properties`/
`required` instead of nesting the DTO under an `input` key — one flat
object a caller fills in once.

## 3. Result shape and error mapping

A successful call returns `{ content: [{ type: "text", text:
JSON.stringify(result) }] }` — the item (or the `{ items, total, limit,
offset }` envelope for `findMany`) serialized as MCP's `text` content
type. The whole envelope is stringified, so anything a `findMany` handler
contributes to the optional `meta` (doc 07 §3.1) reaches the tool result
unchanged, with no per-key schema work here — and when nothing does, the
key is absent from the stringified result exactly as it is from a REST
body.
A `KavoException` the engine raises (`NotFoundException`,
`OperationDisabledException`, a conflict, …) is caught and turned into an
**`isError: true`** tool result (`${code}: ${detail}` as the text) instead
of propagating — MCP's own convention for an expected domain failure: the
_call_ succeeded, the _operation_ didn't. An error the engine did not
itself raise (a bug, an unmapped adapter failure) still propagates, so it
surfaces as a protocol-level error rather than being silently reframed as
routine tool output.

## 4. The Nest binding

`@kavo/nest` (`packages/frameworks/nest/src/mcp/`) supplies the one
Nest-specific piece `resolveKavoMcpTools` needs (§2) and nothing else —
`getKavoEntities()` for "which entities exist" plus this for "how to
resolve one's service":

**`BaseKavoMcpController`** (abstract): `onModuleInit` calls
`resolveKavoMcpTools(getKavoEntities(), (entity) =>
this.moduleRef.get(getKavoServiceToken(entity), { strict: false }))` and
stores the result; `listTools()`/`callTool(name, args)` expose it. A
hand-written concrete class wires its own `@modelcontextprotocol/sdk`
server (`Server`/`McpServer`, whichever transport it wants — stdio, SSE,
streamable HTTP) and feeds it those two methods:

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

**`createDefaultMcpController(path)`** + `KavoModule`'s `mcp` option: the
zero-config path, the MCP counterpart of
`createDefaultGraphQLController`/`graphql: true` (doc 13, §5). Setting
`mcp` needs nothing else — every `@Kavo` entity gets its full standard
toolset automatically (§2), the same way `graphql: true` merges every
entity that called `registerKavoGraphQLTypes`, minus the registration step.
`KavoModule.forRoot({ infrastructure, mcp: true })` mounts `POST /mcp`;
`{ mcp: { path: "api/mcp" } }` mounts it there instead. Setting `mcp`
implies `provideServices`, the same way `graphql` does. Unlike GraphQL,
which has one natural default transport (`POST /graphql`, a JSON body),
MCP has several mutually incompatible ones (stdio, SSE, streamable HTTP)
— the default controller picks exactly one: the **Streamable HTTP**
transport (the SDK's recommended transport for remote servers), run
**stateless** — a fresh `Server` + `StreamableHTTPServerTransport`
(`sessionIdGenerator: undefined`) per request, connected, driven through
that one request, then closed, with `enableJsonResponse: true` so the
response is a plain JSON-RPC body instead of an SSE stream (no Kavo tool
handler ever pushes a server-initiated notification, so there is nothing
an SSE stream would carry that a plain response doesn't). Only `POST` is
wired — Streamable HTTP's `GET` (server-initiated SSE stream) and `DELETE`
(session termination) exist for _stateful_ mode only, which this
controller deliberately never enters. A hand-written concrete class
(previous bullet) and this flag are alternatives — pick one per app, never
both at the same path.

**No auth guard of its own.** `createDefaultMcpController` carries no
guard, interceptor, or other route-level protection — same as
`createDefaultGraphQLController`. A guard attached to an entity's
`@Kavo`-decorated REST controller does not extend to this route: `mcp:
true` mounts a separate, unguarded `POST /mcp` exposing every entity's
full standard toolset — including every write operation — to anyone who
can reach it, regardless of what protects the REST side. A consumer
needing auth on the MCP surface writes their own controller extending
`BaseKavoMcpController` (previous bullet) instead and leaves `mcp` unset.

This is the one place `@kavo/nest` genuinely runs
`@modelcontextprotocol/sdk` at runtime (§5).

## 5. Lazy-loading the SDK for the default controller only

`@kavo/graphql`'s Nest glue (doc 13, §6) lazily `import()`s `@kavo/graphql`
and the `graphql` peer together, because `@kavo/graphql`'s own module graph
statically imports `graphql`'s runtime `GraphQLSchema` machinery — merely
importing `@kavo/graphql` would transitively require `graphql` to be
resolvable, so `@kavo/nest`'s always-loaded module graph can never import
it eagerly without breaking every app that doesn't have `graphql`
installed.

`BaseKavoMcpController` itself has no equivalent risk: `Tool`/`CallToolResult`
are consumed as **types only** (`import type { CallToolResult, Tool } from
"@modelcontextprotocol/sdk/types.js"` in both `tools.ts` and
`base-kavo-mcp.controller.ts`) — type-only imports are fully erased by
`tsc` (`isolatedModules`/`verbatimModuleSyntax`, `tsconfig.base.json`), so
they cost nothing at runtime and never require `@modelcontextprotocol/sdk`
to be installed, only present at _compile_ time. Every `KavoMcpToolBinding`
`crudTools` builds is a plain object `@kavo/mcp` constructs itself — no SDK
runtime class is instantiated anywhere in `@kavo/mcp` or
`BaseKavoMcpController`. So `base-kavo-mcp.controller.ts` imports
`resolveKavoMcpTools` from `@kavo/mcp` directly at the top, the same way it
imports `@kavo/core` — no lazy-load wrapper needed there.

**`createDefaultMcpController` is different**: it genuinely instantiates
`Server` and `StreamableHTTPServerTransport`, real runtime classes from
`@modelcontextprotocol/sdk/server/*`. Since the SDK is an _optional_ peer
of `@kavo/nest`, that import can't be top-level either — the same
`ERR_MODULE_NOT_FOUND`-for-every-app risk doc 13 §6 describes for GraphQL.
`load-mcp-sdk.ts` is the fix, same shape as `load-graphql.ts`: a function
that dynamically `import()`s the SDK's `server/index.js`,
`server/streamableHttp.js`, and `types.js` subpaths inside a function body,
caches the result (`null` on failure), and throws a clear
`ConfigurationException` on failure. It's called only from
`DefaultMcpController.handle` — reached only by a consumer that opted in
via `KavoModule`'s `mcp` option — never from `index.ts`, `kavo.module.ts`,
or `base-kavo-mcp.controller.ts` directly.

`@modelcontextprotocol/sdk` is listed as an optional peer of both
`@kavo/mcp` and `@kavo/nest` (`peerDependenciesMeta`). A **peer**, so the
supported version range is declared and a package manager links the
consumer's own copy rather than nesting a second one. **Optional**, because
`@kavo/mcp` never executes the SDK — its only reference is
`import type { CallToolResult, Tool }` in `tools.ts`, fully erased — so
`@kavo/nest`'s eager `import { resolveKavoMcpTools } from "@kavo/mcp"`
resolves with the SDK absent, and a REST-only app is not made to install it
(#148). Marking it on both hops is what makes that true: `@kavo/nest`
depends on `@kavo/mcp` outright, so a required peer on the inner hop
force-installs the SDK regardless of the outer marking.

Note what optional does **not** buy: it has no bearing on type resolution.
A consumer who never installs the SDK loses the `Tool`/`CallToolResult`
declarations `tools.d.ts` re-exports, which surfaces as `TS2307` only under
`skipLibCheck: false` — `tsconfig.base.json` and Nest's own scaffold both
set it `true`, so the blast radius is narrow, but a hand-written
`BaseKavoMcpController` subclass that wants those types should install the
SDK as a devDependency.

## 6. What's out of scope (by design, for now)

- Constrained, per-DTO input schemas for `createOne`/`updateOne`/`patchOne`
  — every tool's `inputSchema` is deliberately unconstrained (§2); deriving
  a real JSON Schema from `EntityMetadata` (or a hand-supplied DTO schema)
  is real, scoped follow-up work, the same status `@kavo/graphql`'s
  `itemType`/`createInputType` are still in (doc 13, §7).
- Per-entity opt-out — every `@Kavo` entity handed to `resolveKavoMcpTools`
  gets the full standard toolset; there is no equivalent of `@kavo/graphql`'s
  `registerKavoGraphQLTypes` gate to exclude one.
- MCP resources and prompts — only tools are covered.
- Stateful MCP sessions (SSE server-initiated notifications, resumable
  streams, session-scoped state) — the default controller (§4) is
  deliberately stateless only; a hand-written concrete class can still wire
  a stateful transport itself.
- Bulk operations.

Each of these is real, valuable follow-up work, not an oversight.
