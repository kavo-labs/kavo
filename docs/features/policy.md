# Policy

`policy` refuses a request before its handler runs. Each standard operation on an entity can carry a rule that is evaluated against `context.principal`, the request's query, and, when the rule needs it, the row itself; a rule that fails answers 403 with `KAVO_FORBIDDEN`.

```ts
import { and, authenticated, filtered, or, owner, permission, role } from "@kavo/core";

@Kavo(Post, {
  operations: {
    createOne: { policy: authenticated() },
    findMany: { policy: or(role("admin"), and(authenticated(), filtered("userId"))) },
    findOne: { policy: or(role("admin"), owner("authorId")) },
    updateOne: { policy: and(permission("post:update"), owner("authorId")) },
  },
})
```

That config makes `POST /posts` require a signed-in caller, `GET /posts` pass for an `admin` or a signed-in caller whose query filters `userId`, `GET /posts/:id` pass for an `admin` or the row's author, and `PUT /posts/:id` require both the `post:update` permission and authorship. `patchOne` and `deleteOne` have no entry, so they run for any caller: an operation with no `policy` is unrestricted, the same opt-in posture every other Kavo default takes, and adding an entry is how an operation opts in rather than a global switch to flip.

## Node types

| Node                                                              | Passes when                                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `permission(name)`                                                | `principal.permissions` contains `name`                                                                        |
| `role(name)`                                                      | `principal.roles` contains `name`                                                                              |
| `authenticated()`                                                 | `principal.userId` is set                                                                                      |
| `filtered(field)`                                                 | `context.query.filter` carries a condition on `field`, anywhere in the AST (`context.query` is null on writes) |
| `owner(field = "userId")`                                         | the row's `field` equals `principal.userId`; `owner("author.id")` walks a nested value                         |
| `when(({ context, entity, resource, operation, params }) => ...)` | the predicate returns `true`                                                                                   |
| `and(...)` / `or(...)` / `not(...)`                               | short-circuit composition; `not` negates its single child                                                      |

The `permission`, `role`, `owner`, and `authenticated` nodes cast `context.principal` to a `KavoPrincipal` shape: optional `userId`, `roles`, and `permissions`, plus an index signature, so a principal can carry `tenantId`, `plan`, or any other field the built-in nodes never read. Kavo itself never inspects, validates, or shapes `principal`; using a built-in node is what an application opts into, and `when()` reads the raw value however it likes. `filtered()` reads the request's query filter instead (below). [Wiring your own auth](/guides/wiring-your-own-auth) is what moves the caller from the HTTP request onto `context.principal`. Without it `principal` is `null` on every request and a principal-reading node denies everything, and over the GraphQL and MCP bindings it stays `null` unless a caller passes one per call.

## permission

`permission(name)` passes when `principal.permissions` contains `name`, a plain application-defined string (`post:update`, `owner:delete`). It reads no row, so it is legal on every operation, `createOne` and `findMany` included. Require more than one permission with `and(permission("post:delete"), permission("admin"))`.

## role

`role(name)` passes when `principal.roles` contains `name`, reading the same `KavoPrincipal` shape as `permission` with the same context-only posture. It is the usual bypass arm of an `or()`: in the intro example `role("admin")` lets `GET /posts/:id` through regardless of authorship and lets `GET /posts` through without the `userId` filter.

## authenticated

`authenticated()` passes when `principal.userId` is set: the signed-in gate. Nothing in Kavo fills it, so a principal that keeps its identity under another field (a session id, an email) does not pass this node and reaches for `when()`. It is context-only and legal on every operation; the intro example's `createOne: authenticated()` gates `POST /posts` to signed-in callers without loading a row.

## filtered

