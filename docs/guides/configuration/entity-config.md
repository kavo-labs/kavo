# Entity config

`@Kavo(Entity, config)` accepts every settings field from [Settings](/guides/configuration/settings) one level above global, plus four fields that only make sense per entity: `dto`, `allowlists`, `computed` (see [Allowlists & computed fields](/features/allowlists-and-computed-fields)), and `operations` (its own page, see [Operations](/guides/configuration/operations#operations-1)).

## dto

Registers DTO classes per slot — every slot is independently optional and falls back to an entity-derived default when omitted:

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

There's no `patch` DTO class to write on its own — it derives from `update`. See [DTO system](/internals/architecture/04-dto-system) for full derivation rules.

## allowlists and computed

Moved to [Allowlists & computed fields](/features/allowlists-and-computed-fields).
