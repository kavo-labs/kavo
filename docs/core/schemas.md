# Schemas

Every request/response shape in Kavo is optional. Zero config means an entity-derived default. A `schema` entry narrows exactly one **slot** without touching the others. A slot takes a plain **schema class** (shape only) or a **validator** such as a Zod schema (shape and validation).

## The six slots

| Slot     | Verb / context                        | Default when omitted                                                |
| -------- | ------------------------------------- | ------------------------------------------------------------------- |
| `create` | `POST` body                           | Entity's own shape, minus generated and relation fields             |
| `update` | `PUT` body                            | Same default as `create`                                            |
| `patch`  | `PATCH` body                          | `Partial<update>` if `update` is registered, else `Partial<Entity>` |
| `query`  | `GET` list input                      | Generic `QueryContext<Entity>`                                      |
| `item`   | Any single-resource response          | Entity, subject to field selection                                  |
| `list`   | Element type inside the list envelope | Same as `item`'s resolved type                                      |

There's no separate `patch` schema to write. It derives from `update`. Configuring one slot doesn't touch any other; each is resolved independently.

```ts
@Kavo(Book, {
  schema: { input: { create: CreateBookSchema, update: UpdateBookSchema }, output: { item: BookItemSchema, list: BookListSchema } },
})
```

## Two kinds of slot value

Each slot accepts either of these:

- **A class**, narrowed by its **runtime key set**: the own enumerable properties of `new Schema()`, not its TypeScript type. Fields need real initializers to exist at runtime. A class never rejects a body; it only shapes it.
- **A validator**: any object with `safeParse(input): SchemaParseResult<Output>`, the shape a Zod schema already has. `@kavo/core` has no `zod` dependency (ADR-0005).

```ts
class BookListSchema {
  id = 0;
  title = "";
} // projects { id, title }

class BadDto {
  id!: number;
} // no runtime keys — falls back to the entity-derived default, silently
```

Classes stay plain: no decorators, no reflection library. The cost is that fields need initializers for the narrowing to take effect.

A validator differs in these ways:

- **`schema.input` validates.** The engine runs `safeParse` on the deserialized body and raises `SchemaValidationException` (`KAVO_SCHEMA_INVALID`, 400) on failure, with one `errors[]` entry per issue. On success the schema's own `data` replaces the body, so a transform (trim a string, default a field) takes effect.
- **`schema.output` shapes but is never re-validated.** A `safeParse` failure falls back to the already-projected value rather than rejecting a response Kavo itself produced, so a validator is not a confidentiality boundary. Use a class, `{ fields }`, or `select.fields` to keep a column off the wire.
- **A per-operation validator override still narrows against the entity-scope allowlist.** A class-shaped `schema.input.create`/`update` at entity scope sets the writable-field allowlist; an `operations.<id>.schema` validator override replaces only the judging step, so a lenient validator can't widen what that allowlist excluded.
- **Nested rows ignore it.** An included relation is shaped only by its target's class-shaped `schema.output`; a validator there does not narrow nested rows.

**Schema mapping happens before field selection.** A `select=id,title` query string can only narrow what the resolved schema already projects. Selection never widens a projection past what the schema or the `select.fields` allowlist allows.

## Shorthands

`schema.input`, `schema.output`, and `schema` itself each accept a single value in place of their per-slot map:

```ts
@Kavo(Book, {
  schema: { input: CreateBookSchema }, // same as { create, update, patch: CreateBookSchema }; no output
})

@Kavo(Book, {
  schema: { output: BookItemSchema }, // same as { item, list: BookItemSchema }; no input validation
})

@Kavo(Book, {
  schema: BookSchema, // same as { input: BookSchema, output: BookSchema }
})
```

The explicit form, with the fallbacks marked:

```ts
@Kavo(Book, {
  schema: {
    input: {
      create: CreateBookSchema,
      update: UpdateBookSchema,
      patch: UpdateBookSchema, // or omit: falls back to update
      query: BookQuerySchema,
    },
    output: {
      item: BookItemSchema,
      list: BookListSchema, // or omit: falls back to item
    },
  },
})
```

`schema.input`'s shorthand never reaches `query`, which has its own shape and no natural single-schema reading. A shorthand `schema.output` is typed against the input side's output type only: a failing output schema falls back to the projected value, so a create schema narrower than the full entity still works as the output shorthand.

## Field lists

Anywhere a schema goes, a plain list of field names works too, as a bare array or as `{ fields: [...] }`. Kavo synthesizes a class from it, the same key set a hand-written class with those fields would give:

```ts
@Kavo(Book, { schema: ['title', 'year'] }) // input and output
@Kavo(Book, { schema: { input: ['title', 'year'] } }) // create, update, patch
@Kavo(Book, { schema: { input: { create: ['title'], update: ['title', 'year'] } } })
@Kavo(Book, { schema: { output: { item: ['id', 'title'], list: ['id'] } } })
```

Field names are type-checked against the entity, own columns only (depth 1). Like a class, a list only shapes; it never rejects a body. On the write side, `schema.input.create`'s/`update`'s `{ fields }` shorthand is the writable-field allowlist itself — there is no separate top-level `create`/`update` key any more (issue #476). A per-operation `operations.<id>.schema` override takes a class or validator only.

So one `schema` can hold all three kinds: a Zod (or any `safeParse`) validator, a class (with `class-validator` decorators if you run a `ValidationPipe`), or a field list.

## Included relations

A response embedding an included relation shapes that relation's node from the **target entity's own** `item`/`list` schema, never a slot on the root entity. There's no per-include schema. The related resource owns its own contract, the same as if you'd requested it directly.

## Computed fields

A field with no ordinary storage column is declared on the ORM entity itself — a TypeORM `@VirtualColumn`, a MikroORM `@Formula` — not faked through a schema class. See [Virtual fields](/features/virtual-fields) for the full picture, including the per-ORM support matrix.

## Per-operation overrides

The six slots above are entity-wide: every operation that reads `create` reads the same value. `operations.<id>.schema` layers a narrower override in front of them, specific to one operation:

```ts
@Kavo(Book, {
  schema: { output: { item: BookItemSchema } }, // entity-wide default for every read
  operations: {
    // Naming any operation makes `operations` an exclusive whitelist (see
    // [Operations](/guides/configuration/operations#operations)) — narrowing
    // findOne alone only if every other standard operation is also named.
    findOne: { schema: { output: BookDetailSchema } }, // findOne only
  },
})
```

Fallback order per field: `operations.<id>.schema.<field>` → the entity's root `schema.input.<slot>`/`schema.output.<slot>` → the entity-derived default. Which fields apply depends on the operation: `input`/`output` on a write, `output`/`query` on a read, neither on `deleteOne`/`purgeOne`; naming a field the operation lacks throws a `ConfigurationException` at `createCrud`. See [Entity config](/guides/configuration/entity-config) and [Operations](/guides/configuration/operations#operations) for the field-by-field mechanics, and [Schema system](/internals/architecture/04-schema-system) for the full derivation and fallback rules.

## OpenAPI and validation pipes

`@kavo/nest` documents a validator in OpenAPI only if it opts into an optional `toJSONSchema(): object` method (`KavoSchema`); `.safeParse` alone gives `registerKavoSchemas` nothing to introspect, so such a slot is documented from the entity's ORM metadata instead. A class-shaped `schema.input.<slot>` is also written to a generated route's `design:paramtypes`, so a global `ValidationPipe` (for example a `class-validator` one) validates it. `@kavo/nest` ships no `class-validator` exception factory of its own (see `examples/nest-typeorm/src/common/validation-exception-factory.ts`). See ADR-0055.
