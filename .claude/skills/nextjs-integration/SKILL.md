---
name: nextjs-integration
description: How to wire @kavo/next into an app's Next.js App Router — createKavoHandler, entity wiring, custom operations, and OpenAPI export. Use when a user is integrating Kavo into their own Next.js app, not when changing @kavo/next's own source (see docs/integrations/frameworks/nextjs.md, which this mirrors).
---

# Integrating `@kavo/next`

`@kavo/next` binds Kavo to the Next.js App Router: `createKavoHandler` turns
one or more `createCrud` results into `GET`/`POST`/`PUT`/`PATCH`/`DELETE`
route-handler exports for a catch-all route. There's no decorator, no DI
container, and no dependency on `@kavo/nest` — App Router route handlers are
plain functions over the Fetch API's `Request`/`Response`.

## The three pieces every integration needs

1. **Wire entities where the app's Kavo setup lives** — call `createCrud`
   directly, once per entity, same as with any other framework binding:

   ```ts
   // kavo.ts
   import { createKavo } from "@kavo/core";
   import { createInfrastructure } from "@kavo/typeorm";
   import { dataSource } from "./data-source";
   import { User } from "./user.entity";

   const kavo = createKavo({ infrastructure: createInfrastructure(dataSource) });
   export const users = kavo.createCrud(User, { filter: { fields: ["id", "email"] } });
   ```

   Any ORM adapter works the same way here as with `@kavo/nest` —
   `@kavo/typeorm`, `@kavo/prisma`, `@kavo/mongoose`, `@kavo/mikroorm` all
   produce a plain `createCrud` result with nothing framework-specific.

2. **Mount the catch-all route** — one file, one call:

   ```ts
   // app/api/[...kavo]/route.ts
   import { createKavoHandler } from "@kavo/next";
   import { users, projects } from "../../../kavo";

   export const { GET, POST, PUT, PATCH, DELETE } = createKavoHandler({ users, projects });
   ```

   The first path segment resolves the entity by its key in this map
   (`users` → the `users` service); the rest resolves the operation by
   matching the request's method and remaining segments against that
   entity's own operation registry — the same registry `@kavo/nest`'s
   `@Kavo` decorator reads. An unknown entity key, or a method/segment
   combination no enabled operation resolves to, answers `404` — never
   `500`, never a bare `405` (see [ADR-0054](../../../docs/internals/adr/0054-next-resolves-routes-at-request-time.md)
   for why resolution happens at request time).

3. **Optionally export OpenAPI schemas** — `buildKavoSchemas` is the
   `@kavo/next` equivalent of `@kavo/nest`'s `registerKavoSchemas`, built
   without `@nestjs/swagger`:

   ```ts
   // app/api/openapi.json/route.ts
   import { buildKavoSchemas } from "@kavo/next";
   import { users, projects } from "../../../kavo";

   export function GET() {
     const { schemas } = buildKavoSchemas({ users, projects });
     return Response.json({ openapi: "3.1.0", info: { title: "My API", version: "1.0.0" }, paths: {}, components: { schemas } });
   }
   ```

   `paths` is left to the caller — `resolveRoute`/`matchRoute` are exported
   for a caller who wants a full `paths` document by walking
   `engine.registry.all()`.

## Custom operations

A custom operation (`operations.<id>` outside the standard eight) dispatches
exactly like the standard eight — same registry, same `meta.routes`
convention:

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

`POST /api/books/:id/mark-paid` reaches it through the same catch-all route.

## Overriding a generated route

There's no class to override here, unlike `@kavo/nest`'s manual-method-wins.
A caller who wants a genuinely custom implementation wins the way Next.js
already resolves any two routes that could match one request: add a sibling,
more specific route file. `app/api/books/[id]/mark-paid/route.ts` is matched
by Next.js before `[...kavo]` ever runs — no Kavo-side config needed.

## Things to check when something doesn't route or build

- **`next` is an optional peerDependency** — nothing in `@kavo/next` imports
  it at runtime; route handlers only need the Fetch API globals. Make sure
  `@kavo/core` plus the entity's ORM adapter peer are installed alongside it.
- **Next.js 15+ only** — `params` in a route handler's second argument is
  always a `Promise` (the App Router route-handler type validator requires
  this shape under `next build`). Next.js 14 handed `params` synchronously;
  this binding doesn't support it.
- **Minifier-renamed marker classes** — a production build's minifier can
  rename JS classes, which breaks an ORM adapter's marker-class name matching
  (`@kavo/prisma`'s, in particular) unless each marker's runtime `.name` is
  pinned explicitly. See `examples/next-prisma/src/author.entity.ts` for the
  one-line fix.
- **Not yet supported**: bulk (`*Many`) operation dispatch through this
  binding (arrives once engine/registry support lands — it's a config change
  on the entity, not a `@kavo/next` change); SSE, GraphQL, and MCP glue for
  Next.js aren't part of this binding.

## Reference

`examples/next-prisma` is a full reference app: standard CRUD, a custom
operation, filtering/sorting/include, and the OpenAPI export route, wired
against `@kavo/prisma`. `docs/integrations/frameworks/nextjs.md` is the
canonical doc this skill mirrors — update both together if the binding's
behavior changes.
