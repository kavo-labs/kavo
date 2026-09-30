# Security guide

Kavo is written against one threat model: a remote client who can send any request it likes to the routes your app exposes, but who does not control your configuration. It trusts its config the way any framework does, so `exposeInternals: true` in production is a configuration choice, not a Kavo vulnerability. What a request can reach is either enforced by the engine, bounded by the config you write, or left to the host app on purpose, and the defaults are open: an entity with no config exposes every column it has.

## What Kavo enforces

These rows hold on every ORM adapter and protocol surface that can express the attack, except where a known gap is marked. The shared [security conformance suite](https://github.com/kavo-labs/kavo/tree/main/tools/security-testkit) proves them under the case names in the last column, against a fixture that configures every allowlist explicitly. So each guarantee is only as narrow as the allowlist you give it; see [Risky configuration](#risky-configuration) for what an unset one allows. [`SECURITY.md`](https://github.com/kavo-labs/kavo/blob/main/SECURITY.md#security-hardening) summarizes the same protections.

| Guarantee                                                                                                                                                                                                | Where it's explained                | Conformance cases                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| A write body carries only the fields its write shape allows, and generated and primary-key columns are stripped. With no input schema, the write shape is every other column plus every to-one relation. | [Schemas](/core/schemas)            | `create-strips-protected-fields`, `patch-keeps-primary-key`                                 |
| A client filters, sorts and selects only the fields each allowlist names.                                                                                                                                | [Allowed fields](/features/allowed) | `filter-hidden-column`, `sort-hidden-column`, `select-hidden-column`                        |
| A response never serializes a column outside `select.fields`, unless a registered `item` or `list` output schema widens it.                                                                              | [Allowed fields](/features/allowed) | `response-hides-column`                                                                     |
| Query input is parsed into an AST, never concatenated into SQL or a NoSQL query.                                                                                                                         | [Filtering](/querying/filtering)    | `filter-identifier-injection`, `filter-value-literal`                                       |
| `%` and `_` in a search term match literally. Not yet on `@kavo/prisma` or `@kavo/mikroorm` (#520).                                                                                                      | [Search](/querying/search)          | `search-escapes-wildcards`                                                                  |
| Prototype-named keys and operators are rejected, not walked.                                                                                                                                             | [Filtering](/querying/filtering)    | `filter-prototype-key`, `filter-prototype-operator`                                         |
| NUL characters and non-finite numbers in filter values are a `400`.                                                                                                                                      | [Filtering](/querying/filtering)    | `filter-nul-character`, `filter-non-finite-number`                                          |
| `policy` denies an operation with a `403` before the row changes, and a missing row stays a `404` first.                                                                                                 | [Policy](/features/policy)          | `policy-denial`, `missing-row-before-denial`                                                |
| `filter.apply` scopes `findMany`, and every id-addressed read or write, of the entity it is declared on. It does not reach included rows or association targets yet (#515, #516).                        | [Apply](/features/apply)            | `apply-scopes-find-many`; the id-addressed cases are in `packages/core/tests/apply.spec.ts` |
| An error body carries a `KAVO_*` code and a detail, never a stack or query text.                                                                                                                         | [Errors](/reference/errors)         | `error-body-hides-internals`                                                                |

Past those, two property-based suites in `packages/core/tests/` throw generated input at the query-string normalizer and the JSON Patch parser on every CI run, and each example app carries a `security.e2e.spec.ts` for attacks specific to its framework: content types, body shapes, route-id encoding.

## What your app must do

Kavo authenticates nobody, validates no values unless you give it a way to, and adds no body-size limit, rate limit, CORS policy, CSRF protection or TLS. Each of these runs ahead of the route in the host app.

### Authentication

On Nest, a guard decides who the caller is, and Kavo's `app` option turns that caller into `KavoContext.app` for `policy`, `filter.apply` and `set` to read. See [Wiring your own auth](/guides/wiring-your-own-auth) for typing `KavoAppContext`, building it, and why every field should be optional.

```ts
// app.module.ts
@Module({
  imports: [
    KavoModule.forRootAsync({
      useFactory: () => ({
        infrastructure: createInfrastructure(dataSource),
        app: (request): KavoAppContext => {
          const user = request.user as { id?: string; roles?: string[] } | undefined;
          return { userId: user?.id, roles: user?.roles };
        },
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
```

`@kavo/next` has no `app` option, so `context.app` is `{}` on every Next request and a per-caller `policy` or `filter.apply` sees no caller. Authenticate each exported handler yourself, as in the wrapper under [Body size](#body-size), and keep entities whose rules depend on the caller off Next until they don't.

### Validation

A class `schema.input` narrows which keys a write accepts, but its `class-validator` rules (`@IsEmail`, `@MaxLength`) run only when the host registers Nest's `ValidationPipe`, and only on REST (#522). Register it app-wide, as `examples/nest-typeorm` does:

```ts
providers: [{ provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) }],
```

The pipe validates whatever class Kavo hands it, including the class the `{ fields }` shorthand synthesizes, which carries no `class-validator` decorators; with `whitelist: true`, use decorated DTO classes rather than the shorthand, and test a write end to end.

A validator-shaped `schema.input` (any object with `safeParse`, such as a Zod schema) runs inside the engine instead, so it applies on REST, Next, GraphQL and MCP alike. It doesn't set the writable key set: keys are still narrowed to the default write shape, or to an entity-scope class or `{ fields }` if there is one. To narrow further, put `{ fields }` in `schema.input.<slot>` and the validator in `operations.<id>.schema` ([Schemas](/core/schemas)). On `@kavo/prisma`, validate every scalar column as a scalar this way (#519).

### Body size

Nest's Express adapter caps JSON bodies at 100 KB by default. Set the limit explicitly, for the urlencoded parser too, so a later adapter change doesn't lift it silently:

```ts
// main.ts
const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.useBodyParser("json", { limit: "100kb" });
app.useBodyParser("urlencoded", { limit: "100kb", extended: false });
```

On the Fastify adapter the default is 1 MiB; pass `new FastifyAdapter({ bodyLimit })` instead. The zero-config MCP route needs Express either way.

Next's App Router route handlers have no body limit of their own, and `experimental.middlewareClientMaxBodySize` (Next 15) only truncates what middleware buffers; it doesn't refuse the request. Count the bytes before Kavo reads them, and authenticate in the same wrapper so every export is covered:

```ts
// app/api/[...kavo]/route.ts
import { createKavoHandler, type KavoRouteHandler } from "@kavo/next";
import { users, projects } from "../../../kavo";
import { verifySession } from "../../../auth"; // yours: returns the caller or null

const kavo = createKavoHandler({ users, projects });
const MAX_BODY_BYTES = 100 * 1024;
const tooLarge = () => new Response(null, { status: 413 });

async function readLimited(request: Request): Promise<Blob | null | "too-large"> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) {
    return "too-large";
  }
  const reader = request.body?.getReader();
  if (reader === undefined) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}

function guarded(handler: KavoRouteHandler): KavoRouteHandler {
  return async (request, context) => {
    if ((await verifySession(request)) === null) {
      return new Response(null, { status: 401 });
    }
    const body = await readLimited(request);
    if (body === "too-large") {
      return tooLarge();
    }
    const rebuilt = new Request(request.url, { method: request.method, headers: request.headers, body });
    return handler(rebuilt, context);
  };
}

export const GET = guarded(kavo.GET);
export const POST = guarded(kavo.POST);
export const PUT = guarded(kavo.PUT);
export const PATCH = guarded(kavo.PATCH);
export const DELETE = guarded(kavo.DELETE);
```

Cap bodies at the platform or reverse proxy as well (`client_max_body_size` in nginx, the request-size limit on your host), since that refuses them before your process reads a byte.

### Rate limiting and request cost

Kavo's per-request caps (`filter.limits.*`, `include.limits.*`, `pagination.maxLimit`) bound part of what one request costs, not how many arrive, and some inputs are not capped yet (#513). On Nest, `@nestjs/throttler` registered as an `APP_GUARD` covers every route, the zero-config MCP and GraphQL routes included. On Next, rate-limit in `middleware.ts` or at the edge.

The zero-config GraphQL route runs every document with no depth, alias or operation-count limit, and introspection on, so one throttled request can carry many aliased `findMany` calls. Cap its body size, and if that isn't enough, mount your own controller extending `BaseKavoGraphQLController` with the validation rules you need.

### CORS, CSRF and TLS

Kavo sets no CORS headers. Allow only your origins: `app.enableCors({ origin: ["https://app.example.com"] })` on Nest, response headers in `middleware.ts` on Next.

CORS does not stop a cross-site form post. `@kavo/next` parses any request body as JSON whatever its `Content-Type`, and Nest's urlencoded parser is on by default, so a cookie-authenticated app needs `SameSite` cookies or a CSRF token, or should refuse a write whose `Content-Type` is not `application/json` (in `guarded` above, or in middleware).

Terminate TLS at the platform or load balancer.

### Logging

A REST rejection is a problem-details body with a stable `code`. Log the 4xx codes: a burst of `KAVO_QUERY_INVALID_FIELD` or `KAVO_FORBIDDEN` from one client often means it is probing the allowlists or the policy. On Nest, an interceptor sees the exception before `KavoExceptionFilter` renders it:

```ts
import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import { KavoException } from "@kavo/core";
import { catchError, throwError } from "rxjs";

@Injectable()
export class RejectionLogger implements NestInterceptor {
  private readonly logger = new Logger("Kavo");

  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      catchError((error: unknown) => {
        const request = context.switchToHttp().getRequest<{ method: string; route?: { path?: string } }>();
        const code =
          error instanceof KavoException ? error.code : error instanceof HttpException ? error.getStatus() : undefined;
        if (code !== undefined) {
          // Method and route pattern only: the query string carries filter values.
          this.logger.warn(`${code} ${request.method} ${request.route?.path ?? ""}`);
        }
        return throwError(() => error);
      }),
    );
  }
}

// app.module.ts
providers: [{ provide: APP_INTERCEPTOR, useClass: RejectionLogger }],
```

A guard's `403` or a body-parser `413` happens before interceptors run; log those from the guard or the access log. MCP and GraphQL answer a Kavo error inside a `200`, as an `isError` tool result or an `errors` array, so log those from their responses. On Next, read `code` off the body of any 4xx the handler returns.

## Routes that ship unguarded

Three routes live outside every `@Kavo` controller, so a guard on an entity's REST controller never reaches them.

| Route                                             | What it exposes                                             | How to guard it                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KavoModule`'s `mcp` option (`POST /mcp`)         | Every entity's full MCP toolset, writes included            | `mcp: { guards: [McpAuthGuard] }`, or an `APP_GUARD`. See [Guarding the zero-config routes](/guides/configuration/module-setup#guarding-the-zero-config-routes). |
| `KavoModule`'s `graphql` option (`POST /graphql`) | Every registered query and mutation                         | `graphql: { guards: [GraphQLAuthGuard] }`, or an `APP_GUARD`.                                                                                                    |
| `@kavo/sse`'s `handleRequest`                     | Every realtime event on the channels a client subscribes to | A guard or middleware on the route you mount it on, and a connection cap at the proxy (#524). See [Realtime events](/features/realtime-events).                  |

A guard decides whether a request gets in. It does not tell the engine who is calling: `context.app` is `{}` over MCP and GraphQL, guarded or not. `policy`, `filter.apply` and `set` still run there, but a rule that reads the caller (an `owner()` policy, a tenant scope) sees none. Keep an entity whose rules depend on the caller off those surfaces, or write its rules to deny when `context.app` is empty.

A hand-written controller method, an `@Override` or a method whose name matches an operation id, runs only what it calls. One that never calls the service skips `policy`, `filter.apply` and `set`. One that calls it without `{ app: boundKavoAppContext(this, request) }` runs them with no caller. Authorization written in the method itself protects REST only. See [What an override inherits](/reference/decorators#what-an-override-inherits-and-what-it-doesn-t) for the full table.

## Risky configuration

The first two rows are the defaults. The rest widen what a client can reach, so set each one deliberately and not because a sample had it.

| Setting                                                                                                                                      | What it exposes                                                                                                                                                                                       | Default                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `filter.fields`, `sort.fields`, `select.fields` unset, or `{ exclude }`                                                                      | Every own column is filterable, sortable and returned, including columns added to the entity later                                                                                                    | unset: every column                                 |
| No class or `{ fields }` `schema.input`                                                                                                      | Every non-generated, non-key column is writable, and every to-one relation is writable by id, so a client can reassign an owner or tenant foreign key                                                 | unset: every column                                 |
| `delete.allowDeletedReads: true`                                                                                                             | Any client that reaches the read can see soft-deleted rows with `?withDeleted` or `?onlyDeleted`. Restrict who in `policy` (below), or open it per read with `operations.<id>`.                       | `false`: the flags are a `400`                      |
| `delete: { strategy: "soft" }` or `delete.field`                                                                                             | Also switches on `restoreOne` when `operations` is not declared                                                                                                                                       | `restoreOne` on with it; `purgeOne` off until named |
| `include.fields` naming a relation                                                                                                           | That relation's rows. The target's `filter.apply` is not applied to them (#515), and a target that never went through `createCrud` serves every column. Don't make a tenant-scoped entity includable. | no relation includable                              |
| `relations.<name>.write`                                                                                                                     | Association writes on a to-many relation, which rewrite the related rows' foreign keys                                                                                                                | off                                                 |
| `errors.exposeInternals: true` (Nest REST, and MCP tool results per entity), `createKavoHandler(entities, { exposeInternals: true })` (Next) | Driver-level error detail, a validation issue's raw context, and an unexpected error's message in responses                                                                                           | `false`                                             |
| Raising `filter.limits.*`                                                                                                                    | Deeper, wider filters, so more expensive queries per request                                                                                                                                          | depth `3`, `100` `in` values, `200`-char LIKE       |
| Raising `include.limits.*`                                                                                                                   | Larger relation trees per read                                                                                                                                                                        | depth `2`, `10` nodes                               |
| Raising `pagination.maxLimit`                                                                                                                | More rows per page                                                                                                                                                                                    | `100`                                               |
| `pagination.strategy: "none"`                                                                                                                | `findMany` returns the whole match set, however large                                                                                                                                                 | `"offset"`                                          |
| `createKavoHandler(kavo)` with the root instance                                                                                             | A route for every entity that root ever passed through `createCrud`, including ones created only as include targets. Pass an explicit `{ users, projects }` map instead.                              | —                                                   |
| A write operation with no `policy`                                                                                                           | Anyone who reaches the route can call it                                                                                                                                                              | no policy                                           |
| `filter.apply` with no matching `set`                                                                                                        | `filter.apply` scopes reads and id-addressed writes, but a `POST` or an update body can still name another tenant. `set` forces the column on every write.                                            | no `set`                                            |
| `mcp: true` or `graphql: true` with no guard                                                                                                 | See [Routes that ship unguarded](#routes-that-ship-unguarded)                                                                                                                                         | not mounted                                         |

Once an entity allows deleted reads, restrict who may use the flags in its policy. An entity `policy` replaces a global one, and this rule passes every write (`context.query` is `null` on writes), so AND it with the rule you already have:

```ts
const trashForAdmins: Policy<Book> = ({ context }) =>
  !(context.query?.withDeleted || context.query?.onlyDeleted) || (context.app.roles ?? []).includes("admin");

@Kavo(Book, {
  delete: { allowDeletedReads: true },
  policy: (args) => trashForAdmins(args) && ownerOnly(args),
})
```

`findOne` checks the policy after fetching the row, so `GET /books/:id?withDeleted=true` answers `403` for a soft-deleted id and `404` for one that never existed. If that difference matters, deny the flags in a guard instead.

## Known limitations

Each of these is a public issue. Until it closes, the mitigation beside it is yours.

| Issue | Gap                                                                                                    | Mitigation                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #513  | Cursor and `since` tokens, search terms, offsets, filter breadth and array bodies have no size cap yet | Cap URL length and body size at the proxy                                                                                                                   |
| #515  | Includes don't carry the target entity's `filter.apply`                                                | Don't make a tenant-scoped entity includable                                                                                                                |
| #516  | Association-by-id targets are checked for existence, not against the target's `filter.apply`           | Keep to-one relations to tenant-scoped entities out of `schema.input` fields, or force them with `set`                                                      |
| #518  | Some adapter errors echo driver detail                                                                 | Keep `exposeInternals` off, and watch the logs                                                                                                              |
| #519  | `@kavo/prisma` doesn't reject Prisma update-operation objects in a write body                          | Validate scalar columns with a validator-shaped `schema.input`, which runs on every surface                                                                 |
| #520  | `%` and `_` in a search term act as wildcards on `@kavo/prisma` and `@kavo/mikroorm`                   | Leave `search` off there, or accept broader matches                                                                                                         |
| #522  | GraphQL and MCP writes skip `ValidationPipe` rules                                                     | Use a validator-shaped `schema.input`, or keep such entities off GraphQL and MCP                                                                            |
| #524  | `@kavo/sse` has no per-subscriber authorization or connection cap                                      | Guard the route, cap connections at the proxy, and narrow payloads with `subscribableFields`                                                                |
| #531  | A service-only operation (`meta.routes.enabled: false`) still gets a GraphQL field                     | Don't pass `registerKavoGraphQLTypes` the input type or flag for that write, and don't register GraphQL types at all for an entity with a service-only read |

## Production checklist

```md
- [ ] Every route runs behind authentication: an `APP_GUARD` on Nest, a wrapper around every export on Next.
- [ ] `app` builds a plain `KavoAppContext` from the authenticated request, with every field optional.
- [ ] Entities whose rules read the caller are not mounted on Next, MCP or GraphQL.
- [ ] Every entity names `filter.fields`, `sort.fields`, `select.fields` and its `schema.input` fields explicitly, with no `{ exclude }` on entities with sensitive or ownership columns.
- [ ] Nest registers `ValidationPipe`, or entities use a validator-shaped `schema.input`.
- [ ] Every write operation has a `policy`, and every multi-tenant entity has both `filter.apply` and a `set` on the tenant column.
- [ ] No tenant-scoped entity is includable, and no write shape carries a to-one relation to one.
- [ ] `mcp` and `graphql` are unset, or carry `guards`, or an `APP_GUARD` covers them.
- [ ] `@kavo/sse`'s route sits behind a guard, only entities whose every row may reach every subscriber enable `realtime`, and `subscribableFields` narrows the payload.
- [ ] `exposeInternals` is off on every host.
- [ ] `delete.allowDeletedReads` is on only where clients should see soft-deleted rows, with a `policy` restricting who, and `restoreOne` and `purgeOne` are on only where they're meant to be public API.
- [ ] `pagination.maxLimit` and the `filter` and `include` limits are at or below the defaults unless raised on purpose.
- [ ] Next's `createKavoHandler` gets an explicit entity map.
- [ ] JSON and urlencoded bodies are capped in the app and at the proxy, and URL length at the proxy.
- [ ] A rate limiter covers every Kavo route.
- [ ] CORS names your origins, cookie-authenticated writes are CSRF-protected, and TLS terminates in front of the app.
- [ ] `KAVO_*` 4xx codes are logged.
```

To report a vulnerability in Kavo itself, use the private route in [`SECURITY.md`](https://github.com/kavo-labs/kavo/blob/main/SECURITY.md#reporting-a-vulnerability).