`filtered(field)` passes when the request's query filter carries a condition on `field` anywhere in the filter AST, and fails with 403 otherwise. On a write `context.query` doesn't exist, so it denies unconditionally there rather than throwing. It reads no row, so like `permission`/`role`/`authenticated` it is legal on `createOne` and `findMany`. In the config above, `GET /posts` passes for an `admin`, or for a signed-in caller whose query filters `userId` (`GET /posts?filter[userId][eq]=u-1`). A signed-in caller who omits the filter gets 403, not every row, and a guest gets 403 either way. `filtered` requires the filter, it doesn't add one: the request still runs exactly the query the caller sent, so this is a denial on top of ordinary filtering, not a row-scope the engine applies. It also checks presence, not value: `filter[userId][eq]=someone-else` passes a signed-in caller, because the field is there. When the requirement is "only your own rows" rather than "some `userId` filter is present", compose `owner`/`when` on a single-row operation, or apply a default scope in application code on `findMany`.

## owner

`owner(field = "userId")` passes when the loaded row's `field` equals `principal.userId`. The default field is `userId`; pass the column that holds the row's owner, as `owner("authorId")` does in the intro example. A dotted path addresses a nested value (`owner("address.city")`), but its first segment must be an embedded field, not a relation: the policy stage's pre-fetch loads no relations, so a crossing path is a bootstrap error rather than a runtime always-deny (see [Entity-aware nodes](#entity-aware-nodes)). It needs both a row and a principal, and it is the entity-aware half of the example's `updateOne`: the caller needs the `post:update` permission and the row's author.

## when

`when(({ context, entity, resource, operation, params }) => ...)` is the escape hatch for a check the other nodes can't express. The predicate returns a boolean or a promise and is called with a single object: `context` and `entity` (the row, when the node needs one) as before, plus `resource` and `operation` — `context.entityName`/`context.operation` surfaced at the top level so a predicate doesn't have to reach through `context` for them — and `params.id`, the request's own single-row target (`null` for an operation with none, e.g. `createOne`/`findMany`), which `context` never carries at all. `params` deliberately has no `query`: over HTTP `context.query` is already the normalized query, and the raw request-level value has no one stable shape across transports, so a predicate that wants the query reads `context.query` instead. The predicate can read `context.principal` however it likes, inspect `context.query`, or load a relation itself through `context.repository`, the one place a policy can check a value across a relation. Because it holds a closure it is the one node that is not inspectable data, which is why `policy` lives outside the settings chain with no per-call override ([Config placement](#config-placement)). It is entity-aware, with the same operation constraints and pre-fetch cost as `owner`.

## and, or, not

`and(...)` passes when every child passes, `or(...)` when any child passes, and `not(child)` inverts its single child; `and` stops at the first failure and `or` at the first success. Composition propagates entity-awareness: a subtree that contains `owner`/`when` needs the row even when a sibling doesn't. The intro example shows both shapes at once, the admin bypass in `findOne`'s `or(...)` and the required conjunction in `updateOne`'s `and(...)`. A zero-child `and()` is vacuously `true` — every empty conjunction is — so `policy: and()` reads like a lockdown and behaves as "allow everyone"; name at least one child, or omit `policy` entirely for the same unrestricted result without the trap.

## Config placement

`policy` is set per operation, at `operations.<id>.policy` (ADR-0032, amended by ADR-0033) — there is no entity-scope `policy` map to fall back to; an entity that still passes a root-level `policy` map gets a bootstrap error naming the new location. There is no global `policy` and no per-call override either: like `computed`, a `when()` predicate carries a closure, so the key lives outside the settings precedence chain, and a per-call parameter that could loosen a rule would let a caller weaken its own authorization. [Entity config](/guides/configuration/entity-config) covers where the field sits among `@Kavo`'s own keys.

## Entity-aware nodes

`owner` and `when` need the loaded row; `permission`, `role`, `authenticated`, and `filtered` do not. The row-needing nodes are legal only on the single-row operations (`findOne`, `updateOne`, `patchOne`, `deleteOne`, `restoreOne`, `purgeOne`). `createOne` has no row yet and `findMany` resolves a set of rows, so an entity-aware node configured on either is a bootstrap `ConfigurationException` that names the entity and the `operations.<id>.policy` path, caught before the config is frozen rather than surfacing as a silent allow or deny. An `owner` field whose first dotted segment names a relation is the same error: the policy stage's pre-fetch loads no relations, so `owner("author.id")` could never pass and fails at startup instead of denying every caller at runtime.

## Enforcement

