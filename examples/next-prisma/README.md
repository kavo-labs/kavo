# next-prisma

A small Author/Book domain served over HTTP by the App Router equivalent of
the `nest-*` examples: `createKavoHandler(...)` → CRUD engine → `@kavo/prisma`
→ a real (SQLite) database, with filtering, sorting, a custom operation, and
an OpenAPI export route — no NestJS, no decorators, no DI container.

Where `examples/nest-*` wire `KavoModule.forRoot` + `@Kavo(Entity)` per
controller, this app has exactly one Kavo root instance
(`lib/kavo.ts`, the `app.module.ts` equivalent), one `<entity>.service.ts`
per entity under `entities/` that calls `kavo.createCrud`, and one catch-all
route file:

```bash
pnpm --filter @kavo/example-next-prisma run generate   # prisma generate + db push
pnpm --filter @kavo/example-next-prisma run dev
# → http://localhost:3000/api/authors
# → http://localhost:3000/api/books
# → http://localhost:3000/api/openapi.json
```

`DATABASE_URL` defaults to `file:./dev.db`.

## Try it

```
POST   /api/authors                {"name":"Ada","email":"ada@x.io"}
POST   /api/books                  {"title":"Draft","authorId":1}
GET    /api/books?filter[published][eq]=false&sort=-id
GET    /api/books?include=author
POST   /api/books/<id>/publish     # custom operation — dispatched by the same catch-all route
GET    /api/openapi.json           # components.schemas, buildKavoSchemas' output
```

## `app/api/[...kavo]/route.ts`

```ts
import { createKavoHandler } from "@kavo/next";
import { authors } from "../../../entities/author/author.service.js";
import { books } from "../../../entities/book/book.service.js";

export const { GET, POST, PUT, PATCH, DELETE } = createKavoHandler({ authors, books });
```

Every request's first path segment (`authors`/`books`) resolves the entity;
the rest resolves the operation through that entity's own operation
registry — the same one `@kavo/nest`'s `@Kavo` decorator would read for the
identical `createCrud` config. `publishOne`'s route
(`POST /books/:id/publish`) is a custom operation, dispatched exactly like
the standard eight — see `entities/book/book.service.ts`.

**The App Router equivalent of manual-method-wins:** `@kavo/nest` lets a
hand-written controller method with a matching name suppress a generated
route; there is no class here to override, so a caller who wants a
genuinely custom implementation instead wins by Next.js's own routing
rules — a sibling, more specific route file (e.g.
`app/api/books/[id]/publish/route.ts`) is matched by Next.js **before** the
`[...kavo]` catch-all ever runs, taking that path out of the catch-all's
reach entirely.

## What's different from the `nest-*` apps

No decorators, no `@Kavo` class, no `KavoModule`. `lib/kavo.ts` builds the
root Kavo instance; each `entities/<name>/<name>.service.ts` calls
`kavo.createCrud` and exports the resulting service; the two route files
(`[...kavo]/route.ts`, `openapi.json/route.ts`) import them.
Routes are resolved at request time against each entity's operation
registry rather than generated once at decoration time (there is no
decoration time in the App Router) — see `@kavo/next`'s own
`resolveRoute`/`matchRoute`, exported for exactly this kind of reuse.

The app consumes only public package APIs — if it ever needs a deep import,
that is an API-surface bug in the package, not the app.
