# Policy

`policy` refuses a request before its handler runs. Each standard operation on an entity can carry a rule that is evaluated against `context.app`, the request's query, and, when the row is available, the row itself; a rule that returns `false` answers 403 with `KAVO_FORBIDDEN`.

```ts
import type { Policy } from "@kavo/core";

// Your app declares what `context.app` holds — see Wiring your own auth.
declare module "@kavo/core" {
  interface KavoAppContext {
    userId?: string;
    roles?: readonly string[];
    permissions?: readonly string[];
  }
}

const isAdmin: Policy<Post> = ({ context }) => (context.app.roles ?? []).includes("admin");
const isAuthenticated: Policy<Post> = ({ context }) => context.app.userId != null;
const isOwner: Policy<Post> = ({ context, entity }) => {
  const { userId } = context.app;
  return userId != null && entity?.authorId === userId;
};

@Kavo(Post, {
  policy: isAuthenticated, // default for every operation on this entity
  operations: {
    findOne: { policy: (args) => isAdmin(args) || isOwner(args) },
    updateOne: {
      policy: (args) => (args.context.app.permissions ?? []).includes("post:update") && isOwner(args),
    },
    findMany: { policy: false }, // explicitly public, opts out of the entity-level default
  },
})
```

That config makes `GET /posts/:id` pass for an `admin` or the row's author, `PUT /posts/:id` require both the `post:update` permission and authorship, and `GET /posts` public despite the entity-level default. `createOne`, `patchOne`, and `deleteOne` have no operation entry, so they fall back to the entity-level `isAuthenticated` default. An operation with no policy at any scope is unrestricted by default, the same opt-in posture every other Kavo default takes. [`authorization.required`](#default-deny-authorization-required) is a separate, genuinely global switch for the opposite question: what happens when nothing was configured at any scope.

## The policy function

`policy` is one function per scope — `(args: PolicyArgs<Entity>) => boolean | Promise<boolean>` — not a combinator DSL. `PolicyArgs` is a single object:

| Field       | What it is                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `context`   | the request's `KavoContext<Entity>` — `context.app`, `context.query`, `context.repository`                     |
| `entity`    | the loaded row, on a single-row operation; `undefined` on `createOne`/`findMany`, where there is no single row |
| `resource`  | `context.entityName` surfaced at the top level                                                                 |
| `operation` | `context.operation` surfaced at the top level                                                                  |
| `params`    | `{ id }` — the request's own single-row target, coerced to the id column's kind, `null` when there isn't one   |

Kavo never inspects, validates, or shapes `context.app` — a policy function reads it however an application's auth layer fills it in. [Wiring your own auth](/guides/wiring-your-own-auth) is what builds `context.app` from the HTTP request. Without it `context.app` is `{}` on every request and a context-reading policy denies everything, and over the GraphQL and MCP bindings it stays `{}` unless a caller passes one per call.

There is no combinator API — `and`/`or`/`not` composition is ordinary `&&`/`||`/`!` inside the function, and reusable checks (an ownership check, a permission check) are just functions that take `PolicyArgs` and get called from a larger one, as `isOwner` does in the intro example's `findOne`/`updateOne`. A policy that needs a value across a relation loads it itself through `context.repository`, the one place a policy can check a value across a relation.

## Config placement

`policy` resolves nearest-scope-wins across three places: `operations.<id>.policy`, then the entity's own `policy` (`EntityConfig.policy` — one function, applied as the default for every operation that configures none of its own), then a root-level default set once at `createKavo({ policy })` (`GlobalConfig.policy`). Whichever scope defines a function wins outright — scopes are never merged, only replaced wholesale — and `operations.<id>.policy: false` opts one operation back out of an inherited entity- or global-scope default, back to unrestricted; that's the only way to spell "no policy here" once a default exists to inherit from, since omitting the key means "inherit," not "none." `EntityConfig.policy`/`GlobalConfig.policy` do not accept `false` themselves — there is nothing above global scope to opt out of.

Like `computed`, `policy` lives outside the settings precedence chain at every scope — it's itself a closure, and `GlobalConfig.defaults` is a `DeepPartial<KavoSettings>`, which would corrupt a function type by partializing it into a non-callable object — so `GlobalConfig.policy` is its own field rather than a `KavoSettings` key inside `defaults`. There is still no per-call override at any scope: a per-call parameter that could loosen a rule would let a caller weaken its own authorization. [Entity config](/guides/configuration/entity-config) covers where the field sits among `@Kavo`'s own keys.

## Default deny (`authorization.required`)

`authorization.required` flips the posture of an operation whose `policy` resolved to nothing at **any** scope — instead of running unrestricted, it answers 403 `KAVO_FORBIDDEN`, so a new operation added without a `policy` at any scope fails loudly at request time rather than shipping unauthenticated by accident (ADR-0035):

```ts
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  defaults: { authorization: { required: true } }, // every entity, every operation
});

@Kavo(Post, {
  authorization: { required: true }, // this entity only
  operations: {
    updateOne: {
      policy: (args) => (args.context.app.permissions ?? []).includes("post:update"),
    },
    findMany: { authorization: { required: false } }, // opt this one operation back out
  },
})
```

