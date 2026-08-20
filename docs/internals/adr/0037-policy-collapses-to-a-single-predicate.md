# ADR-0037 — `policy` collapses to a single predicate function, at three scopes

**Status:** accepted — supersedes [ADR-0032](/internals/adr/0032-policy-authorization-dsl), [ADR-0033](/internals/adr/0033-policy-moves-to-operation-scope-only), [ADR-0034](/internals/adr/0034-when-predicate-takes-a-single-object-argument), and [ADR-0036](/internals/adr/0036-policy-gains-entity-and-global-defaults)

## Context

ADR-0032 gave `policy` a small inspectable node-tree DSL: `permission`,
`role`, `owner`, `authenticated`, `filtered`, composed with `and`/`or`/`not`,
plus a `when()` escape hatch holding an arbitrary predicate (later reshaped
by ADR-0034). ADR-0036 then gave `policy` three resolution scopes —
`operations.<id>.policy` → `EntityConfig.policy` (one entity-wide default) →
`GlobalConfig.policy` (`createKavo({ policy })`) → unrestricted, nearest
scope wins wholesale — plus `operations.<id>.policy: false` to opt one
operation out of an inherited default.

The DSL's inspectability paid for itself in exactly one place:
`resolveEntityConfig`'s `policyNeedsEntity` walk let the engine skip
pre-fetching a row before a policy that provably never looks at it (a bare
`permission`/`role`/`authenticated` check), and let bootstrap reject an
`owner()`/`when()` node — declared directly or inherited from entity/global
scope — on `createOne`/`findMany`, where no single row exists to check.

In practice, almost every non-trivial policy ends up as a `when()` closure
anyway — the four built-in leaf nodes cover the simplest cases, but ordinary
authorization logic (role bypasses ownership, a banned flag overrides
everything, a check against a related record) reaches for `when()` and its
`and`/`or`/`not` wrapping immediately. The DSL adds a constructor API, a
recursive evaluator, and bootstrap-time static-analysis passes
(`policyNeedsEntity`, `collectOwnerFields`, `isPolicyNode`) to cover a
static-inspection benefit that a `when()`-shaped policy already opts out of.
That is more surface than the feature earns: a caller who wants composition
is better served writing plain `&&`/`||`/`!`/early-return JavaScript against
a single function than learning a parallel combinator vocabulary for the
same thing. ADR-0036's three-scope resolution is independently valuable —
issue #250's motivating case (the same rule on every write) is real — and
this ADR keeps it, re-expressed over functions instead of node trees.

## Decision

**`policy` is one function, not a node tree, at every scope:**

```ts
export type Policy<Entity = unknown> = (args: PolicyArgs<Entity>) => boolean | Promise<boolean>;

export interface PolicyArgs<Entity = unknown> {
  readonly context: KavoContext<Entity>;
  readonly entity?: Entity;
  readonly resource: string;
  readonly operation: OperationId;
  readonly params: WhenParams<Entity>; // Pick<KavoRequest<Entity>, "id">, unchanged from ADR-0034
}
```

`true` allows the request through; `false` (or a rejected/falsy promise
resolution) denies it with `ForbiddenException`, exactly as before.

**Three scopes, nearest-defined wins, unchanged from ADR-0036:**
`operations.<id>.policy: Policy<Entity> | false` → `EntityConfig.policy:
Policy<Entity>` (one default for every operation on the entity) →
`GlobalConfig.policy: Policy` (`createKavo({ policy })`) → unrestricted.
`operations.<id>.policy: false` still opts one operation out of an inherited
entity- or global-scope default, back to unrestricted — the only way to
spell that, since omitting the key means "inherit," not "none."
`EntityConfig.policy`/`GlobalConfig.policy` still do not accept `false`
themselves, for the same reason ADR-0036 gave: there is nothing above
global scope to opt out of. Resolution is still wholesale, not merged — the
nearest scope that defines a policy replaces every operation it reaches,
never combined field-by-field with a farther one.

`GlobalConfig.policy` stays untyped to any entity (`Policy`, i.e.
`Policy<unknown>`) and structural rather than a `KavoSettings` field, for a
narrower version of ADR-0036's reasoning: `GlobalConfig.defaults` is typed
`DeepPartial<KavoSettings>`, and `DeepPartial` recurses into any property
type that extends `object` — which a function type does — so
`DeepPartial<Policy>` would produce an object type keyed by
`Function.prototype`'s own properties instead of a callable function,
silently losing the one property that matters. `EntityConfig.policy`/
`OperationConfig.policy` sit beside `DeepPartial<KavoSettings>` for the
same reason.

