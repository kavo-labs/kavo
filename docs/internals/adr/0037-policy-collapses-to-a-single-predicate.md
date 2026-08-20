# ADR-0037 — `policy` is a single predicate function, at three scopes

**Status:** accepted

## Context

Authorization logic rarely stays simple: role bypasses ownership, a banned
flag overrides everything, a check reaches across a related record. A small
inspectable DSL of composable node types (`permission`, `role`, `owner`,
`authenticated`, `filtered`, combined with `and`/`or`/`not`, plus a `when()`
escape hatch for arbitrary predicates) covers the easy cases, but almost
every non-trivial policy ends up written as an escape-hatch closure anyway —
the DSL's constructor API, recursive evaluator, and bootstrap-time
static-analysis passes buy inspectability that a closure-shaped policy
already opts out of. A caller who wants composition is better served writing
plain `&&`/`||`/`!`/early-return JavaScript against one function than
learning a parallel combinator vocabulary for the same thing.

A separate need is real and independent of the DSL-vs-function question:
the same rule often applies to every operation on an entity, or to every
entity in an app (issue #250) — so `policy` needs more than one resolution
scope.

## Decision

**`policy` is one function, not a node tree, at every scope:**

```ts
export type Policy<Entity = unknown> = (args: PolicyArgs<Entity>) => boolean | Promise<boolean>;

export interface PolicyArgs<Entity = unknown> {
  readonly context: KavoContext<Entity>;
  readonly entity?: Entity;
  readonly resource: string;
  readonly operation: OperationId;
  readonly params: WhenParams<Entity>; // Pick<KavoRequest<Entity>, "id">
}
```

`true` allows the request through; `false` (or a rejected/falsy promise
resolution) denies it with `ForbiddenException`.

**Three scopes, nearest-defined wins:**
`operations.<id>.policy: Policy<Entity> | false` → `EntityConfig.policy:
Policy<Entity>` (one default for every operation on the entity) →
`GlobalConfig.policy: Policy` (`createKavo({ policy })`) → unrestricted.
`operations.<id>.policy: false` opts one operation out of an inherited
entity- or global-scope default, back to unrestricted — the only way to
spell that, since omitting the key means "inherit," not "none."
`EntityConfig.policy`/`GlobalConfig.policy` do not accept `false`
themselves — there is nothing above global scope to opt out of. Resolution
is wholesale: the nearest scope that defines a policy replaces every
operation it reaches, never merged field-by-field with a farther one.

`GlobalConfig.policy` stays untyped to any entity (`Policy`, i.e.
`Policy<unknown>`) and structural rather than a `KavoSettings` field:
`GlobalConfig.defaults` is typed `DeepPartial<KavoSettings>`, and
`DeepPartial` recurses into any property type that extends `object` —
which a function type does — so `DeepPartial<Policy>` would produce an
object type keyed by `Function.prototype`'s own properties instead of a
callable function, silently losing the one property that matters.
`EntityConfig.policy`/`OperationConfig.policy` sit beside
`DeepPartial<KavoSettings>` for the same reason.

There is no combinator API — permission checks, ownership checks, role
bypasses, ANDing several conditions are ordinary JavaScript inside one
function.

**Entity pre-fetch is unconditional.** A plain function cannot be
statically inspected for whether it reads `entity`, so the engine always
pre-fetches the row for every single-row operation (`findOne`, `updateOne`,
`patchOne`, `deleteOne`, `restoreOne`, `purgeOne`) that has a resolved
policy — from any of the three scopes. `createOne`/`findMany` call the
policy with `entity: undefined` — there is no single row for either.

**A missing row always answers 404, ahead of the policy.** `findOne` is the
exception in mechanism: it already loads its own result, so evaluating the
policy there would fetch twice. `checkPolicy` always defers a configured
`findOne` policy to `checkFindOnePolicy`, run against the row the handler
already fetched. `isCacheableRead` refuses the cache-read shortcut whenever
`findOne` has a resolved policy.

**Bootstrap validation is one check, applied at every scope:**
`resolvePolicy` rejects a `policy` value — at operation, entity, or global
scope — that is not a function (`ConfigurationException`). `EntityConfig`/
`GlobalConfig` declare no other shape for `policy`, so a TypeScript caller
gets a compile error for a malformed value already.

`authorization.required` (ADR-0035) fires only when the policy stage's
per-operation lookup finds nothing after all three scopes have been walked;
an operation `false`'d back to unrestricted is exempt from it — `false` is
a considered decision to leave the operation open, not a gap.

## Consequences

- A single-row operation with a resolved policy always costs one extra
  read, even for a policy that never touches `entity` (a bare permission
  check) and even when that policy came from an entity- or global-scope
  default rather than the operation itself — a small, universal cost,
  judged worthwhile against maintaining static-analysis machinery that only
  paid for itself when a policy stayed simple enough to skip the pre-fetch.
- A context-only policy — a failed permission check, say — now learns via
  404 vs. 403 whether the row exists, since every configured policy
  triggers the pre-fetch uniformly.
- A policy that needs a value across a relation loads it itself through
  `context.repository` — the pre-fetch loads no relations.
