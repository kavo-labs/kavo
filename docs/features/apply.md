# Apply

`apply` is a mandatory, context-dependent constraint evaluated on every request and composed with whatever the client itself supplied, never replaced by it. It's the seam for row scoping: user ownership, tenant isolation, published-only records, and similar server-side restrictions that must hold regardless of what a caller asks for. It comes in two forms: one on each of the four query axes — `filter`, `sort`, `select`, `include` ([ADR-0048](/internals/adr/0048-apply-server-side-query-constraint)) — and one on `create`/`update`, forcing values into the write body itself ([ADR-0049](/internals/adr/0049-write-apply-forces-create-update-body-values)).

```ts
import type { FilterApply } from "@kavo/core";

declare module "@kavo/core" {
  interface KavoAppContext {
    userId?: string;
  }
}

const ownRowsOnly: FilterApply<Post> = ({ context }) => {
  const { userId } = context.app;
  if (userId === undefined) {
    return undefined; // no additional constraint
  }
  return { kind: "condition", field: "authorId", operator: "EQ", value: userId };
};

@Kavo(Post, {
  filter: {
    fields: ["id", "title", "status"],
    apply: ownRowsOnly,
  },
})
```

With that config, `GET /posts?filter[status][eq]=published` runs as if the caller had written `authorId = <the caller's own id> AND status = 'published'`. The client's own filter narrows further inside that `AND` — it can never widen past `apply`'s branch, remove it, or ask for another caller's `authorId` to escape it.

## `apply` is not `default`

`sort.default`/`select.default`/`include.default` answer "what does a request that supplied nothing on this axis get" — a client-supplied value on that axis replaces the default outright, no composition. `apply` answers a different question: "what does **every** request get, regardless of what it supplied." It composes with a client value rather than being replaced by one, and (for `filter`) it composes even when the client sent nothing at all. There is no `filter.default` today — only `apply` — because a filter has no natural "value when absent" the way a sort order or a projection does.

| Key                | Runs when the client sends nothing | Runs when the client sends its own value | Can the client override it   |
| ------------------ | ---------------------------------- | ---------------------------------------- | ---------------------------- |
| `sort.default`     | yes                                | no — replaced                            | yes, by supplying `sort=`    |
| `select.default`   | yes                                | no — replaced                            | yes, by supplying `select=`  |
| `include.default`  | yes                                | no — replaced                            | yes, by supplying `include=` |
| `apply` (any axis) | yes                                | yes — composed                           | no                           |

## The four axes

Each lives next to that axis's own `fields`/`limits`/`default`, and returns that axis's own existing shape — never a new predicate DSL:

- **`filter.apply`** — `(args) => FilterExpression<Entity> | undefined`. `AND`ed into the client's own parsed filter as an explicit group node (`{ kind: "group", operator: "AND", children: [client, apply] }`), never a shallow merge by field name — the reason a same-named client condition can only narrow, never override. Also enforced on every single-row write by id (see below), and on `findMany`'s `total` count, since that query shares the same composed filter.
- **`sort.apply`** — `(args) => readonly Sort<Entity>[] | undefined`. Prepended ahead of the client's own `sort=` (or `sort.default`); a field it names is deduplicated out of its own later position rather than sorted on twice.
- **`select.apply`** — `(args) => readonly FieldPath<Entity, 1>[] | undefined`. Fields are force-included in the projection, unioned into whatever the request would otherwise project — additive only, never a mask. A `null`/unconfigured projection already means "everything", so a forced field there is a no-op.
- **`include.apply`** — `(args) => readonly IncludePath<Entity, 1>[] | undefined`. Relation paths are unioned into the client's own `include=` before resolution, so a forced path is validated (allowlist, depth/breadth limits) exactly like any client-requested one.

Every one of the four is optional independently — configure only the axes you need. `undefined` (including a function that returns nothing on some branches) means "no additional constraint this time"; there's no need to return an empty value on every branch of a conditional:

```ts
filter: {
  apply: ({ context }) => {
    if (context.app.isAdmin) {
      return undefined; // admins see everything
    }
    return { kind: "condition", field: "organizationId", operator: "EQ", value: context.app.organizationId };
  },
},
```

## The `apply` function

Every axis's `apply` takes the same argument, `ApplyArgs<Entity>` — a `PolicyArgs<Entity>` (the same object [`policy`](/features/policy) takes) with `entity` removed:

