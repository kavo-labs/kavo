# ADR-0051 — `FieldPath`'s default recursion cap is raised from 3 to 5

**Status:** accepted (issue #417) — amends [ADR-0008](/internals/adr/0008-field-path-recursion-cap), whose mechanism (tuple-decrement counter, hard maximum 5, degrade-to-`string`) is kept intact; only the default value changes.

## Context

`FieldPath<Entity>` and its relation-only sibling `IncludePath<Entity>`
expand an entity shape into a template-literal union of dot-paths, used to
spell-check `sort.fields`, `filter.fields`, `select.fields` (at depth 1),
and the programmatic `QueryContext.include`. ADR-0008 capped the **default**
depth at 3 — a path deeper than `posts.comments.text` was a type error at
the config call site unless the caller wrote an explicit `FieldPath<T, 4|5>`,
which config blocks give no way to do.

Depth-4 paths are a real integrator need — an entity reachable as
`owner.address.owner.id` across a mutually-referential relation pair is
ordinary. ADR-0008 set the default at 3 rather than the `FieldPathDepth`
hard maximum of 5 purely for compiler cost: the union grows combinatorially
with depth, and `FilterOperatorMap` (`entity-config.ts`) builds a mapped
type over the whole `FieldPath` union per entity.

We considered threading a per-block or single-knob generic depth parameter
that config could opt into, and rejected it as too much permanent API
surface (a generic parameter on `createCrud` and `@Kavo`, inferred from a
config literal) for the size of the need.

Measured cost of moving the default to 5 across the whole `pnpm typecheck`
matrix (root + every package + all three example apps, which include the
mutually-referential TypeORM entities): user CPU time went from ~34.7s to
~36.1s (≈4%), wall time ~19s to ~20s, with no "type instantiation is
excessively deep" error anywhere. The combinatorial blow-up ADR-0008 warned
about does not materialise at depth 5 on the schemas in this repo.

## Decision

`FieldPath<Entity, MaxDepth extends FieldPathDepth = 5>` and
`IncludePath<Entity, MaxDepth extends FieldPathDepth = 5>` — the default is
now 5, which equals the hard maximum. Everything else ADR-0008 decided is
unchanged:

- `FieldPathDepth` still bounds `MaxDepth` to `1 | 2 | 3 | 4 | 5`; a
  depth-6 path is still a type error, and `FieldPath<T, 6>` still fails to
  compile.
- The `MaxDepth` parameter stays — its remaining job is **lowering** the cap
  below the default for a specific use (`FieldPath<Entity, 1>` for
  root-only selectors, `IncludePath<Entity, 1>` for `include.fields` per
  ADR-0028). No consumer needs to raise it any more.
- `any` / `unknown` / index-signature shapes still degrade to `string`.
- Compile-time depth stays independent of the runtime limits
  (`filter.limits.maxDepth`, `include.limits.maxDepth`) — the runtime
  remains the security gate.
- Still "one policy, not a pattern": `IncludePath` reuses `FieldPath`'s
  `Prev` counter, default and maximum rather than declaring its own.

## Consequences

- No opt-in mechanism is added. If a consumer with a large
  mutually-referential schema reports slow type checking, the fix is to
  add a way to **lower** the cap per project (or per block), not to
  reintroduce a raise-it knob — the default would move back down and this
  ADR would be revised again.
- `select.fields` is untouched: it is `FieldPath<Entity, 1>` by explicit
  argument (ADR-0045), not the default.
- `include.fields` / `include.default` are untouched: `IncludePath<Entity, 1>`
  by explicit argument (ADR-0028). The `IncludePath` default only reaches
  `QueryContext.include`.
