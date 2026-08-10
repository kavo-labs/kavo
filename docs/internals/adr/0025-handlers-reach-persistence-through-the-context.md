# ADR-0025 — Handlers reach persistence through the request context

**Status:** accepted

## Context

`OperationHandler.execute(input, context)` is the whole contract a handler
gets. The eight built-in handlers never needed more, because `createCrud`
builds them where the adapter already exists and they close over it. A
handler supplied through `operations.<id>.handler` is built by the caller,
and under `@Kavo` that is class-decoration time (ADR-0012): the config
literal is evaluated when the controller class is defined, and the
infrastructure a `KavoModule.forRootAsync` factory produces does not exist
yet.

So the two operations issue #145 was written for, `markPaidOne` and
`publishOne`, could not be written in the wiring the integration docs
recommend. Both load a row and write a field, and nothing in scope could
load it (issue #152).

The three workarounds each gave up something the feature exists to provide.
Building a module-scope `DataSource` gives up `forRootAsync`. Casting
`context.transaction.handle` to a TypeORM `QueryRunner` is untyped, `null`
outside a transaction, and couples the handler to one ORM, which is the
coupling `@kavo/core` exists to prevent. Writing the route by hand gives up
the registry identity, per-operation config, generated OpenAPI and
automatic principal that a registry entry buys, which is what issue #145
set out to stop people doing.

Core cannot reach for anything to fix this (ADR-0001, ADR-0005). It does
not have to: `RepositoryAdapter` is core's own contract, so handing one to
a handler is core handing back a shape core declared, not a dependency on
whatever implements it.

## Decision

`KavoContext.repository` is the entity's `RepositoryAdapter`, and it is how
every handler reaches persistence, built-in and custom alike.

- It is **required** on the context, and present for every operation. Both
  halves are there on a read as well as a write: `OperationKind` decides
  the request's shape (query resolution, `@Query` rather than `@Body`),
  never what a handler is permitted to do.
- A handler passes its own context back to the adapter
  (`context.repository.patch(id, data, context)`). That is what makes the
  call inherit the active transaction, the resolved soft-delete strategy
  and the per-call settings view, and it is how the built-in handlers have
  always called the adapter.
- It is the entity's own adapter and nothing wider. A cross-entity write
  stays the application's to make, through whatever it uses to reach the
  other entity.
- `KavoEngineDependencies.repository` replaces `reader`. The engine already
  held the whole adapter under that name (the `If-Match` pre-read, ADR-0020);
  it now hands it out as well as reading through it.
- `builtInHandlers(adapter?)` takes its adapter optionally, and `createCrud`
  passes none, so the built-ins resolve theirs from the request like
  everything else. Passing one still means exactly one thing: run these
  behaviors against _that_ adapter rather than the entity's own. It is also
  what makes `withListMeta(builtInHandlers<Book>()("findMany"), …)` usable
  inside a `@Kavo` config, which had the same decoration-time problem.

## Consequences

- One rule for every handler. The asymmetry that made a config-supplied
  handler second class is gone, and a custom handler is written the way the
  built-in ones are.
- `KavoContext` is wider, and every context constructed anywhere has to
  carry an adapter. Both construction sites are the engine's.
- A `kind: "read"` handler can write. Refusing that would need a second
  context shape per kind, to enforce a rule no consumer asked for.
- **Not taken: resolving a handler through the host's container**, so that
  `operations.markPaidOne.handler` could name a class Nest instantiates.
  That reaches injected application services, which this decision does not,
  and nothing here forecloses it: a container-resolved handler would still
  be handed `context.repository`. It is left out because it needs a
  resolution seam in core _and_ a container lookup whose timing is awkward
  under the very wiring this ADR is about. A global module's provider
  factory runs before the app's own providers are instantiated, so the
  lookup has to be deferred to the first call, which moves a misconfigured
  handler out of bootstrap and into the first request. That is a separable
  decision with its own costs, and bundling it here would have settled it
  by momentum rather than on its merits.
- **Not taken: making `handler` a factory** that `createCrud` calls with the
  entity's adapter at bootstrap. It would keep the context narrow, at the
  price of a new union in the config type and a second construction moment
  to explain, and it would reach only handlers written as factories. A
  decorator config naturally holds an object literal, which is what the
  docs show and what the motivating examples are.
