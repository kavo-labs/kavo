# Entity config

`@Kavo(Entity, config)` accepts every settings field from [Settings](/guides/configuration/settings) one level above global, plus fields that only make sense per entity: `dto`, `allowlists` (see [Allowlists](/features/allowlists)), `computed` (see [Computed fields](/features/computed-fields)), `policy` (below, an entity-wide default), and `operations` (its own page, see [Operations](/guides/configuration/operations#operations-1)) — which is also where `policy` may be overridden per operation.

## dto

Registers DTO classes per slot. Every slot is independently optional and falls back to an entity-derived default when omitted:

```ts
@Kavo(Book, {
  dto: {
    create: CreateBookDto,
    update: UpdateBookDto,
    item: BookItemDto,
    list: BookListDto,
  },
})
```

| Slot     | Default when omitted                                |
| -------- | --------------------------------------------------- |
| `create` | Entity's own shape, minus generated/relation fields |
| `update` | Same default as `create`                            |
| `patch`  | `Partial<update>` if set, else `Partial<Entity>`    |
| `query`  | Generic `QueryContext<Entity>`                      |
| `item`   | Entity, subject to field selection                  |
| `list`   | Same as `item`'s resolved type                      |

There's no `patch` DTO class to write on its own; it derives from `update`. See [DTO system](/internals/architecture/04-dto-system) for full derivation rules.

## allowlists and computed

Moved to [Allowlists](/features/allowlists) and [Computed fields](/features/computed-fields).

## policy

Authorization (ADR-0037), resolved nearest-scope-wins across `operations.<id>.policy`, the entity's own `policy` (one default function, applied to every operation that configures none of its own), and a root-level `createKavo({ policy })` default. An operation with no policy at any of the three scopes runs unrestricted:

```ts
import type { Policy } from "@kavo/core";

// `context.app` is typed by the interface your app declares — see Wiring your own auth.
function hasPermission(name: string): Policy<Post> {
  return ({ context }) => (context.app.permissions ?? []).includes(name);
}

const isOwner: Policy<Post> = ({ context, entity }) => {
  const { userId } = context.app;
  return userId != null && entity?.authorId === userId;
};

@Kavo(Post, {
  policy: hasPermission("post:read"), // default for every operation on this entity
  operations: {
    // Naming any operation here makes `operations` an exclusive whitelist
    // (see [Operations](/guides/configuration/operations)) — a real config
    // would also name createOne/findOne/patchOne/restoreOne/purgeOne to
    // keep them on.
    updateOne: { policy: (args) => hasPermission("post:update")(args) && isOwner(args) }, // overrides the default
    deleteOne: { policy: (args) => hasPermission("post:delete")(args) && hasPermission("admin")(args) }, // every name required
    findMany: { policy: false }, // explicitly public, opts out of the entity-level default
  },
})
```

A single-row operation (`findOne`/`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne`) with a resolved policy always gets the loaded row as `entity`, whether the policy is declared on the operation directly or inherited from an entity/global default; `createOne`/`findMany` always call the policy with `entity: undefined`, since neither has a single row to load. See [Policy](/features/policy) for the full shape, the scope-resolution rules, and how the stage behaves, and [Wiring your own auth](/guides/wiring-your-own-auth) for building `context.app` and typing it.
