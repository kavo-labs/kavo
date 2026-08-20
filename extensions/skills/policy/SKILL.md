---
name: policy
description: Reference for Kavo's `policy` authorization function — a plain `(args) => boolean | Promise<boolean>` at operation/entity/global scope, enforcement order, and the authorization.required default-deny switch. Use when gating an operation on the caller (403 KAVO_FORBIDDEN), requiring an authenticated principal, checking row ownership, requiring a query filter to be present, or making an unconfigured operation deny by default.
---

# Policy authorization reference

`policy` refuses a request before its handler runs. Each standard operation
on an entity can carry a rule evaluated against `context.principal` and,
when the rule needs it, the loaded row — a rule that returns `false` answers
`403` with `KAVO_FORBIDDEN`. Full detail: `docs/features/policy.md`
([ADR-0037](https://github.com/kavo-labs/kavo/blob/main/docs/internals/adr/0037-policy-collapses-to-a-single-predicate.md)).
Wiring `context.principal` itself is the `global-config`/`kavo-decorator`
skills' territory (an app's own auth layer) — `policy` only ever reads it.

## Config shape

```ts
import type { Policy } from "@kavo/core";

const isAuthenticated: Policy<Post> = ({ context }) => context.principal != null;
const isOwner: Policy<Post> = ({ context, entity }) => entity?.authorId === (context.principal as { userId?: string })?.userId;

@Kavo(Post, {
  policy: isAuthenticated, // entity-level default for every operation
  operations: {
    createOne: { policy: isAuthenticated },
    findMany: { policy: () => true },
    findOne: {
      policy: (args) => (args.context.principal as { roles?: string[] })?.roles?.includes("admin") || isOwner(args),
    },
    updateOne: {
      policy: (args) =>
        ((args.context.principal as { permissions?: string[] })?.permissions?.includes("post:update") ?? false) &&
        isOwner(args),
    },
  },
})
```

`policy` resolves nearest-scope-wins across three places: `operations.<id>.policy`,
then the entity's own `policy` (`EntityConfig.policy`, one function applied as
the default for every operation that configures none of its own), then a
root-level default set once at `createKavo({ policy })` (`GlobalConfig.policy`).
`operations.<id>.policy: false` opts one operation back out of an inherited
entity- or global-scope default, back to unrestricted. An operation with no
policy resolved at any scope is unrestricted by default — opt-in, not a
global switch (see `authorization.required` below for the opposite default).

## The policy function

`policy` is one function per scope — `(args: PolicyArgs<Entity>) => boolean | Promise<boolean>`,
not a combinator DSL:

| Field       | What it is                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `context`   | the request's `KavoContext<Entity>` — `context.principal`, `context.query`, `context.repository`                  |
| `entity`    | the loaded row, on a single-row operation; `undefined` on `createOne`/`findMany`, where there is no single row    |
| `resource`  | `context.entityName` surfaced at the top level                                                                    |
| `operation` | `context.operation` surfaced at the top level                                                                     |
| `params`    | `{ id }` — the request's own single-row target, coerced to the id column's kind, `null` when there isn't one      |

Kavo never inspects, validates, or shapes `context.principal` — a policy
function reads it however an application's auth layer fills it in. Without
that wiring, `principal` is `null` on every request and a principal-reading
policy denies everything.

Composition (`and`/`or`/`not`) is ordinary `&&`/`||`/`!` inside the function.
A reusable check (an ownership check, a permission check) is just a function
that takes `PolicyArgs` and gets called from a larger one, as `isOwner` does
above. A policy that needs a value across a relation loads it itself through
`context.repository`.

## `owner`/row-dependent checks — single-row operations only

A policy that reads `entity` only makes sense on `findOne`, `updateOne`,
`patchOne`, `deleteOne`, `restoreOne`, `purgeOne` — the operations with a
single loaded row. On `createOne` (no row yet) or `findMany` (a set, not one
row), `entity` is always `undefined`; write the function so it accounts for
that rather than assuming a row is present.

