# 04 — Optional DTO System

Every REST verb has an independent, optional data contract. Zero config
means entity-derived defaults; registering a class narrows exactly one
slot. DTOs in v6 are shapes for **typing, serialization, and Swagger
docs** — there is no validation subsystem attached to them.

## 1. The six slots and their defaults

| Slot     | Verb / context                        | Default when omitted                                             |
| -------- | ------------------------------------- | ---------------------------------------------------------------- |
| `create` | `POST` body                           | Entity minus generated + relation fields                         |
| `update` | `PUT` body                            | Same default as `create`                                         |
| `patch`  | `PATCH` body                          | `Partial<update>` if `update` registered, else `Partial<Entity>` |
| `query`  | `GET` list input                      | Generic `QueryContext<Entity>`                                   |
| `item`   | Any single-resource response          | Entity, subject to field selection                               |
| `list`   | Element type in `ListResultDto.items` | Same as `item`'s resolved type                                   |

Restore reuses `item`/`list`; no additional slots exist. §8 below adds a
second, narrower tier of override — one per _operation_, not per slot —
without introducing a slot of its own. The list
envelope's `meta` bag is deliberately **not** a slot: it carries the
caller's own data rather than entity data, so it has no DTO and never
passes through the serializer (doc 07 §3.1). Having no DTO is also why it
is the envelope's one optional field — with nothing to project there is
nothing to emit until a handler contributes, so the key stays off the
response rather than shipping as `{}`.

## 2. Resolution algorithm

`DefaultDtoResolver` (`core/src/dto/default-dto-resolver.ts`) resolves
each slot **independently at bootstrap** and caches the result on the
resolved config — never per request. Resolution returns the registered
class or `null`, where `null` means "use the entity-derived default".
The fallback chains `patch → update` and `list → item` are baked in at
construction, mirroring the static generic defaults (doc 03 §1), so the
type level and the runtime never disagree about which slot follows which.

## 3. Runtime derivation rules

The metadata seam (`EntityMetadata`, doc 09 §1) supplies the field list
the defaults derive from:

- **Readable projection** (`item`/`list` default): every scalar column,
  plus every computed field the entity declares (§7). Relation properties
  are excluded unless the request includes them deliberately; a class
  getter or method never appears on its own — it is not a column, and an
  entity-class getter that seems to work is an accident of the ORM handing
  the engine class instances ([ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated)).
- **Writable projection** (`create`/`update`/`patch` default): every
  scalar column with `generated: false`. Generated columns (auto ids,
  `@CreateDateColumn`, versions) can never be written from a request
  body — the default deserializer silently strips them, which is the safe
  posture in a system with no validation stage.
- **Embedded objects** map to a `json`-kind column and travel as one
  opaque value; they are not flattened into sub-fields.

## 4. Explicit DTO classes and `dtoShapeKeys`

A registered class projects by its **runtime key set**: the own
enumerable properties of `new Dto()` (`dto-shape.ts`, cached per class).
TypeScript fields only exist at runtime when initialized, so:

```ts
class UserListDto {
  id = 0;
  name = "";
} // projects [id, name]
class BadDto {
  id!: number;
} // no runtime keys → falls back
```

A class with no initialized fields degrades to the entity-derived
default — the response is still correct, just not narrowed. This keeps
DTO classes plain (no decorators, no reflection library) at the cost of
requiring initializers for narrowing; the tradeoff is documented API.

## 5. Serialization order (normative)

**DTO mapping first, then field selection.** `fields=id,name` can only
narrow what the resolved DTO exposes — selection never widens a
projection. Implemented in `DefaultSerializer.serializeItem`:
projection ∩ selection, applied to every item and list element.

## 6. Included relations

When a response embeds an included relation, the node's shape resolves
from the **target entity's own registered `item`/`list` DTOs** when that
entity has a Kavo config, else its entity-derived default. There is no
per-include DTO slot — the related resource owns its own contract.

## 7. Computed fields

A field with no backing column is declared on the entity config, not
faked through a DTO class:

```ts
createCrud(User, {
  computed: {
    fullName: { resolve: (user) => [user.firstName, user.lastName].filter(Boolean).join(" ") },
  },
});
```

`DefaultSerializer` **evaluates** a computed key by calling `resolve`,
never by reading it off the row — which is what makes it behave the same
over a TypeORM class instance and a Prisma/Mongoose plain object, and why
no ORM adapter is involved at all. It evaluates it even when the row
_does_ carry that key (a class getter, or a column outside the metadata
seam): resolving beats reading, or the feature would collapse back into
the accident it replaced. `resolve` also receives the request's
`KavoContext`, so a field may vary by `principal`; it is synchronous by
design, because it runs once per served item — and must be **total**, not
just pure, because one throwing row fails the entire list response
([ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated)).

The rules, all governed by
[ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated):

