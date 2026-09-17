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

**DTO mapping happens before field selection.** A `select=id,title` query string can only narrow what the resolved DTO already projects. Selection never widens a projection past what the DTO or the `selectable` allowlist already allows.

## Included relations

A response embedding an included relation shapes that relation's node from the **target entity's own** registered `item`/`list` DTO, never a DTO slot on the root entity. There's no per-include DTO. The related resource owns its own contract, the same as if you'd requested it directly.

## Computed fields

A field with no ordinary storage column is declared on the ORM entity itself — a TypeORM `@VirtualColumn`, a MikroORM `@Formula` — not faked through a DTO class. See [Virtual fields](/features/virtual-fields) for the full picture, including the per-ORM support matrix.

## Per-operation overrides

The six slots above are entity-wide: every operation that reads `create` reads the same class. `operations.<id>.dto` layers a narrower override in front of them, specific to one operation:

```ts
@Kavo(Book, {
  dto: { item: BookItemDto }, // entity-wide default for every read
  operations: {
    // Naming any operation makes `operations` an exclusive whitelist (see
    // [Operations](/guides/configuration/operations#operations)) — narrowing
    // findOne alone only if every other standard operation is also named.
    findOne: { dto: { output: BookDetailDto } }, // findOne only
  },
})
```

Fallback order per field: `operations.<id>.dto.<field>` → the entity's root `dto.<slot>` → the entity-derived default. Which fields apply depends on the operation: `input`/`output` on a write, `output`/`query` on a read, neither on `deleteOne`/`purgeOne`. See [Guides/Configuration/Entity config](/guides/configuration/entity-config#dto) and [Operations](/guides/configuration/operations#operations) for the field-by-field mechanics, and [DTO system](/internals/architecture/04-dto-system) for the full derivation and fallback rules.

## Migrating to `schema` (ADR-0055)

A `schema` key is landing alongside `dto`, per slot and split by direction rather than one flat map:

```ts
@Kavo(Book, {
  schema: {
    input: { create: CreateBookSchema, update: UpdateBookSchema },
    output: { item: BookItemSchema, list: BookListSchema },
  },
})
```

Where `dto` is a plain class narrowed by its runtime key set, `schema.input.<slot>`/`schema.output.<slot>` is any object satisfying the structural `KavoSchema<Output>` contract — one `safeParse(input): SchemaParseResult<Output>` method, the same shape a Zod schema already has, with no `zod` dependency in `@kavo/core` itself (ADR-0005). Two differences follow from that:

- **`schema.input` actually validates.** `dto` never rejects a body — v6 has no validation subsystem attached to it. A `schema.input.<slot>` does: the engine runs `safeParse` on the deserialized body and raises `SchemaValidationException` (`KAVO_SCHEMA_INVALID`, 400) on failure, with one `errors[]` entry per issue. On success, the schema's own `data` replaces the deserialized body — so a schema that transforms its input (trims a string, defaults a field) has that transformation take effect.
- **`schema.output` narrows/shapes, but is never re-validated.** Applied after the ordinary `dto`/field-selection projection, the same role `dto.item`/`dto.list`'s field set plays — but a `safeParse` failure here falls back to the already-projected value rather than rejecting a response Kavo itself produced.

Per-operation overrides follow the same shape at `operations.<id>.schema.<field>`, with the same fallback chain `dto` has: `operations.<id>.schema.<field>` → the entity's root `schema.input.<slot>`/`schema.output.<slot>` → the corresponding `dto` override → the entity-derived default. Where both `schema` and `dto` are configured for the same slot, `schema` wins.

`dto` is not removed by this — see ADR-0055 and issue #466 for why (in short: `@kavo/nest`'s OpenAPI generation and route/body-validation wiring still resolve DTOs directly off `@kavo/core`'s `dto` exports, and migrating those is separate follow-up work). Until that lands, prefer `schema` for entities that need real input validation and keep `dto` for shape/serialization-only slots; the two coexist per slot without conflict.
