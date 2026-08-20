# ADR-0033 — `policy` moves to operation scope only

**Status:** superseded by [ADR-0036](/internals/adr/0036-policy-gains-entity-and-global-defaults), which reintroduces an entity-scope `policy` (a single default node, not the per-operation map this ADR removed) and adds a global scope — amends [ADR-0032](/internals/adr/0032-policy-authorization-dsl)'s "Config surface" section. ADR-0036 is itself superseded by [ADR-0037](/internals/adr/0037-policy-collapses-to-a-single-predicate), which keeps this ADR's operation-scope-as-override rule but replaces `PolicyNode` with a plain function everywhere.

## Context

ADR-0032 deliberately gave `policy` two surfaces: an entity-scope map
(`EntityConfig.policy: Partial<Record<StandardOperationId, PolicyShorthand>>`)
and a per-operation override (`OperationConfig.policy`), with the latter
winning when both were set — "the same fallback `dto` uses." That design
mirrored `dto`'s own root-slot-plus-per-operation-override shape on the
theory that a policy declaration would want the same flexibility.

In practice the two surfaces buy nothing `dto` needed them for. `dto` has
a real root default (the entity-derived shape) that an operation
narrows. `policy` has no such default — an operation with nothing
configured runs unrestricted, at either scope — so the entity-scope map is
never a fallback with content of its own, only an alternate place to type
the same per-operation rule. Two ways to spell one setting invites drift: a
reviewer checking `updateOne`'s authorization has to read both `policy.
updateOne` and `operations.updateOne.policy` to know which one actually
governs, and a config that sets both (as ADR-0032's own precedence example
does) reads as a trap rather than a feature.

## Decision

**`EntityConfig.policy` is removed.** `OperationConfig.policy`
(`operations.<id>.policy`) is the only surface a policy is declared on.

- `EntityConfig` no longer has a `policy` field, in code or in its type.
- `resolveEntityConfig` reads `operations.<id>.policy` alone; nothing else
  feeds the resolved `ResolvedEntityConfig.policy` map.
- A caller that still passes a root-level `policy` map (the pre-ADR-0033
  shape) gets a bootstrap `ConfigurationException` naming
  `operations.<id>.policy` as the replacement, rather than the map being
  silently ignored — the same "fail loud at bootstrap" bar every other
  entry in ADR-0032's "Where entity-aware nodes are and aren't legal" and
  "bootstrap validation" sections holds to.
- Everything else ADR-0032 decided is unchanged: the node types, the
  entity-aware-node legality rules (`createOne`/`findMany` forbidden), the
  engine's enforcement point and pre-fetch behavior, and the absence of a
  global default or per-call override. (The array shorthand this bullet
  originally also named was removed afterward — see ADR-0032's own amended
  "Config surface" section.)

## Consequences

- An existing `@Kavo(Entity, { policy: {...} })` config must move every
  entry into `operations.<id>.policy` before it will bootstrap again —
  this is a breaking change to the config surface, caught at startup
  rather than producing a silently different authorization outcome.
- The precedence rule ADR-0032 introduced ("`operations.<id>.policy` wins
  over `policy.<id>` when both are set") no longer applies — there is
  only one place to set it, so there is nothing to win over.
- `docs/features/policy.md` and `docs/guides/configuration/entity-config.md`
  show only the `operations.<id>.policy` form going forward.
