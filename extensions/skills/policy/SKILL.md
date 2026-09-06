---
name: policy
description: Reference for Kavo's policy authorization DSL — permission()/role()/owner()/authenticated()/filtered()/when() composed with and()/or()/not(), config placement, entity-aware nodes, and enforcement order. Use when gating an operation on the caller (403 KAVO_FORBIDDEN), requiring an authenticated principal, checking row ownership, or requiring a query filter to be present.
---

# Policy authorization reference

`policy` refuses a request before its handler runs. Each standard operation
on an entity can carry a rule evaluated against `context.principal` and,
when the rule needs it, the loaded row — a rule that fails answers `403`
with `KAVO_FORBIDDEN`. Full detail: `docs/features/policy.md` and
[ADR-0032](https://github.com/kavo-labs/kavo/blob/main/docs/internals/adr/0032-policy-authorization-dsl.md)/[ADR-0033](https://github.com/kavo-labs/kavo/blob/main/docs/internals/adr/0033-policy-moves-to-operation-scope-only.md).
Wiring `context.principal` itself is the `global-config`/`kavo-decorator`
skills' territory (an app's own auth layer) — `policy` only ever reads it.

## Config shape

```ts
import { and, authenticated, filtered, or, owner, permission, role } from "@kavo/core";

@Kavo(Post, {
  operations: {
    createOne: { policy: authenticated() },
    findMany: { policy: permission("post:read") },
    findOne: { policy: or(role("admin"), owner("authorId")) },
    updateOne: { policy: and(permission("post:update"), owner("authorId")) },
  },
})
```

`policy` is set per operation, at `operations.<id>.policy` — there is no
entity-scope `policy` map (ADR-0033; a leftover root-level `policy` map
fails at bootstrap, naming this path as the replacement). An operation with
no `policy` entry is **unrestricted** — opt-in per operation, not a global
switch. `policy` takes a `PolicyNode` only — build multi-permission checks
with `and(permission("a"), permission("b"))` (ADR-0032, amended by #242: the
array shorthand was removed since the DSL already covers everything it
could express).

## Node types

| Node                                                              | Passes when                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `permission(name)`                                                | `principal.permissions` contains `name`                                                |
| `role(name)`                                                      | `principal.roles` contains `name`                                                      |
| `authenticated()`                                                 | `principal.userId` is set                                                              |
| `owner(field = "userId")`                                         | the row's `field` equals `principal.userId`; `owner("author.id")` walks a nested value |
| `filtered(field)`                                                 | `context.query.filter` carries a condition on `field`, anywhere in the AST             |
| `when(({ context, entity, resource, operation, params }) => ...)` | the predicate returns `true` — escape hatch for anything else                          |
| `and(...)` / `or(...)` / `not(...)`                               | short-circuit composition; `not` negates its single child                              |

Every built-in node except `filtered`/`when` reads `context.principal` cast
to `{ userId?, roles?, permissions?, [k: string]: unknown }`. Kavo never
inspects or shapes `principal` itself — a `null` principal (no auth wired
yet) makes every built-in node except `filtered` deny.

### `filtered(field)` — require a query filter, not a principal check

```ts
@Kavo(Post, {
  operations: { findMany: { policy: and(authenticated(), filtered("userId")) } },
})
```

`GET /posts?filter[userId][eq]=u-1` passes; a bare `GET /posts` 403s. Unlike
every other built-in, `filtered` reads `context.query`, not `principal` —
it is context-only (not entity-aware), so it is legal on `createOne` and
`findMany` where `owner`/`when` are rejected at bootstrap. `context.query`
is `null` on writes, so `filtered` denies unconditionally there rather than
throwing — it's meant for reads.

`filtered` gates whether the operation runs at all; it is **not**
row-scoping. A caller who supplies `userId` still sees every row that
filter matches, not only their own — pair it with `owner`/`when` (or an
app-level default filter you add yourself) when the requirement is "only
your own rows," not just "some filter is present."

### `owner`/`when` — entity-aware, single-row operations only

`owner` and `when` need the loaded row, so they're legal only on
`findOne`, `updateOne`, `patchOne`, `deleteOne`, `restoreOne`, `purgeOne`.
Configuring either on `createOne` (no row yet) or `findMany` (a set, not
one row) is a bootstrap `ConfigurationException` naming the entity and the
`operations.<id>.policy` path. An `owner(field)` whose first dotted segment names a
relation (`owner("author.id")`) is the same error — the pre-fetch loads no
relations, so it could never pass.

`when()` is the one node that can reach a relation itself, through
`context.repository`, since its predicate runs with the full context.

## Enforcement order

The policy stage runs after context is built, before preconditions and the
cache — a denied request never learns whether its `If-Match` would have
succeeded. A context-only rule (`permission`/`role`/`authenticated`/
`filtered`) costs a lookup plus a boolean check. A row-needing rule on a
write costs one extra read: the stage pre-fetches the row (including
soft-deleted, since `restoreOne`/`purgeOne` target a deleted row by
definition) before the handler runs. **No row found → 404, never 403** —
the status code must not leak whether the row exists.

`findOne` is the exception to the pre-fetch: it already loads the row as
its own result, so a row-needing rule runs _after_ the handler, against
what it fetched — and an entity whose `findOne` rule needs the row is
never cached, so a cache hit can't skip the deferred check.

## What policy does not do

- **No row-scoping.** `findMany` still returns every row its query
  matches; `policy` decides _whether_ the call runs, not what a passing
  call sees.
- **No global or per-call policy.** Unlike ordinary `KavoSettings`, `policy`
  lives outside the precedence chain — no global default, and no per-call
  override (a per-call parameter that could loosen a rule would let a
  caller weaken its own authorization).
- **Custom operations get no `policy` entry** — their handler reaches
  `context.principal` directly and throws `ForbiddenException` for the same
  `403 KAVO_FORBIDDEN`.
