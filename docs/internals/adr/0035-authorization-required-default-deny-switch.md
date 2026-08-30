# ADR-0035 — `authorization.required` denies standard operations with no configured policy

**Status:** accepted (the closing Consequence's "does not reopen ADR-0032's
'no global `policy`' decision" is superseded by
[ADR-0036](/internals/adr/0036-policy-gains-entity-and-global-defaults),
which gives `policy` a global scope — the two mechanisms stay orthogonal;
see that ADR's "Interaction with `authorization.required`" section)

## Context

ADR-0032's `policy` is opt-in per standard operation: an operation id absent
from `EntityConfig.policy`/`operations.<id>.policy` runs unrestricted, and
that ADR is explicit that there is no global `policy` and no per-call
override — "a per-call parameter that could loosen a policy would let a
caller weaken its own authorization." Issue #237 asks for a default-deny
posture: a switch that makes an operation with no configured `policy.<id>`
answer `403 KAVO_FORBIDDEN` instead of running unrestricted, so a new
operation added without a `policy` entry fails loudly (at request time)
rather than shipping unauthenticated by accident.

This ADR settles the two questions #237 left open, plus a naming collision
the obvious spelling runs into.

### Why the switch cannot be named `policy.required`

`EntityConfig.policy` (and `OperationConfig.policy`) is already a
structural field — `Partial<Record<StandardOperationId, PolicyShorthand>>`
— declared directly on `EntityConfig`/`OperationConfig`, not inherited from
`KavoSettings`. `resolvePolicy` (`resolve-entity-config.ts`) also rejects
any key on it that isn't a standard operation id, specifically so a typo
protects nothing silently. Nesting a boolean under that same `policy` key
would require `required` to dodge that rejection as a special case, and — the
harder problem — `policy` has **no global scope at all** today
(`GlobalConfig.defaults` is typed `DeepPartial<KavoSettings>`, and `policy`
is not a `KavoSettings` field). Since #237 explicitly wants a _global_
default, the switch has to live inside `KavoSettings` to get a global scope
for free through `KavoOptions.defaults`. A `KavoSettings` field and an
`EntityConfig`-only structural field cannot share the name `policy` on the
same interface without a type conflict, so the switch needs its own name.

## Decision

**A new `KavoSettings` field, `authorization: AuthorizationSettings`,
where `AuthorizationSettings = { readonly required: boolean }`, defaulting
to `{ required: false }`.**

- It is an ordinary `KavoSettings` subtree, merged through the standard
  `built-in defaults → global → entity → operation` chain
  (`mergeSettings`), the same as `cache`/`realtime`/`errors`. No new merge
  algebra.
- **Per-call is excluded.** `KavoEngine.configViewFor` merges a per-call
  `options.settings` override into every other `KavoSettings` field as
  usual, then pins `authorization` back to the pre-per-call value — the same
  treatment `configViewFor` already gives the (structural) `policy` map
  itself. The reasoning is identical to ADR-0032's: a per-call parameter
  that could loosen enforcement defeats the point of the switch, and pinning
  the whole subtree is simpler and more obviously correct than trying to
  allow tightening but not loosening.
- **Ordinary custom operations are unaffected**, not by a new carve-out but
  because none is needed: `KavoEngine.checkPolicy` only ever looks up
  `configView.policy[descriptor.id]` for a **standard** operation id (a
  custom operation's `descriptor.id` is never a `StandardOperationId`, so
  `isStandardOperationId` already excludes it upstream of this change). A
  custom operation's handler still reaches `context.app` directly and
  refuses a caller on its own terms (`ForbiddenException`, or its own
  exception) — exactly the boundary ADR-0032 already drew, and #182's
  concern, not this one's.
- **Kavo-synthesized array-mutation operations ARE gated, unlike ordinary
  custom operations.** `registerArrayMutationOperations`
  (`relations/array-mutation-operations.ts`) auto-registers
  `replace<Relation>`/`list<Relation>`/`add<Relation>`/`remove<Relation>`
  whenever a relation opts into `relations.edges.<name>.write` — entirely
  from entity config, never through `EntityConfig.operations` the way an
  ordinary custom operation is declared. These ids are never standard
  operation ids either, so `resolvePolicy` rejects any attempt to name one
  in `policy.<key>` — they can never carry a `policy.<id>` entry, by
  construction. The "a custom operation's own handler already refuses a
  caller" reasoning above does not apply to them: the handler behind
  `replace<Relation>` is Kavo's own (`unboundArrayMutationHandler`/the
  built-in factories `createCrud` wires), not app-authored code, so there is
  no place outside this switch such a check could live. Excluding them would
  leave a real mutating write route with no authorization hook at all under
  `required: true` — the opposite of what the switch is for. `checkPolicy`
  detects them via `descriptor.meta.arrayMutation !== undefined`
  (`OperationMetadata.arrayMutation`, ADR-0014/0029's own marker), not via
  `isStandardOperationId`. There is deliberately **no** per-relation opt-out
  in this ADR: `operations.<id>.authorization.required: false` cannot name
  an array-mutation id, because `createOperationRegistry`'s custom-operation
  path (`registerCustomOperation`) unconditionally demands a `handler` for
  any `operations.<key>` entry whose key isn't a standard id, and an
  array-mutation id is synthesized by a separate post-hoc step
  (`registerArrayMutationOperations`, run after `createOperationRegistry`)
  specifically so it is _not_ declared through `EntityConfig.operations`.
  Reconciling that — letting a settings-only override target an id that
  doesn't exist yet at registry-build time — is a real follow-up, not
  something this ADR does in passing; today the only way to exempt an
  array-mutation write from `required: true` is to leave that relation out
  of `write` or turn `authorization.required` off for the whole entity.
- **Enforcement point**: `checkPolicy`'s existing "no policy entry" branch
  (`if (node === undefined) return;`) gains one condition — for a standard
  or array-mutation operation with no entry, deny with `ForbiddenException`
  when `configView.settings.authorization.required` is `true`; otherwise,
  return unrestricted as before. This runs at exactly the same point in the
  pipeline the ADR-0032 policy stage already occupies (after context is
  built, before preconditions and the cache), so a denial here gets the same
  guarantees (never learns whether `If-Match` would have passed, never
  answered from a stale cache entry).
- An operation with an explicit `policy.<id>` entry is entirely unaffected
  by `authorization.required` either way — the switch only fills the gap
  where no rule is configured, it never overrides a configured one, since
  the branch it extends only runs when `node === undefined`.

## Consequences

- `KavoSettings` gains one more subtree; `SETTINGS_KEYS`
  (`resolve-entity-config.ts`) gains `"authorization"` so it participates in
  the entity/operation merge, and `BUILT_IN_DEFAULTS` gains
  `authorization: { required: false }` so every existing app is unaffected
  until it opts in.
- `authorization` and `policy` now sit side by side in `@Kavo` config
  (`policy` the per-operation rule tree, `authorization.required` the
  global/entity/operation default-deny switch for operations `policy`
  leaves unconfigured) — a reader has to learn they are two different
  mechanisms rather than one, which the naming keeps distinct on purpose.
- This does not reopen ADR-0032's "no global `policy`" decision: the
  `policy` map itself still has no global scope and no per-call override.
  `authorization.required` is a sibling switch over what happens when that
  map has nothing to say, not a way to populate the map from outside an
  entity's own config.