The policy stage runs after the context is built and before preconditions and the cache, so a denied request never learns whether its `If-Match` would have succeeded and a cache hit can never skip the check. A context-only rule costs a lookup plus a boolean evaluation. A row-needing rule on a write costs one extra read: no built-in handler fetches the row ahead of mutating by id, so the stage loads it, evaluates, and only then lets the handler run. The pre-fetch asks for soft-deleted rows too, because `restoreOne` and `purgeOne` target a deleted row by definition. When the pre-fetch finds no row, the request answers 404 with `KAVO_NOT_FOUND`, never 403: the status code must not leak whether the row exists.

`findOne` is the exception to the pre-fetch, because it already loads the row as its own result. A context-only rule on `findOne` runs before the cache read like every other operation. A row-needing rule runs after the handler returns, against the row it fetched, and `findOne` is not cached for an entity whose `findOne` rule needs the row: a cache hit would return before that deferred check ran.

A denied request carries the `KAVO_FORBIDDEN` problem-details document (see [Errors](/reference/errors) for the shape). A custom operation's handler can throw `ForbiddenException` for the same status ([Custom operations](/core/custom-operations)); custom operations take no `policy` entry, their handler reaches `context.principal` directly.

`policy` decides who may perform an operation; it does not narrow what a caller may see. `findMany` still returns every row its query matches: `filtered()` refuses a caller who omits a scoping filter, it doesn't add one. A class-based `policy: PostPolicy` form and a query-scope generator that rewrites the filter AST from a policy remain deferred ([ADR-0032](/internals/adr/0032-policy-authorization-dsl), which also argues the enforcement choices above); [System architecture](/internals/architecture/01-system-architecture) shows where the policy stage sits in the request pipeline.

## Route identity from a Nest guard

`getResource(context)` and `getOperation(context)` (`@kavo/nest`) tell a Nest `Guard`, or any other `ExecutionContext` holder (an `Interceptor`, a `Reflector`-based decorator), which entity and which CRUD operation a pending request targets, without re-deriving either from the URL and HTTP method. Both are read-only identity accessors: a non-Kavo route answers `undefined`, and neither decides anything on its own.

`getResource` returns the entity name behind `@Kavo(Entity)` (the `"Post"` of `@Kavo(Post)`), read from the class-level metadata the decorator writes. `getOperation` returns the route's `OperationId`, written per method by the same wiring that generates the route, so a generated, an `@Override`'d, and a synthesized `replace<Relation>`/`list<Relation>` sub-collection route all carry one. The two are `KavoContext.entityName`/`KavoContext.operation` made readable before the engine runs: a guard fires ahead of the controller method, the point where Kavo builds its context. A service-only operation (`meta.routes.enabled: false`) generates no route, so there is nothing to intercept, and a manual-method-wins method likewise carries no metadata.

A guard built on them bolts Kavo onto an app-wide authorization layer without moving anything into `policy`:

```ts
import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { getOperation, getResource } from "@kavo/nest";

@Injectable()
export class CaslGuard implements CanActivate {
  constructor(private readonly abilities: AbilityFactory) {}

  canActivate(context: ExecutionContext): boolean {
    const resource = getResource(context);
    const operation = getOperation(context);
    if (resource === undefined || operation === undefined) return true;
    const { user } = context.switchToHttp().getRequest();
    return this.abilities.forUser(user).can(operation, resource);
  }
}
```

Registered with `APP_GUARD`, that is an app-wide CASL/Casbin/audit seam that knows the resource and the action for every request, the Kavo routes' _operation id_ (`updateOne`, a custom operation's id, `replaceTags`) rather than just an HTTP method. This complements the `policy` config above rather than replacing it: `policy` and ADR-0032's `PolicyNode` engine run inside Kavo's request pipeline and deny a request before its handler, while the guard runs earlier, still before the controller method, in the host framework's own chain. Kavo makes no authorization decision of its own either way; the guard's `.can()` call is application code just like a `policy` rule. The `user` the guard reads is the same property [Wiring your own auth](/guides/wiring-your-own-auth) moves onto `KavoContext.principal`.
