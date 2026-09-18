# Next.js

`@kavo/next` binds Kavo to the Next.js App Router: `createKavoHandler` turns one or more `createCrud` results into `GET`/`POST`/`PUT`/`PATCH`/`DELETE` route-handler exports for a catch-all route, dispatching through each entity's operation registry at request time. There's no decorator, no DI container, and no dependency on `@kavo/nest` — App Router route handlers are plain functions over the Fetch API's `Request`/`Response`, and that's all this package builds on.

```ts
// app/api/[...kavo]/route.ts
import { createKavoHandler } from "@kavo/next";
import { users, projects } from "../../../kavo";

export const { GET, POST, PUT, PATCH, DELETE } = createKavoHandler({ users, projects });
```

The first path segment resolves the entity by its registered key (`users` → the `users` service); the rest resolves the operation by matching the request's method and remaining segments against that entity's own operation registry — the same registry `@kavo/nest`'s `@Kavo` decorator reads to generate routes. An unknown entity key, or a method/segment combination no enabled operation resolves to, answers `404`, never `500` and never a bare `405`. See [ADR-0054](/internals/adr/0054-next-resolves-routes-at-request-time) for why this resolves at request time rather than once at load, the way `@Kavo`'s decoration-time route generation does.

## Wiring entities

There's no `KavoModule`, no `app.module.ts`. Call `createCrud` directly, once per entity, wherever your app's wiring lives:

```ts
// kavo.ts
import { createKavo } from "@kavo/core";
import { createInfrastructure } from "@kavo/typeorm";
import { dataSource } from "./data-source";
import { User } from "./user.entity";
import { Project } from "./project.entity";

const kavo = createKavo({ infrastructure: createInfrastructure(dataSource) });

export const users = kavo.createCrud(User, { filter: { fields: ["id", "email"] } });
export const projects = kavo.createCrud(Project);
```

Any ORM adapter works the same way here as it does with `@kavo/nest` — `@kavo/typeorm`, `@kavo/prisma`, `@kavo/mongoose`, `@kavo/mikroorm` all produce a plain `createCrud` result with nothing framework-specific about it.

## Auto-discovering entities from the root

Re-listing every entity in `createKavoHandler({ users, projects, ... })` is easy to forget one of. `createKavoHandler` also accepts the root `KavoInstance` directly and builds the entity-key map itself from every `createCrud` call made against it:

```ts
// app/api/[...kavo]/route.ts
import { createKavoHandler } from "@kavo/next";
import { kavo } from "../../../kavo";

export const { GET, POST, PUT, PATCH, DELETE } = createKavoHandler(kavo);
```

The URL key is derived from each entity's `entityName` with only its first character lowercased — `User` → `user`, `Project` → `project` — and nothing else; there's no pluralization, since English plurals are irregular enough (`Category` → `Categories`) that guessing one would just move the surprise rather than remove it. If you want a different key (`users` instead of `user`, or a name that doesn't match `entityName` at all), pass the explicit `Record<string, DefaultKavoService>` map instead — both forms dispatch identically, and the explicit form keeps working exactly as it did before. See [ADR-0054](/internals/adr/0054-next-resolves-routes-at-request-time)'s amendment for the full rationale.

## Custom operations

A [custom operation](/core/custom-operations) dispatches exactly like the standard eight — same registry, same `meta.routes` convention:

```ts
export const books = createCrud(Book, {
  operations: {
    markPaidOne: {
      handler: {/* ... */},
      meta: { routes: { method: "POST", path: ":id/mark-paid" } },
    },
  },
});
```

`POST /api/books/:id/mark-paid` reaches it through the same catch-all route `createKavoHandler` returned.

## The App Router equivalent of manual-method-wins

`@kavo/nest` lets a hand-written controller method whose name matches an operation id suppress the generated route. There's no class here to override, so a caller who wants a genuinely custom implementation wins the same way Next.js already resolves any two routes that could match one request: a sibling, more specific route file. `app/api/books/[id]/mark-paid/route.ts` is matched by Next.js before the `[...kavo]` catch-all ever runs, taking that path out of the catch-all's reach entirely — no config on the Kavo side needed.

## OpenAPI schema export

`buildKavoSchemas` is the `@kavo/next` equivalent of `@kavo/nest`'s `registerKavoSchemas` — the same `components.schemas` naming scheme (`<Entity>Create`/`Update`/`Patch`/`Item`/`List`, `<Entity>ListItem`/`ListMeta`, `<Entity>Pagination`/`Include`/`Sort`, `<Entity>Filter`/`Query`, `<Entity>ValidationError`, plus the shared `KavoProblemDetails`/`KavoProblemDetailError`), built without `@nestjs/swagger`:

```ts
// app/api/openapi.json/route.ts
import { buildKavoSchemas } from "@kavo/next";
import { users, projects } from "../../../kavo";

export function GET() {
  const { schemas } = buildKavoSchemas({ users, projects });
  return Response.json({
    openapi: "3.1.0",
    info: { title: "My API", version: "1.0.0" },
    paths: {},
    components: { schemas },
  });
}
```

Every shape is derived from `EntityMetadata` and the entity's resolved config alone — there's no decorator/reflection story to introspect a configured `schema.input.create`/`item`/… class's actual field shape the way `@kavo/nest`'s Swagger integration does, so what's built here is the entity's own derived shape (columns, allowlists, pagination strategy), the same fallback `@kavo/nest` itself falls back to when no DTO is registered. `paths` is left to the caller: `resolveRoute`/`matchRoute` are exported so a caller who wants a full `paths` document can walk `engine.registry.all()` the same way `buildKavoSchemas` does and reuse the identical route shapes.

## Installing it

`next` is an optional peerDependency — nothing in `@kavo/next` imports it at runtime, since route handlers only need the Fetch API's global `Request`/`Response`.

::: code-group

```bash [pnpm]
pnpm add @kavo/core @kavo/next
```

```bash [npm]
npm install @kavo/core @kavo/next
```

```bash [yarn]
yarn add @kavo/core @kavo/next
```

```bash [bun]
bun add @kavo/core @kavo/next
```

:::

Add whichever ORM adapter your app uses alongside it, the same as with `@kavo/nest`. See [Peer dependencies](/reference/peer-dependencies) for the full version table.

## What's not covered yet

- Bulk (`*Many`) operations dispatch once the underlying engine/registry support lands; the routing logic doesn't hardcode a fixed operation list, so this is a config change on the entity, not a `@kavo/next` change, once it arrives.
- SSE, GraphQL, and MCP glue for Next.js aren't part of this binding — each is its own protocol-integration question.
- A production build's minifier can rename JS classes, which breaks an ORM adapter's marker-class name matching (`@kavo/prisma`'s, for instance) unless each marker's runtime `.name` is pinned explicitly — see `examples/next-prisma/entities/author/author.entity.ts` for the one-line fix.

See [examples/next-prisma](https://github.com/kavo-labs/kavo/tree/main/examples/next-prisma) for a full reference app: standard CRUD, a custom operation, filtering/sorting/include, and the OpenAPI export route, wired against `@kavo/prisma`.
