# ADR-0034 — `when()`'s predicate takes a single object argument

**Status:** superseded by [ADR-0037](/internals/adr/0037-policy-collapses-to-a-single-predicate) —
`when()` and `PolicyNode` are gone, but the single-object-argument shape this
ADR settled on (`{ context, entity, resource, operation, params }`) is
exactly `PolicyArgs`, the argument a policy function is now called with
directly. Kept for history. (While it stood, this amended
[ADR-0032](/internals/adr/0032-policy-authorization-dsl)'s "The node types" section.)

## Context

ADR-0032 shipped `when(predicate)` with `predicate: (context: KavoContext<Entity>, entity?: Entity) => boolean | Promise<boolean>` — two positional
parameters, the same shape a request handler is called with. In practice a
predicate reaches for two things `context` already carries but not at the
top level (`context.entityName`, `context.operation`), and one thing it
cannot reach at all: the request's own id. `KavoContext` has no `id` field —
a `when()` checking "does this update target row 7" has no way to see the id
the caller sent, short of it having already been resolved into `entity`,
which is only true for an entity-aware node past the pre-fetch.

Adding parameters to a two-positional-argument closure means either growing
the positional list (a third, fourth argument a caller has to remember the
order of, and an `undefined` gap for anyone who only wants the last one) or
leaving the gap unfilled. Positional growth is the wrong shape for a
predicate that different applications will use different subsets of.

## Decision

**`when()`'s predicate takes one object argument**, replacing
`(context, entity?)`:

```ts
predicate: (args: WhenPredicateArgs<Entity>) => boolean | Promise<boolean>;

interface WhenPredicateArgs<Entity = unknown> {
  readonly context: KavoContext<Entity>;
  readonly entity?: Entity;
  readonly resource: string;
  readonly operation: OperationId;
  readonly params: WhenParams<Entity>; // Pick<KavoRequest<Entity>, "id">
}
```

- `context` and `entity` are unchanged in meaning and behavior — `entity` is
  still `undefined` unless the node is evaluated against a loaded row.
- `resource` and `operation` are `context.entityName` and `context.operation`
  surfaced at the top level, not new data — a predicate that already reads
  `context.entityName`/`context.operation` loses nothing by switching, and a
  predicate that only needed those two no longer has to destructure through
  `context` for them.
- `params.id` is new: the request's own single-row target
  (`Pick<KavoRequest<Entity>, "id">`), the one thing `context` never
  carried. The type allows `null`, for an operation with no single-row
  target (`createOne`, `findMany`), but a `when()` predicate never actually
  observes it in practice: `when` is entity-aware, and `resolveEntityConfig`
  already rejects an entity-aware node on `createOne`/`findMany` at
  bootstrap, so every operation a `when()` policy can legally be configured
  on always has a row. `evaluatePolicy` grows a fourth parameter,
  `params`, defaulted to `{ id: null }` for a caller with none to give (e.g.
  a direct unit test); `KavoEngine`'s policy stage
  (`checkPolicy`/`checkFindOnePolicy`) is the one caller that always has a
  real `request` in scope, and it runs `request.id` through the same
  `coerceId` every other consumer of it already does before building
  `params` — a predicate comparing `params.id` to a numeric literal sees a
  `number`, never the raw URL-path string an HTTP route hands the engine.
  (Caught during review of this ADR's own PR: an earlier draft passed
  `request.id` through uncoerced, which is exactly the `WireQuery`-typed-as-
  `QueryContext` hazard the next bullet describes, just for `id` instead of
  `query`.)
- **`params` deliberately excludes `query`.** `KavoRequest.query` is typed
  `QueryDto | null` (defaulting to `QueryContext<Entity>`), but over HTTP
  the value the engine actually receives at that field is a `WireQuery` —
  raw, pre-coercion bracket-key params (`@kavo/nest`'s `WireQueryPipe`) —
  not a `QueryContext`. Exposing it as `params.query` would type-check
  against a shape it does not have at runtime for every HTTP-originated
  request, a silent-wrong-answer risk in exactly the place — an
  authorization predicate — where one is least acceptable. `context.query`
  is already the normalized query (`NormalizedQueryContext<Entity> | null`)
  and is what a predicate should read instead; it carries the same
  information `params.query` would have, correctly typed, and it's already
  there today.

This is a breaking change to a public API (`when` and the new
`WhenPredicateArgs`/`WhenParams` types are core barrel exports) with no
back-compat shim — the object argument is a strict superset of what the two
positional arguments carried, so every existing predicate is a mechanical
rewrite (`(context, entity) => ...` becomes `({ context, entity }) => ...`).

Everything else ADR-0032 decided is unchanged: `when` is still the one node
type that is not inspectable data, `policyNeedsEntity` still marks it
entity-aware, and the entity-aware legality rules and enforcement point
(including `findOne`'s deferred evaluation) are untouched — `params` is
computed and passed the same way regardless of which path evaluates the
node.

## Consequences

- Every in-repo `when()` predicate is rewritten to destructure the object
  argument; `docs/features/policy.md`, `docs/guides/wiring-your-own-auth.md`,
  and the `policy` skill show the new signature.
- A predicate that wants a value across a relation still loads it itself
  through `context.repository`, as ADR-0032 already described — `params`
  does not add relation data, only the request's own `id`.
- `evaluatePolicy`'s new `params` parameter is optional (defaulted), so it
  is source-compatible for any caller that only needs `context`/`entity`
  outcomes and doesn't care what a `when()` node sees.
