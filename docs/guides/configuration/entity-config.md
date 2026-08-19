# Entity config

`@Kavo(Entity, config)` accepts every settings field from [Settings](/guides/configuration/settings) one level above global, plus five fields that only make sense per entity: `dto`, `allowlists` (see [Allowlists](/features/allowlists)), `computed` (see [Computed fields](/features/computed-fields)), `policy` (below), and `operations` (its own page, see [Operations](/guides/configuration/operations#operations-1)).

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

Authorization, keyed by standard operation id (ADR-0032). An id absent here runs unrestricted:

```ts
import { and, owner, permission } from "@kavo/core";

@Kavo(Post, {
  policy: {
    updateOne: and(permission("post:update"), owner("authorId")),
    deleteOne: ["post:delete", "admin"], // array shorthand: every name required
  },
})
```

`owner`/`when` need the loaded row, so they're only legal on the single-row operations (`findOne`/`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne`) — configuring either on `createOne`/`findMany` is a bootstrap error. `operations.<id>.policy` overrides the entity-level entry for that operation, the same fallback `dto` uses. See [Wiring your own auth](/guides/wiring-your-own-auth) for the full `permission`/`role`/`owner`/`authenticated`/`when`/`and`/`or`/`not` reference.