Unlike `policy` itself, `authorization` is an ordinary `KavoSettings` key: it merges through the usual `built-in defaults → global → entity → operation` chain, so a global default (`KavoModule.forRoot`'s `defaults`), an entity default, and a per-operation override all compose the way `cache`/`realtime`/every other settings key does — `policy`'s three scopes (above) are resolved by their own nearest-wins walk instead, not `mergeSettings`. `authorization.required` remains a genuinely different mechanism from `policy`, even though both have a global default: it governs _what happens when `policy`'s own fallback chain resolved to nothing at all_ (operation, entity, and global all silent), never overriding a policy that scope chain did resolve — including one an operation opted out of with `policy: false`, which counts as "resolved to nothing" the same as never having configured one.

**Per-call is the one scope excluded.** A per-call `{ settings: { authorization: { required: false } } }` cannot loosen an entity that requires it, and — symmetrically, since the whole subtree is pinned rather than merged — a per-call override cannot tighten an entity that doesn't either. The reasoning is the same as `policy` itself: a per-call parameter able to loosen enforcement would let a caller weaken its own authorization.

An operation whose `policy` resolved from any scope is unaffected by `authorization.required` either way — the switch only fills the gap where no rule resolved at all, it never overrides a resolved one. It also cannot gate an **ordinary custom operation**: a custom operation's id is never a standard operation id, so it never reaches the `policy[operation]` lookup this switch extends — its handler reaches `context.app` directly and refuses a caller on its own terms ([Custom operations](/core/custom-operations)).

It **does** gate a Kavo-synthesized array-mutation operation (`replace<Relation>` and friends, from `relations.edges.<name>.write` — see [Relations](/features/relations#arraymutation)), unlike an ordinary custom operation: that route can never carry a `policy.<id>` entry of its own either, but its handler is Kavo's own, not app-authored code, so there's no other place a check on it could live. There is no per-relation opt-out today — `operations.<id>.authorization` can't target an array-mutation id, since that id is synthesized after the point where `operations.<id>` entries are resolved. To exempt a relation, leave it out of `write`, or turn `authorization.required` off for the whole entity.

## Enforcement

The policy stage runs after the context is built and before preconditions and the cache, so a denied request never learns whether its `If-Match` would have succeeded and a cache hit can never skip the check. On a single-row operation (`findOne`, `updateOne`, `patchOne`, `deleteOne`, `restoreOne`, `purgeOne`) with a resolved policy — from any scope — the engine always loads the row first and hands it to the function as `entity`: a plain function can't be inspected for whether it reads the row, so the engine doesn't try to guess, and pays for the read whenever a policy resolves. No built-in handler fetches the row ahead of mutating by id, so the policy stage loads it, evaluates, and only then lets the handler run; the pre-fetch asks for soft-deleted rows too, because `restoreOne` and `purgeOne` target a deleted row by definition. When the pre-fetch finds no row, the request answers 404 with `KAVO_NOT_FOUND`, never 403: the status code must not leak whether the row exists, ahead of what the policy would have decided. `createOne` and `findMany` have no single row, so their policy always runs with `entity: undefined`.

`findOne` is the exception to the pre-fetch, because it already loads the row as its own result — evaluating its policy earlier would fetch twice. A resolved `findOne` policy always runs after the handler returns, against the row it already fetched, and `findOne` is never cached for an entity with a resolved `findOne` policy: a cache hit would return before that deferred check ran.

A denied request carries the `KAVO_FORBIDDEN` problem-details document (see [Errors](/reference/errors) for the shape). A custom operation's handler can throw `ForbiddenException` for the same status ([Custom operations](/core/custom-operations)); custom operations take no `policy` entry, their handler reaches `context.app` directly.

`policy` decides who may perform an operation; it does not narrow what a caller may see. `findMany` still returns every row its query matches — a policy that reads `context.query.filter` can deny a caller who omitted a scoping filter, but it doesn't add one. A class-based `policy: PostPolicy` form and a query-scope generator that rewrites the filter AST from a policy remain deferred ([ADR-0037](/internals/adr/0037-policy-collapses-to-a-single-predicate), which also argues the enforcement choices above; [ADR-0035](/internals/adr/0035-authorization-required-default-deny-switch) covers `authorization.required`); [System architecture](/internals/architecture/01-system-architecture) shows where the policy stage sits in the request pipeline.

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

Registered with `APP_GUARD`, that is an app-wide CASL/Casbin/audit seam that knows the resource and the action for every request, the Kavo routes' _operation id_ (`updateOne`, a custom operation's id, `replaceTags`) rather than just an HTTP method. This complements the `policy` config above rather than replacing it: `policy` runs inside Kavo's request pipeline and denies a request before its handler, while the guard runs earlier, still before the controller method, in the host framework's own chain. Kavo makes no authorization decision of its own either way; the guard's `.can()` call is application code just like a `policy` function. The `user` the guard reads is the same property [Wiring your own auth](/guides/wiring-your-own-auth) builds `KavoContext.app` from.
