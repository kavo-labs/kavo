# Entity config

`@Kavo(Entity, config)` accepts every settings field from [Settings](/guides/configuration/settings) one level above global, plus four fields that only make sense per entity: `dto`, `allowlists` (see [Allowlists](/features/allowlists)), `computed` (see [Computed fields](/features/computed-fields)), and `operations` (its own page, see [Operations](/guides/configuration/operations#operations-1)) — which is also where `policy` (below) is configured, per operation.

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

Authorization, set per operation at `operations.<id>.policy` (ADR-0032, ADR-0033). An operation with no `policy` runs unrestricted:

```ts
import { and, owner, permission } from "@kavo/core";

@Kavo(Post, {
  operations: {
    updateOne: { policy: and(permission("post:update"), owner("authorId")) },
    deleteOne: { policy: ["post:delete", "admin"] }, // array shorthand: every name required
  },
})
```

`owner`/`when` need the loaded row, so they're only legal on the single-row operations (`findOne`/`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne`) — configuring either on `createOne`/`findMany` is a bootstrap error. There is no entity-scope `policy` map to fall back to — `operations.<id>.policy` is the only place a policy is declared. See [Policy](/features/policy) for the node reference and how the stage behaves, and [Wiring your own auth](/guides/wiring-your-own-auth) for getting the caller onto `context.principal`.
