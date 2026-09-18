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

**DTO mapping happens before field selection.** A `select=id,title` query string can only narrow what the resolved DTO already projects. Selection never widens a projection past what the DTO or the `select.fields` allowlist already allows.

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

`schema.input`, `schema.output`, and `schema` itself each also accept a single schema in place of their per-slot map, as shorthand for applying one schema everywhere that side reads from:

```ts
@Kavo(Book, {
  schema: { input: CreateBookSchema }, // same as { create, update, patch: CreateBookSchema }
})

@Kavo(Book, {
  schema: CreateBookSchema, // same as { input: CreateBookSchema, output: CreateBookSchema }
})
```

`schema.input`'s shorthand never reaches `query` — it has its own shape and no natural single-schema reading. A shorthand `schema.output`/top-level `schema` is typed against the input side's output type only: a failing `schema.output` safely falls back to the already-projected value rather than rejecting, so a create schema narrower than the full entity still works as the output shorthand too.

`dto` is not removed by this — see ADR-0055 and issue #466 for why. `@kavo/nest`'s OpenAPI generation (`registerKavoSchemas`) and `@kavo/graphql`/`@kavo/mcp` have migrated onto `schema` (issue #467): a configured `schema.input.<slot>`/`schema.output.<slot>` is documented/typed ahead of `dto`, with `dto` and then the entity's own ORM metadata as the fallback chain when no `schema` is configured for a slot. OpenAPI generation specifically needs a schema that opts into an optional `toJSONSchema(): object` method (`KavoSchema`, `kavo-schema.ts`) — `.safeParse` alone gives `registerKavoSchemas` nothing to introspect; a schema with no `toJSONSchema` still validates and narrows at runtime, but is documented from the `dto`/ORM-metadata fallback instead. `@kavo/nest` also no longer bundles a `class-validator` exception factory or an entity-class validation fallback of its own (issue #283/#437) — `schema` is Kavo's own answer to write-body validation now, so a `class-validator`-backed `ValidationPipe` is entirely an app's own choice (see `examples/nest-typeorm/src/common/validation-exception-factory.ts`). Prefer `schema` for entities that need real input validation and OpenAPI-documented shapes; keep `dto` where you only need shape/serialization narrowing with no validation or docs generation attached — the two coexist per slot without conflict.
