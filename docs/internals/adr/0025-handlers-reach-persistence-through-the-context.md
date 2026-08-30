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
automatic app context that a registry entry buys, which is what issue #145
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
  other entity. The one place that promise bends is an included relation
  target's computed-field resolver, which is handed the root request's
  context and so the root entity's adapter (see Consequences).
- The member is named `repository` rather than `adapter`, which is what
  every infrastructure-facing surface calls the same object
  (`KavoRuntime.adapter`, `infrastructure.adapterFor`,
  `builtInHandlers(adapter)`). The split is by audience: those are wiring
  seams an integrator fills, this is the handle application code reads and
  writes through, and `repository` is the noun that code already uses.
  CLAUDE.md's Conventions section records the rule so the next member does
  not have to guess.
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
- **A computed-field resolver on an included relation target is now handed
  a live writer for the wrong entity.** It receives the root request's
  context (ADR-0019), so serving `GET /posts/1?include=author` gives an
  `Author` resolver a `context.repository` typed for `Author` that holds
  Post's adapter. The mistyping is not new, `config` and `query` were
  already the root's, but those are inert and this one acts. The rule
  stated on `ComputedFieldDescriptor.resolve` is that a resolver does not
  reach for the repository at all: it is synchronous, so any adapter call
  is an unawaited promise, and one per row is the N+1 that stage exists to
  avoid.
- **A custom operation's write emits no realtime event.**
  `REALTIME_EVENT_BY_OPERATION` is keyed by `StandardOperationId`, so
  `markPaidOne` setting `paidAt` through `context.repository.patch`
  notifies no subscriber, while `PATCH /orders/7` on the same column does.
  Doc 18 already said a custom operation never emits; before this decision
  that sentence covered a case that could not arise, because a
  config-supplied handler could not write through the framework at all.
  Widening the realtime vocabulary to custom ids is its own decision
  (which event id would `markPaidOne` publish?) and is not taken here.
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
