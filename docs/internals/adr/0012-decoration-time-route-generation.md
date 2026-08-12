# ADR-0012 — Decoration-time route generation in @kavo/nest

**Status:** accepted

## Context

Nest's router maps controller methods during `app.init()`, **before** any
module lifecycle hook (`onModuleInit`) runs. Routes must therefore exist
on the controller prototype — with Nest's own route metadata — by the
time the controller class is scanned. But the operation registry that
drives generation (ADR-0006) is naturally a bootstrap product.

## Decision

`@Kavo(Entity, config)` generates routes **at class-decoration time**:
it builds the operation registry from the entity config with the same
`createOperationRegistry` the engine uses (in inspection mode — handlers
unbound), defines one method per enabled entry on the prototype, and
applies Nest's real decorators programmatically (`Post(path)(proto,
name, descriptor)`, `Param("id")(…)`, `HttpCode(…)`). The service
instance arrives later, but not through DI: `KavoModule`'s
`KavoBinder` (`onModuleInit`, via `@nestjs/core`'s
`DiscoveryService`) finds every `@Kavo`-decorated controller already in
the app's module graph — however it got there, an ordinary Nest
`controllers:` array is enough — and assigns
`kavo.createCrud(entity, config)` directly onto
`this[KAVO_SERVICE_PROPERTY]`, which the generated methods read at
request time. `onModuleInit` runs after Nest's own controller
instantiation but well before the first request, which is the only
timing the generated methods need. `forFeature` still exists, now only
for the narrower case of a class that constructor-injects
`getKavoServiceToken(Entity)` itself — that resolution _does_ need a
real DI provider, since it happens at instantiation time. Called with no
arguments, `forFeature()` provides that token for every `@Kavo`-decorated
class the process has seen so far (read from the same decoration-time
registry `KavoBinder`'s metadata lookups already rely on), so a normal
app states its controller list exactly once, in an ordinary `controllers:`
array.

## Consequences

- Works with Nest's normal controller scan — no custom router, no
  monkey-patching, and guards/interceptors/versioning/prefixes compose
  exactly as with hand-written methods.
- The entity config is stated on the controller (`@Kavo(Entity, config)`)
  and read back from the same decorator metadata by both route
  generation and `KavoBinder`'s service bootstrap — one source of
  truth; the two can't drift.
- Manual-method-wins is a one-line `hasOwnProperty` check at decoration
  time.
- Limitation: decoration time has no ORM metadata, so Swagger docs can only
  name an entity's allowlisted `filter`/`sort`/`fields` params when the
  allowlist is an explicit array — which resolves identically with or
  without metadata (issue #171); the unconfigured default and an
  `{ exclude }` selector both need metadata to resolve and keep the
  generic, unrestricted description (doc 10 §4).
