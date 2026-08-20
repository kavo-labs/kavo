# ADR-0036 — `policy` gains entity- and global-scope defaults

**Status:** accepted — supersedes [ADR-0033](/internals/adr/0033-policy-moves-to-operation-scope-only), amends [ADR-0032](/internals/adr/0032-policy-authorization-dsl)'s "Config surface" section and [ADR-0035](/internals/adr/0035-authorization-required-default-deny-switch)'s closing Consequence

## Context

ADR-0032 shipped `policy` at two surfaces — an entity-scope map
(`EntityConfig.policy: Partial<Record<StandardOperationId, PolicyNode>>`)
and a per-operation override, the latter winning when both were set.
ADR-0033 removed the entity-scope surface: the map never had content of its
own the way `dto`'s entity-derived default does, so it was only ever a
second place to type the same per-operation rule, and a config that set both
read as a trap rather than a feature. Since then, `operations.<id>.policy`
has been the only surface, and `policy` has had no global scope at all —
ADR-0035 said so explicitly when it declined to nest `authorization.required`
under `policy` for exactly that reason.

In practice, the common case an entity's authors reach for is not "a
different rule per operation" but "the same rule on every write" —
`authenticated()` on `createOne`/`updateOne`/`patchOne`/`deleteOne`, say.
Under operation-scope-only, that means repeating the identical `PolicyNode`
on every operation id, and a new operation added later silently runs
unrestricted unless someone remembers to copy the line again. Issue #250
asks for an entity-level and a global-level default that every operation
inherits unless it says otherwise, plus a way for one operation to opt out
of an inherited default explicitly.

This is a different shape from the one ADR-0033 removed, not a plain
revert: the pre-ADR-0033 entity map was **per-operation**, so it was a
second complete spelling of the same rule set. What this ADR adds is a
single **default node**, applied uniformly and only overridden where an
operation names its own — the two surfaces can never disagree about the
same operation, because the default only ever fills a gap the operation
scope left open.

## Decision

**`policy` gets two more scopes, resolved nearest-defined-wins:**
`operations.<id>.policy` → `EntityConfig.policy` → `GlobalConfig.policy` →
unrestricted.

- `EntityConfig.policy?: PolicyNode<Entity>` — one node, the default for
  every operation on this entity that configures no `policy` of its own.
  Structural entity-scope config, like `dto`/`computed` — resolved by its
  own precedence walk in `resolveEntityConfig`, not `mergeSettings`, for the
  same reason ADR-0032 gave: `when()` carries a closure, and the settings
  tree is deep-frozen and merged field-by-field, which would corrupt a
  discriminated union's shape rather than replace it wholesale.
- `GlobalConfig.policy?: PolicyNode` — the root-level default, set at
  `createKavo({ policy })`. **Deliberately not a `KavoSettings` field**,
  unlike `authorization.required`: `GlobalConfig.defaults` is typed
  `DeepPartial<KavoSettings>`, and `DeepPartialValue`'s conditional
  distributes over a union, so `DeepPartial<PolicyNode>` would partialize
  every branch of the discriminated union independently — `{ type?:
"permission"; name?: string } | { type?: "owner"; field?: string } | …`
  — erasing the discriminant and admitting a malformed node the type system
  can no longer catch. `GlobalConfig` gets its own `policy` field, sibling
  to `defaults`, the same way `EntityConfig.policy` sits beside (not inside)
  `DeepPartial<KavoSettings>`.
- `OperationConfig.policy` widens to `PolicyNode<Entity> | false`. `false`
  opts that one operation out of an inherited entity- or global-scope
  default, back to unrestricted — the only way to spell "no policy here" once
  a default exists to inherit from, since omitting the key means "inherit,"
  not "none." `EntityConfig.policy`/`GlobalConfig.policy` do **not** accept
  `false` — there is nothing above global scope to opt out of, and an entity
  wanting every operation unrestricted despite a global default can still
  reach that with `operations.<id>.policy: false` per operation, or simply
  by not inheriting a global default it does not want (an entity's own
  `policy`, once set, already replaces the global one wholesale for any
  operation that does not itself override it).