| Field       | What it is                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context`   | the request's `KavoContext<Entity>` — `context.app`, `context.repository`; `context.query` is `null` here, since `apply` is what produces the query |
| `resource`  | `context.entityName` surfaced at the top level                                                                                                      |
| `operation` | `context.operation` surfaced at the top level                                                                                                       |
| `params`    | `{ id }` — the request's own single-row target, coerced to the id column's kind, `null` when there isn't one                                        |

`entity` is never available, on any axis, unlike `policy`. On a read that's simply because `apply` runs before the query it shapes exists. On a single-row write it's structural: `filter.apply`'s result has to shape the very id lookup that would produce the row, so the row cannot be handed to the function that determines whether it's ever found.

If `apply` throws, the throw is not swallowed — it goes through the same error pipeline an ordinary handler failure does ([Errors](/reference/errors)).

## Config placement

`filter`/`sort`/`select`/`include` are entity-scope-only config — there's no `operations.<id>.filter` to hang a per-operation `apply` on, so `apply` runs identically for every standard operation that touches its axis. There is no global (`createKavo({ ... })`) scope either. (`policy` started the same way — one function, no scopes — and grew them later once the need was concrete; `apply` can follow if a per-operation override turns out to matter.)

## Enforcement on reads

A read (`findMany`, `findOne`) already runs its query through `QueryNormalizer`, so all four `apply` results compose into the very `NormalizedQueryContext` the client's request becomes, before the adapter ever sees it. `findOne`'s own row lookup then inherits the composed filter automatically — a row outside `filter.apply`'s constraint answers `404 KAVO_NOT_FOUND`, the same as an id that never existed, not `403`: existence never leaks ahead of the constraint.

## Enforcement on writes

`updateOne`, `patchOne`, `deleteOne`, `restoreOne`, and `purgeOne` mutate by id alone — they never run `QueryNormalizer`. Whenever `filter.apply` is configured, the engine's own pre-fetch-by-id (the same one that already runs for a configured `policy`, to hand it the loaded row) folds `filter.apply`'s result into that lookup. A row outside the constraint is never found, so the operation answers `404` before any policy or handler runs — an `updateOne`/`deleteOne` cannot affect, or reveal the existence of, a row outside scope. `sort.apply`/`select.apply`/`include.apply` have no meaning on a write and are not consulted there.

## Examples

**User-owned records:**

```ts
filter: {
  apply: ({ context }) => ({ kind: "condition", field: "userId", operator: "EQ", value: context.app.userId }),
},
```

**Multi-tenant records:**

```ts
filter: {
  apply: ({ context }) => ({ kind: "condition", field: "tenantId", operator: "EQ", value: context.app.tenantId }),
},
```

**Conditional application:**

```ts
filter: {
  apply: ({ context }) => {
    if (context.app.isAdmin) {
      return undefined;
    }
    return { kind: "condition", field: "organizationId", operator: "EQ", value: context.app.organizationId };
  },
},
```

## Writing forced values: `create.apply`/`update.apply`

The four query axes above scope which rows a request may read or reach by id — they say nothing about the values a `createOne`/`updateOne` body may set. A tenant-scoped entity with `filter.apply` restricting every read and existing-row write to `tenantId = context.app.tenantId` still lets a client `POST` a body naming a different `tenantId` outright, since there's no existing row for `filter.apply` to scope on `createOne`. `create.apply`/`update.apply` close that gap, living next to `create`/`update`'s own `default`:

```ts
@Kavo(Order, {
  create: {
    apply: ({ context }) => ({ tenantId: context.app.tenantId }),
  },
  update: {
    apply: ({ context }) => ({ tenantId: context.app.tenantId }),
  },
})
```

Same `ApplyArgs<Entity>` argument every other `apply` takes; the return shape is `Partial<Entity> | undefined` instead of a query-axis type. Composition is the write-side version of the same rule: a forced field **overwrites** whatever the client sent for it, the opposite of `default`, which only fills a field the client omitted. Configuring both `default` and `apply` for the same field is legal — `apply` wins, since it's the unconditional constraint and `default` only a fallback for an absent value.

Scope matches `default`'s own: `create.apply` runs on `createOne`, `update.apply` on `updateOne` only — never `patchOne`, whose omitting a field means "leave it unchanged" rather than "reset it," the same reasoning that already keeps `update.default` off `patchOne`.

## Non-goals

`apply` never sees or grants a `role`, `userId`, `tenantId`, or similar — Kavo stays framework- and authentication-agnostic. Those are exactly the fields your own [`KavoAppContext` declaration](/guides/wiring-your-own-auth) exists for; `apply` only ever reaches them through `context.app`, the same way `policy` does.

`select.apply` only ever **adds** fields to the projection — it is not a per-caller field-masking mechanism (hiding a column from some callers while showing it to others). That's a materially different feature, deliberately out of scope here; see [ADR-0048](/internals/adr/0048-apply-server-side-query-constraint#non-goals).