### Requiring a query filter, not just a principal check

```ts
@Kavo(Post, {
  operations: {
    findMany: {
      policy: ({ context }) => context.principal != null && context.query?.filter?.some((c) => c.field === "userId"),
    },
  },
})
```

`GET /posts?filter[userId][eq]=u-1` passes; a bare `GET /posts` 403s. This
gates whether the operation runs at all — it is **not** row-scoping. A
caller who supplies `userId` still sees every row that filter matches, not
only their own; pair it with an ownership check (or an app-level default
filter) when the requirement is "only your own rows."

## Enforcement order

The policy stage runs after context is built, before preconditions and the
cache — a denied request never learns whether its `If-Match` would have
succeeded. On a single-row operation with a resolved policy (from any
scope), the engine always pre-fetches the row (including soft-deleted, since
`restoreOne`/`purgeOne` target a deleted row by definition) before the
handler runs — a plain function can't be inspected for whether it reads the
row. **No row found → 404, never 403** — the status code must not leak
whether the row exists. `createOne`/`findMany` always run with
`entity: undefined`.

`findOne` is the exception to the pre-fetch: it already loads the row as its
own result, so a resolved policy runs _after_ the handler, against what it
fetched — and `findOne` is never cached for an entity with a resolved
`findOne` policy, so a cache hit can't skip the deferred check.

## What policy does not do

- **No row-scoping.** `findMany` still returns every row its query
  matches; `policy` decides _whether_ the call runs, not what a passing
  call sees.
- **No per-call override.** `policy` lives outside the settings precedence
  chain — a per-call parameter that could loosen a rule would let a caller
  weaken its own authorization.
- **Custom operations get no `policy` entry** — their handler reaches
  `context.principal` directly and throws `ForbiddenException` for the same
  `403 KAVO_FORBIDDEN`.

## `authorization.required` — default-deny for unconfigured operations (ADR-0035)

```ts
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  defaults: { authorization: { required: true } }, // every entity/operation
});

@Kavo(Post, {
  authorization: { required: true }, // this entity
  operations: {
    updateOne: { policy: (args) => (args.context.principal as { permissions?: string[] })?.permissions?.includes("post:update") ?? false },
    findMany: { authorization: { required: false } }, // opt this one back out
  },
})
```

Unlike `policy` itself, `authorization` is an **ordinary `KavoSettings`
key** — it merges through the normal `built-in defaults → global → entity →
operation` chain, so it has a global default the way `policy` reaches
through `GlobalConfig.policy` instead. It governs a different question: not
"who may call this," but "what happens when `policy` resolved to nothing at
all, at any scope." With `required: true`, a standard operation with no
resolved policy answers `403 KAVO_FORBIDDEN` instead of running
unrestricted — catching the case where a new operation shipped without
anyone remembering to add a `policy`.

- An operation whose `policy` resolved at any scope is unaffected either
  way — the switch only fills the gap where nothing resolved.
- **Per-call is excluded**, symmetrically: a per-call settings override can
  neither loosen an entity that requires it nor tighten one that doesn't —
  the whole `authorization` subtree is pinned to whatever
  global/entity/operation already resolved.
- **Ordinary custom operations are never gated** — their id is never a
  standard operation id, so they never reach the policy lookup this switch
  extends; their handler reaches `context.principal` directly instead.
- **Kavo-synthesized array-mutation operations (`replace<Relation>` etc.,
  from `relations.edges.<name>.write`) ARE gated**, unlike ordinary custom
  operations — they can never carry a `policy.<id>` entry either, but their
  handler is Kavo's own, not app-authored, so this switch is the only
  authorization hook available for them. There is no per-relation opt-out
  today (an array-mutation id can't be named in `operations.<id>` — it's
  synthesized after that config is resolved); exempt a relation by leaving
  it out of `write`, or turn `authorization.required` off for the entity.
