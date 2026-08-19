# Policy

`policy` refuses a request before its handler runs. Each standard operation on an entity can carry a rule that is evaluated against `context.principal` and, when the rule needs it, the row itself, and a rule that fails answers 403 with `KAVO_FORBIDDEN`.

```ts
import { and, authenticated, or, owner, permission, role } from "@kavo/core";

@Kavo(Post, {
  policy: {
    createOne: authenticated(),
    findMany: ["post:read"],
    findOne: or(role("admin"), owner("authorId")),
    updateOne: and(permission("post:update"), owner("authorId")),
  },
})
```

That config makes `POST /posts` require a signed-in caller, `GET /posts` require the `post:read` permission, `GET /posts/:id` pass for an `admin` or the row's author, and `PUT /posts/:id` require both the `post:update` permission and authorship. `patchOne` and `deleteOne` have no entry, so they run for any caller: an operation with no `policy.<id>` is unrestricted, the same opt-in posture every other Kavo default takes, and adding an entry is how an entity opts in rather than a global switch to flip.

The array shorthand is `and(...names.map(permission))`: `["post:read"]` is a bare `permission("post:read")` node, and `["post:delete", "admin"]` requires both names. An empty array is a bootstrap error instead of a vacuous `and()`: an empty conjunction is `true` by definition, so `policy: { updateOne: [] }` would read as lockdown and behave as "allow everyone".

## Node types

| Node                                | Passes when                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `permission(name)`                  | `principal.permissions` contains `name`                                                |
| `role(name)`                        | `principal.roles` contains `name`                                                      |
| `authenticated()`                   | `principal.userId` is set                                                              |
| `owner(field = "userId")`           | the row's `field` equals `principal.userId`; `owner("author.id")` walks a nested value |
| `filtered(field)`                   | `context.query.filter` carries a condition on `field`, anywhere in the AST             |
| `when((context, entity?) => ...)`   | the predicate returns `true`                                                           |
| `and(...)` / `or(...)` / `not(...)` | short-circuit composition; `not` negates its single child                              |

Every built-in node reads `context.principal` cast to a `KavoPrincipal` shape: optional `userId`, `roles`, and `permissions`, plus an index signature, so a principal can carry `tenantId`, `plan`, or any other field the built-in nodes never read. Kavo itself never inspects, validates, or shapes `principal`; using a built-in node is what an application opts into, and `when()` reads the raw value however it likes. [Wiring your own auth](/guides/wiring-your-own-auth) is what moves the caller from the HTTP request onto `context.principal`. Without it `principal` is `null` on every request and a built-in node denies everything, and over the GraphQL and MCP bindings it stays `null` unless a caller passes one per call.

## Config placement

`policy` is entity-scope config on `@Kavo(Entity, config)`, keyed by standard operation id. `operations.<id>.policy` overrides the entity-level entry for that operation, the same fallback `dto` uses. There is no global `policy` and no per-call override: like `computed`, a `when()` predicate carries a closure, so the key lives outside the settings precedence chain, and a per-call parameter that could loosen a rule would let a caller weaken its own authorization. [Entity config](/guides/configuration/entity-config) lists the field among `@Kavo`'s own keys.

`filtered(field)` reads `context.query.filter` rather than the loaded row, so — unlike `owner`/`when` — it is not entity-aware and carries no restriction on which operations may use it. It is only meaningful on read operations: `context.query` is `null` on a write, so `filtered` denies unconditionally there rather than throwing. Use it to force a list request to scope itself, e.g. `policy: { findMany: filtered("userId") }` 403s a `GET /posts` whose query omits a `userId` filter. Like `policy` generally, `filtered` gates whether the operation runs at all — it is not row-scoping: a caller who supplies `userId` still sees whatever rows that filter matches, not only their own, so pair it with `owner`/`when` (or an application-level default filter) if the requirement is "only your own rows," not just "some `userId` filter is present."

## Entity-aware nodes

`owner` and `when` need the loaded row; `permission`, `role`, and `authenticated` do not. The row-needing nodes are legal only on the single-row operations (`findOne`, `updateOne`, `patchOne`, `deleteOne`, `restoreOne`, `purgeOne`). `createOne` has no row yet and `findMany` resolves a set of rows, so an entity-aware node configured on either is a bootstrap `ConfigurationException` that names the entity and the `policy.<id>` path, caught before the config is frozen rather than surfacing as a silent allow or deny. An `owner` field whose first dotted segment names a relation is the same error: the policy stage's pre-fetch loads no relations, so `owner("author.id")` could never pass and fails at startup instead of denying every caller at runtime. To check a value across a relation, use `when()`, which receives `context` and can load the relation itself through `context.repository`.

## Enforcement

The policy stage runs after the context is built and before preconditions and the cache, so a denied request never learns whether its `If-Match` would have succeeded and a cache hit can never skip the check. A context-only rule costs a lookup plus a boolean evaluation. A row-needing rule on a write costs one extra read: no built-in handler fetches the row ahead of mutating by id, so the stage loads it, evaluates, and only then lets the handler run. The pre-fetch asks for soft-deleted rows too, because `restoreOne` and `purgeOne` target a deleted row by definition. When the pre-fetch finds no row, the request answers 404 with `KAVO_NOT_FOUND`, never 403: the status code must not leak whether the row exists.

`findOne` is the exception to the pre-fetch, because it already loads the row as its own result. A context-only rule on `findOne` runs before the cache read like every other operation. A row-needing rule runs after the handler returns, against the row it fetched, and `findOne` is not cached for an entity whose `findOne` rule needs the row: a cache hit would return before that deferred check ran.

A denied request carries the `KAVO_FORBIDDEN` problem-details document (see [Errors](/reference/errors) for the shape). A custom operation's handler can throw `ForbiddenException` for the same status ([Custom operations](/core/custom-operations)); custom operations take no `policy` entry, their handler reaches `context.principal` directly.

`policy` decides who may perform an operation; it does not scope what a caller may see. `findMany` still returns every row its query matches: row-scoping filters are a separate, deferred design, and so is a class-based `policy: PostPolicy` form. Both are recorded rather than built in [ADR-0032](/internals/adr/0032-policy-authorization-dsl), which also argues the enforcement choices above; [System architecture](/internals/architecture/01-system-architecture) shows where the policy stage sits in the request pipeline.
