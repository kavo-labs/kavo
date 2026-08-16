# DTOs

Every request/response shape in Kavo is optional. Zero config means an entity-derived default. Registering a DTO class narrows exactly one **slot** without touching the others.

## The six slots

| Slot     | Verb / context                        | Default when omitted                                                |
| -------- | ------------------------------------- | ------------------------------------------------------------------- |
| `create` | `POST` body                           | Entity's own shape, minus generated and relation fields             |
| `update` | `PUT` body                            | Same default as `create`                                            |
| `patch`  | `PATCH` body                          | `Partial<update>` if `update` is registered, else `Partial<Entity>` |
| `query`  | `GET` list input                      | Generic `QueryContext<Entity>`                                      |
| `item`   | Any single-resource response          | Entity, subject to field selection                                  |
| `list`   | Element type inside the list envelope | Same as `item`'s resolved type                                      |

There's no separate `patch` class to write. It always derives from `update`. Registering one slot doesn't touch any other; each is resolved independently.

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

## How a class narrows a slot

A registered class projects by its **runtime key set**: the own enumerable properties of `new Dto()`, not its TypeScript type. Fields need real initializers to exist at runtime:

```ts
class BookListDto {
  id = 0;
  title = "";
} // projects { id, title }

class BadDto {
  id!: number;
} // no runtime keys — falls back to the entity-derived default, silently
```

This keeps DTO classes plain: no decorators, no reflection library. The cost is that fields need initializers for the narrowing to actually take effect.

**DTO mapping happens before field selection.** A `fields=id,title` query string can only narrow what the resolved DTO already projects. Selection never widens a projection past what the DTO or the `selectable` allowlist already allows.

## Included relations

A response embedding an included relation shapes that relation's node from the **target entity's own** registered `item`/`list` DTO, never a DTO slot on the root entity. There's no per-include DTO. The related resource owns its own contract, the same as if you'd requested it directly.

## Computed fields

A field with no backing column, computed at serialization time from the row that was already fetched, is declared on the entity's `computed` config, not faked through a DTO class. See [Computed fields](/features/computed-fields#computed) for the full descriptor.

## Per-operation overrides

The six slots above are entity-wide: every operation that reads `create` reads the same class. `operations.<id>.dto` layers a narrower override in front of them, specific to one operation:

```ts
@Kavo(Book, {
  dto: { item: BookItemDto }, // entity-wide default for every read
  operations: {
    findOne: { dto: { output: BookDetailDto } }, // findOne only
  },
})
```

Fallback order per field: `operations.<id>.dto.<field>` → the entity's root `dto.<slot>` → the entity-derived default. Which fields apply depends on the operation: `input`/`output` on a write, `output`/`query` on a read, neither on `deleteOne`/`purgeOne`. See [Guides/Configuration/Entity config](/guides/configuration/entity-config#dto) and [Operations](/guides/configuration/operations#operations) for the field-by-field mechanics, and [DTO system](/internals/architecture/04-dto-system) for the full derivation and fallback rules.