- **Resolution is wholesale, not deep-merged.** The nearest scope that
  defines a value wins outright — an `authenticated()` at global scope and
  an `owner('authorId')` at entity scope never combine into some third node;
  entity scope simply replaces global scope for every operation it reaches.
  This is `PolicyNode`'s only sound merge algebra: two node variants have
  different fields, so a field-by-field merge (`mergeSettings`'s algebra)
  would leave a stale field from one variant attached to the other's `type`.
- **Bootstrap validation runs against the effective (resolved) node for
  every operation, not only a node declared directly on that operation.**
  An entity- or global-scope `owner`/`when` that inherits onto
  `createOne`/`findMany` is exactly as unrunnable as one declared there
  directly (ADR-0032's "Where entity-aware nodes are and aren't legal"), and
  an inherited `owner(field)` crossing a relation boundary is exactly as
  broken as one declared per-operation (the pre-fetch still loads no
  relations). Both fail loudly at bootstrap, naming the operation the
  inherited node reaches, the same bar every other check in
  `resolveEntityConfig` holds to.
- **Shape validation widens accordingly.** A `policy` value at any of the
  three scopes must have a recognized `PolicyNode` `type` discriminant (the
  new `isPolicyNode` guard, `packages/core/src/policy/kavo-policy.ts`) or be
  the array shorthand ADR-0032 already rejects by name (issue #242) — this
  is what catches the pre-ADR-0033 entity-scope map shape if a caller still
  passes one: it has no `type` field, so it now fails as "not a PolicyNode"
  rather than the ADR-0033-era "entity-scope map no longer supported"
  message, since the field it is landing on has a different, real meaning
  now.
- **Still no per-call override.** `KavoEngine.configViewFor` continues to
  pin `policy` to whatever bootstrap resolved, unaffected by this ADR — the
  reasoning is ADR-0032's, unchanged: a per-call parameter able to loosen a
  policy would let a caller weaken its own authorization.

### Interaction with `authorization.required` (ADR-0035)

ADR-0035's `authorization.required` is unaffected in mechanism: it fires
only when the policy stage's per-operation lookup finds nothing, i.e. `node
=== undefined` — after this ADR, that still means "operation scope said
nothing, entity scope said nothing, global scope said nothing." An entity or
global default now closes that gap more often than before, but the switch
itself does not change: an operation with an _explicit_ `policy` (its own,
or an inherited default) is still unaffected by `required` either way, and
an operation `false`'d back to unrestricted is, correctly,
**still exempt from `authorization.required`** — `false` resolves to `node
=== undefined` for `checkPolicy`'s purposes (there is no rule, by the
caller's own explicit choice), the same as an operation that never had a
`policy` entry at all. This is intentional, not an oversight: `required`
denies a _gap_ (nothing considered), while `false` is a considered decision
to leave the operation open despite an inherited default; conflating the two
would remove the one way this ADR gives an author to say "this one really is
public."

ADR-0035's Consequences bullet ("This does not reopen ADR-0032's 'no global
`policy`' decision … `authorization.required` is a sibling switch over what
happens when that map has nothing to say") is superseded by this ADR:
`policy` **does** now have a global scope. The two mechanisms remain
orthogonal, though, and that half of ADR-0035's reasoning still holds:
`authorization.required` is not how a global default is populated — it
still only governs the _absence_ of any policy at all, resolved _after_
this ADR's fallback chain has already run and found nothing.

## Consequences

- `EntityConfig.policy` returns as a public field, with a different shape
  and meaning than the one ADR-0033 removed (a single default, not a
  per-operation map) — an application migrating from the pre-ADR-0033 shape
  still needs to move a per-operation map into `operations.<id>.policy`
  entries; only a single, entity-wide rule now has a shorter spelling.
- `GlobalConfig`/`KavoOptions` gains `policy?: PolicyNode`, read once at
  `createKavo`, threaded into every entity's `resolveEntityConfig` call.
- `resolvePolicy` (`packages/core/src/config/resolve-entity-config.ts`) walks
  three scopes instead of one and validates the _effective_ node per
  operation, not only a directly-configured one.
- `docs/features/policy.md`, `docs/guides/configuration/entity-config.md`,
  `docs/guides/configuration/index.md`, and
  `docs/internals/architecture/08-configuration.md` are updated to show the
  three-scope form.
- Nothing about the engine's enforcement point, pre-fetch behavior, 404-vs-403
  handling, or `authorization.required`'s own mechanism changes — this ADR
  is entirely about where a `PolicyNode` may be _declared_, not how one is
  _evaluated_.