| Aspect                  | Behavior                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Default projection      | Included in `item`/`list` automatically — no DTO registration needed                                                             |
| Explicit DTO            | Narrows it like any other field (omit it to hide it; name it to keep it, still evaluated)                                        |
| `selectable`            | Joined by default, so `fields=fullName` works; `selectable: false` opts out                                                      |
| `filterable`/`sortable` | **Never** — naming one is a bootstrap `ConfigurationException`, and a type error besides                                         |
| Write payloads          | Never writable — a `create`/`update`/`patch` DTO naming one is a bootstrap error, and the deserializer strips the key regardless |
| Precedence chain        | Outside it: structural entity config like `dto`, resolved once at `createCrud`                                                   |

The serialization order of §5 is unchanged: a computed field is subject to
"selection narrows, never widens" exactly like a column.

A computed field declared on a **relation target** resolves when that
relation is included — the serializer reads the included node's projection
from the target's own resolved config through the `EntityCatalog` (§6), so
this composes with no extra machinery.

Static typing of the response is unaffected: the entity-derived `ItemDto`
does not grow the key, and neither does the generated OpenAPI response
schema, which falls back to the entity class when no `item`/`list` slot is
registered. Registering an `item`/`list` DTO that names it is how a caller
gets it statically typed — and documented — as for any other narrowing.

## 8. Per-operation override (issue #131)

The six slots above are entity-wide: every operation that reads `create`
reads the _same_ `create` DTO. `operations.<id>.dto` adds a narrower tier
in front of them — a request body, response, or query contract specific to
one operation on one entity:

```ts
createCrud(User, {
  dto: { item: UserItemDto }, // entity-wide default
  operations: {
    findOne: { dto: { output: UserProfileDto } }, // findOne only
    createOne: { dto: { input: CreateUserRequestDto, output: UserCreatedDto } },
  },
});
```

**Fallback order**, per field: `operations.<id>.dto.<field>` → the root
`dto.<slot>` → the entity-derived default. This is the same chain
`KavoEngine.mapResponse` already partially walked for `output`
(`descriptor.output ?? config.dto.resolve(...)`); the change is populating
`descriptor.input`/`output`/`query` from config instead of leaving them
`null`, and reaching the same `descriptor.<field> ?? resolve(...)` order
everywhere a slot is read — including the `If-Match` canonical-read ETag
(doc 20), which now hashes what `findOne`'s own override actually serves.

**Which fields apply to which operation** — `input` only where there is a
request body, `query` only where there is a query contract, `output`
anywhere there is a non-void result:

| Operation                | `input` |     `output`     | `query` |
| ------------------------ | :-----: | :--------------: | :-----: |
| `createOne`              |    ✓    |        ✓         |         |
| `updateOne` / `patchOne` |    ✓    |        ✓         |         |
| `findOne`                |         |        ✓         |    ✓    |
| `findMany`               |         | ✓ (list element) |    ✓    |
| `restoreOne`             |         |        ✓         |         |
| `deleteOne` / `purgeOne` |         |                  |         |
| custom, `kind: "write"`  |    ✓    |        ✓         |         |
| custom, `kind: "read"`   |         |        ✓         |    ✓    |

A field outside this table is a bootstrap `ConfigurationException` — never
a silent drop — and for the standard eight it is also unrepresentable at
the type level: `EntityConfig`'s `operations` field is typed through
`StandardOperationsConfig`, which `Pick`s only the applicable
`OperationDtoOverride` fields per operation id, so e.g. `deleteOne` has no
`dto` key to set at all. The runtime check exists for the same reason
`resolveAllowlists` and `rejectComputedWriteDtoKeys` keep one: a config
built from an erased or cast type has no compiler to catch it.

A custom operation (issue #145) is the one place the rule is runtime-only.
Which fields apply follows from its declared `kind`, which is a value in
the same object rather than a fact about the key, so `CustomOperationConfig`
offers all three and the mismatch is caught at bootstrap. It also has no
root `dto` slot of its own: `output` falls back to the entity's
`item`/`list` slot and `input` to the entity's writable projection, which
is what makes `dto` the only way to give it a shape of its own.

`query`'s effect is **typing only**, like the root `query` slot (§1): there
is no validation subsystem, and the query normalizer parses wire params
structurally against the allowlists regardless of which DTO class is
registered. Both slots exist so a programmatic caller
(`KavoService.findOne`/`findMany`) gets a precise parameter type, and so
`@kavo/nest` can build accurate `@ApiBody`/`@ApiResponse` schemas —
`operations.<id>.dto.input`/`output` change what `descriptor.input`/
`output` documents, ahead of the root slot, the same way they change what
the engine actually deserializes and serializes.

This is per-entity and per-operation only, matching the rest of the DTO
system: no global default, and no override shared across entities or
across operations.
