# 19 — Next.js Integration

`@kavo/next` (`packages/frameworks/next`) binds Kavo to the Next.js App
Router: `createKavoHandler` turns one or more `createCrud` results into
`GET`/`POST`/`PUT`/`PATCH`/`DELETE` route-handler exports for a catch-all
route (`app/api/[...kavo]/route.ts`). Unlike `@kavo/nest`, there is no
decorator, no DI container, and no dependency on `@kavo/nest` itself — App
Router route handlers are plain functions over the Fetch API's
`Request`/`Response`, and that is all this package builds on. `next` is an
optional peerDependency; nothing in `@kavo/next` imports it at runtime.

It is a `frameworks/*` package exactly as `@kavo/nest` is (ADR-0002's
boundary): it never imports an ORM adapter, and it never imports
`@kavo/nest` or any other framework package — infrastructure arrives
through a plain `createCrud` result, not DI.

## 1. Request-time dispatch, not decoration-time (ADR-0054)

`@kavo/nest`'s `@Kavo` decorator generates one static route per enabled
operation at class-definition time (doc 10) because that is the only
moment Nest's router scan can see the methods. The App Router has no
such scan and no decorator to hook — a route file exports a fixed set of
HTTP-method functions, so `createKavoHandler` walks each entity's
operation registry **at request time** instead: on every call, it resolves
the entity from the first path segment, then iterates `registry.all()`
looking for the first enabled descriptor whose resolved route matches the
request's method and remaining segments (`resolve-route.ts`,
`match-route.ts`). ADR-0054 covers why this design was chosen over trying
to synthesize static route files at build time.

`resolveRoute` is a direct port of `@kavo/nest`'s own `resolveRoute` — same
fallback order (explicit `meta.routes` → the array-mutation convention →
the standard-operation table → the custom-operation default `POST
/<operation id>`) — so the two bindings agree on where an unconfigured
entity's routes live for the same `createCrud` config. An unknown entity
key, or a method/segment combination no enabled operation resolves to,
answers `404` — never `500` and never a bare `405`, since a route that was
never configured for this entity is indistinguishable, from the outside,
from one that does not exist.

## 2. Wiring entities: no module, no binder

There is no `KavoModule` and no discovery pass. A caller calls `createCrud`
directly, once per entity, and passes the resulting services to
`createKavoHandler` — either as an explicit `Record<string,
DefaultKavoService>` map, or as the root `KavoInstance` itself, in which
case `createKavoHandler` builds the map from every `createCrud` call that
instance has seen (`entitiesFromInstance`, ADR-0054's amendment, issue
#457). The URL key in the auto-discovered form is the entity's own
`entityName` with only its first character lowercased — no pluralization,
since guessing an irregular plural (`Category` → `Categories`) would just
relocate the surprise. Both forms dispatch identically once the map is
built; only how the map is obtained differs. `createCrud` remains the sole
way an entity enters the system either way (`kavo.ts`'s composition root).

## 3. Request/response translation

Everything between the Fetch API and the engine is this package's own
seam, since there is no Nest pipe/interceptor/exception-filter chain to
lean on:

- **Query strings** (`query-params.ts`) parse into the same `WireQuery`
  marker `@kavo/nest` wraps flat bracket keys in, so both bindings run the
  identical parse-and-coerce pipeline on read operations.
- **Preconditions** (`preconditions.ts`) read `If-Match`/`If-None-Match`
  into the same `RequestPreconditions` shape the engine's ETag stage
  expects (ADR-0020) — `@kavo/nest`'s `KavoResponseInterceptor` has no
  equivalent here, so this package reads the headers itself.
- **The response envelope** (`kavo-response.ts`) turns a `KavoResponse`
  into a Fetch `Response`, applying the resolved route's success status.
- **Errors** (`error-response.ts`) map a thrown `KavoException` to a
  `problem+json` body the same shape `@kavo/nest`'s exception filter
  produces (ADR-0009); an uncaught non-Kavo error becomes
  `KAVO_UNEXPECTED_ERROR`/500, exactly as it would through Nest.
- **A malformed JSON body** is this package's own concern: with no
  body-parser middleware layer in front of it, `readBody`'s `JSON.parse`
  failure is caught explicitly and answered as `KAVO_NEXT_INVALID_BODY`/400
  ahead of the engine ever seeing the request. `restoreOne`/`purgeOne`
  (`BODYLESS_WRITES`, mirroring `@kavo/nest`'s own set) are never parsed as
  JSON even when a body is present.

## 4. Custom operations and the App Router equivalent of manual-method-wins

A custom operation dispatches through the same registry walk as the
standard eight, addressed by its configured `meta.routes` segment — no
special case. There is no class here for a hand-written method to
override, so `@kavo/nest`'s manual-method-wins convention (doc 10) has no
direct analogue; instead, a caller who wants a genuinely custom
implementation wins the way Next.js already resolves two routes that could
match the same request — a sibling, more specific route file
(`app/api/books/[id]/mark-paid/route.ts`) is matched before the
`[...kavo]` catch-all ever runs, taking that path out of the catch-all's
reach with no Kavo-side configuration.

## 5. OpenAPI without `@nestjs/swagger`

`buildKavoSchemas` (`openapi/build-kavo-schemas.ts`) is this package's
equivalent of `@kavo/nest`'s `registerKavoSchemas` — the identical
`components.schemas` naming scheme (`<Entity>Create`/`Update`/`Patch`/
`Item`/`List`, `<Entity>ListItem`/`ListMeta`, `<Entity>Pagination`/
`Include`/`Sort`, `<Entity>Filter`/`Query`, `<Entity>ValidationError`, plus
the shared `KavoProblemDetails`/`KavoProblemDetailError`) — built entirely
from `EntityMetadata` and the entity's resolved config, with no
decorator/reflection story to introspect a configured schema class's runtime
shape. `resolveRoute`/`matchRoute` are exported alongside it so a caller
who wants a full `paths` document can walk `engine.registry.all()` the
same way `buildKavoSchemas` does internally.

## 6. What's out of scope here

- Bulk (`*Many`) operations dispatch once the underlying engine/registry
  support lands (issue #137) — this package hardcodes no fixed operation
  list, so nothing here needs to change when it does.
- SSE, GraphQL, and MCP glue for the App Router are not part of this
  binding; each is its own protocol-integration question, the same way
  they are orthogonal to `@kavo/nest`.

See [Next.js](/integrations/frameworks/nextjs) for the adopter-facing guide
this document mirrors, and
[examples/next-prisma](https://github.com/kavo-labs/kavo/tree/main/examples/next-prisma)
for a full reference app.