**Removed:** the node constructors (`permission`, `role`, `owner`,
`authenticated`, `filtered`, `and`, `or`, `not`, `when` — a plain function is
now what `when()` used to wrap, so there is nothing left to name separately),
the `PolicyNode` and `KavoPrincipal` types, and the helpers `evaluatePolicy`
(the engine calls the function directly), `policyNeedsEntity`,
`collectOwnerFields`, and `isPolicyNode`. Composition — permission checks,
ownership checks, role bypasses, ANDing several conditions — is ordinary
JavaScript inside one function; there is no combinator API to learn.

**Entity pre-fetch is no longer conditional.** A plain function cannot be
statically inspected for whether it reads `entity`, so `policyNeedsEntity`'s
optimization has no static signal to work from. Rather than approximate it
(e.g. a second `needsEntity` flag the caller sets by hand, which drifts from
the function body it describes), the engine always pre-fetches the row for
every single-row operation (`findOne`, `updateOne`, `patchOne`, `deleteOne`,
`restoreOne`, `purgeOne`) that has a resolved policy — from any of the three
scopes. `createOne`/`findMany` still call the policy with `entity: undefined`
— there is no single row for either, and this is now enforced by what the
operation actually has to hand the function rather than by a bootstrap check
walking the policy's shape. This removes `resolveEntityConfig`'s two
policy-shape validations (the entity-aware-on-`createOne`/`findMany` check
and the `owner()`-field relation-crossing check, both from ADR-0032, widened
by ADR-0036 to walk the effective resolved node) — there is no longer a
shape to walk, at any scope.

**A missing row always answers 404, ahead of the policy — now uniformly.**
This was already true for `owner`/`when` under the old DSL, since either
always triggered the pre-fetch; a context-only policy (`permission`/`role`/
`authenticated`) never fetched at all and always answered 403 regardless of
whether the row existed. The collapse to a plain function makes this
uniform: the engine can no longer tell a context-only policy from a
row-dependent one to special-case it, so every configured policy on a
missing row now answers 404 first. `findOne` is unaffected in mechanism: it
already loads its own result, so evaluating the policy there would fetch
twice. `checkPolicy` always defers a configured `findOne` policy to
`checkFindOnePolicy`, run against the row the handler already fetched — this
was already true for entity-aware nodes under ADR-0032; it is now true
unconditionally. `isCacheableRead`'s cache carve-out follows the same
simplification: any resolved `findOne` policy refuses the cache-read
shortcut, not only one `policyNeedsEntity` flagged.

**Bootstrap validation is reduced to one check, applied at every scope:**
`resolvePolicy` rejects a `policy` value — at operation, entity, or global
scope — that is not a function (`ConfigurationException`), whether it is
the pre-ADR-0033 per-operation map shape, an array, or anything else a JS or
dynamically-built config might produce that the type system cannot catch.
`EntityConfig`/`GlobalConfig` declare no other shape for `policy`, so a
TypeScript caller gets a compile error for a malformed value already.

`authorization.required` (ADR-0035) is unaffected in mechanism: it still
fires only when the policy stage's per-operation lookup finds nothing after
all three scopes have been walked, and an operation `false`'d back to
unrestricted is still exempt from it — `false` is a considered decision to
leave the operation open, not a gap. Both of ADR-0035's amendments from
ADR-0036 (the interaction with a resolved default, and the "policy does now
have a global scope" correction) carry forward unchanged; only the value
type at each scope changed, from `PolicyNode` to `Policy`.

## Consequences

- This is a breaking change to a public API with no back-compat shim: every
  `permission(...)`/`role(...)`/`owner(...)`/`authenticated()`/`filtered(...)`/
  `and(...)`/`or(...)`/`not(...)`/`when(...)` call site becomes a hand-written
  `Policy<Entity>` function, at whichever scope it was configured. There is
  no runtime detection of the old node shape to produce a targeted error
  message beyond "not a function."
- A single-row operation with a resolved policy now always costs one extra
  read, even for a policy that never touches `entity` (a bare permission
  check) and even when that policy came from an entity- or global-scope
  default rather than the operation itself. This trades a small, universal
  cost for removing the static-analysis machinery that used to avoid it
  selectively — judged worthwhile given how rarely a real policy stayed
  simple enough for the old optimization to fire in the first place.
- A caller a context-only policy would have refused anyway — a failed
  permission check, say — now learns via 404 vs. 403 whether the row
  exists, where before it never triggered the pre-fetch and always saw 403
  regardless. This extends a rule the framework already accepted for
  `owner`/`when` to every policy, rather than introducing a new hazard.
- A policy that needs a value across a relation still loads it itself
  through `context.repository`, unchanged from ADR-0032/ADR-0034/ADR-0036 —
  the pre-fetch loads no relations either way, at any scope.
- `EntityConfig.policy`/`GlobalConfig.policy` keep the shape ADR-0036 gave
  them (one default, not a per-operation map) — only the function-vs-node
  question changes for this ADR; an application already on ADR-0036's
  three-scope form has no scope-placement decisions left to revisit, only a
  mechanical node-to-function rewrite at each site.
