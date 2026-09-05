# ADR-0048 — `apply` adds an unconditional, per-axis server-side query constraint

**Status:** accepted

## Context

Issue #138 asks whether core should grow a row-scoping seam for multi-tenant
and ownership-scoped reads. The dogfood-app evidence attached to that issue
(comments on #138) measured the cost of not having one: roughly 60+
near-identical, non-deduplicable lines per scoped entity, reimplementing
what `@Kavo` already generates, with a silent-failure mode — a forgotten
`@Override` (or one inherited from a base class, which `collectOverrides`
never finds) leaves a route completely unscoped, and a cross-tenant write
succeeds with `200 OK` instead of `404`.

The existing `policy` seam (ADR-0037) is adjacent but answers a different
question. `policy` judges a specific request — "may this caller do this" —
and denies with `403`. Row scoping is not a judgment about the caller; it is
a mandatory predicate on the query itself — "every read and write of `Order`
is restricted to `tenantId = ctx.tenantId`" — with no caller-facing allow/deny
branch at all. Modeling it as a `policy` closure that inspects `entity` after
the fact cannot narrow a `findMany`'s `WHERE` or its `total` count, and
narrowing post-fetch corrupts pagination (§ the `138` write-up's `DefaultKavoService`-wrapping dead end).

A second, narrower question raised in #138's later comments (and independently in
the feature request this ADR resolves) is per-caller **field** visibility —
hiding `costPrice` from non-owners — which interacts badly with ETags
(ADR-0027) when done by reshaping the response outside the engine's own
projection. That case is addressed here too, as a forced (additive) select,
not as field masking — see Non-goals.

`EntityConfig.filter`/`.sort`/`.select`/`.include` (issue #386) already group
"what a request may do on this axis" (`fields`) together with "what a request
gets when it asks for nothing" (`sort.default`/`select.default`/
`include.default`) at the same entity scope. A mandatory, context-dependent
value is neither of those — it is not an allowlist, and it is not a fallback
for an _absent_ client value; it must compose with a client-_supplied_ value
too. It is a third, orthogonal thing that belongs at the same scope.

## Decision

Each of the four query axes gains an optional `apply` callback, next to that
axis's own `fields`/`default`/`limits`:

```ts
filter: {
  fields: { id: ["eq", "in"], status: ["eq", "in"] },
  apply: (ctx) => ({ kind: "condition", field: "userId", operator: "EQ", value: ctx.app.userId }),
  limits: { maxDepth: 2 },
},
sort: { apply: (ctx) => [{ field: "createdAt", direction: "desc" }] },
select: { apply: (ctx) => ["tenantId"] },
include: { apply: (ctx) => ["auditLog"] },
```

**Shape.** `Apply<Entity>` reuses the existing per-axis types — `filter.apply`
returns a `FilterExpression<Entity>`, `sort.apply` a `readonly Sort<Entity>[]`,
`select.apply` a `readonly FieldPath<Entity, 1>[]`, `include.apply` a
`readonly IncludePath<Entity, 1>[]` — never a new predicate DSL. Each is
`(args: ApplyArgs<Entity>) => Result | undefined | Promise<Result | undefined>`,
where `ApplyArgs<Entity>` is `Omit<PolicyArgs<Entity>, "entity">` — the same
argument shape `policy` already takes (`context`, `resource`, `operation`,
`params`), minus `entity`. `entity` is omitted deliberately (see below), not
because `PolicyArgs` was copied incompletely.

`undefined` (including a function that returns nothing) means "no
additional constraint" — the empty case the issue asked to support without
forcing every branch of a conditional to return a value.

**Scope: entity-wide, not per-operation (yet).** `filter`/`sort`/`select`/
`include` are entity-scope-only config today — there is no
`operations.<id>.filter` to hang a per-operation `apply` override off, and
inventing one is out of scope here. `apply` runs identically for every
standard operation that touches its axis. `policy` shipped the same way
initially (a single function, ADR-0032) and only grew scopes later once the
need was concrete (ADR-0036/0037); `apply` can follow the same path if a
per-operation override turns out to be needed.

**Composition, per axis:**

- **`filter`** — `AND`ed with the client's parsed filter, never merged by
  key: `{ kind: "group", operator: "AND", children: [clientRoot, applyRoot] }`
  (the exact node shape `parseSearch`'s free-text-AND already builds,
  `query-normalizer.ts`). A client `filter[userId][eq]=<other>` can only
  narrow further inside that `AND` — it cannot widen past `apply`'s branch,
  which answers the "no bypass" requirement structurally rather than by
  special-casing the field name.
- **`sort`** — prepended ahead of the client's sort (or `sort.default`),
  forced fields deduplicated out of the tail. Same effective-order idea
  `pagination.since` already forces unconditionally.
- **`select`** — additive: forced fields are unioned into the root
  projection, never a mask. A `null` root ("every field the DTO allows") is
  already a superset, so a forced field there is a no-op. This is
  deliberately **not** the field-masking, per-caller-narrower feature
  requested in #138's ETag finding — see Non-goals.
- **`include`** — forced relation paths are unioned into the client-requested
  paths _before_ resolution, so they go through the same
  `IncludeResolver.resolve` validation (depth/breadth limits, allowlist) as
  any other path — including `defaultInclude`'s relations.

**Reads vs. single-row writes are two different mechanisms, because they run
through two different pipelines.** A read (`findMany`, `findOne`) already
goes through `QueryNormalizer`, so `filter.apply`/`sort.apply`/
`select.apply`/`include.apply` compose there, before
`NormalizedQueryContext` is built — `findOne`'s own row lookup
(`repository.findOneById(id, context.query, context)`) then inherits the
composed filter automatically, no special-casing needed.

A single-row write (`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/
`purgeOne`) never runs `QueryNormalizer` at all — it mutates by id alone. The
engine's policy stage (`KavoEngine.checkPolicy`) already pays for a
pre-fetch-by-id whenever a `policy` is configured for the operation, to hand
the loaded row to the policy function. `filter.apply` reuses that same
pre-fetch: whenever `filter.apply` is configured (regardless of whether a
`policy` is too), its result is AND-ed into the pre-fetch's own filter
(previously always `{ root: null }`). A row outside `apply`'s constraint is
therefore never found — the operation answers `404`, identical to an id that
never existed, **before** any policy or handler runs. This is also why
`entity` is excluded from `ApplyArgs`: on a write, `apply`'s filter has to
shape the very lookup that would produce `entity`, so the row cannot be
available yet when `apply` runs — unlike `policy`, which is deliberately
evaluated _after_ that same pre-fetch, against the row it found.

`sort.apply`/`select.apply`/`include.apply` have no meaning on a write (there
is no result set to sort, project, or expand) and are simply not consulted
there.

**`count`/`total`.** `findMany`'s count query is built from the same
`NormalizedQueryContext.filter`, so `filter.apply` scopes it automatically —
no separate mechanism. Kavo has no standalone aggregate operation yet
(#140); if one lands, it should compose through the same
`NormalizedQueryContext.filter` for the same reason.

**Errors.** `apply` is not wrapped in a `try`/`catch` that swallows its
failure — the existing engine error pipeline (`KavoEngine.execute`'s
`errorHandler.handle`) is what turns whatever it throws into a response,
exactly as an ordinary handler's failure does.

## `apply` is not `default`

`sort.default`/`select.default`/`include.default` (there is no `filter.default`
today) answer "what does a request that supplied nothing on this axis get" —
a client value replaces it outright. `apply` answers "what does _every_
request get, regardless of what it supplied" — it composes with a client
value rather than being replaced by one. The two are visibly different keys
with different composition rules, and if `filter.default` is ever added it
must stay that way: a default the client can still override is not a
substitute for a constraint the client cannot.

## Non-goals

- **A per-operation or global `apply` scope.** Entity-wide only, for now —
  see Decision.
- **Per-caller field _masking_** (narrowing the projection below what
  `select.fields` already allows, e.g. hiding `costPrice` from non-owners).
  `select.apply` only ever _adds_ fields. Masking is a materially different
  feature — it interacts with DTO derivation and DTO-level `Dto` suffix
  contracts, not just query resolution — and is left to a follow-up.
- **Recursing `apply` through `include`.** A parent's own `apply` composes
  into its own query; whether an _included_ child entity's own `apply` also
  runs (so a scoped parent cannot expose unscoped children through a
  relation) depends on whether the include path re-enters each target's own
  per-entity resolution or is translated as one joined query by the adapter.
  Left as an open question for the ORM adapters to answer per their own
  translation strategy, not settled by this ADR.
- **Bootstrap validation of `apply`'s return value** against the relevant
  allowlist (`filter.fields`/`select.fields`/`sort.fields`/`include.fields`).
  `apply` is evaluated per request with an arbitrary runtime value, so it
  cannot be checked at bootstrap the way `sort.default` etc. are.
  `filter.apply`/`select.apply`/`sort.apply` are trusted server-authored
  input and are not re-validated; `include.apply`'s forced paths _do_ still
  pass through `IncludeResolver.resolve`'s own validation, since they are
  unioned into the same path list before resolution — a misconfigured
  relation name there surfaces as the same `400` an unknown client path
  would, which is imprecise (a server misconfiguration reported as a client
  error) but at least fails loud rather than silently.
- **Authorization vocabulary.** `apply` never sees or grants a `role`,
  `userId`, or similar — those are exactly the fields `KavoAppContext`
  already exists for the application to declare (ADR-0043), reached through
  `ApplyArgs.context.app` like any other app-defined context.

## Consequences

- `updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne` now pay for a
  pre-fetch-by-id whenever `filter.apply` is configured, even where no
  `policy` is — the same cost `policy` already accepted for the same
  correctness reason (a plain function can't be inspected for whether it
  needs the row, so the engine pre-fetches unconditionally rather than
  guessing).
- `canonicalEtag`'s own `findOneById` call (`KavoEngine`, used to compute the
  precondition-check baseline) does not yet compose `filter.apply`. An
  `apply`-scoped entity's ETag baseline can therefore still be computed
  against a row `apply` would otherwise exclude. Left as a known gap for a
  follow-up rather than folded into this change.
