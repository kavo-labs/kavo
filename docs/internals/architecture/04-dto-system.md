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

- **Readable projection** (`item`/`list` default): every own scalar
  column — an ORM-derived field is opt-in only through an explicit
  `allowlists.selectable` (§7, [ADR-0046](/internals/adr/0046-derived-fields-come-from-orm-metadata))
  — **intersected with `allowlists.selectable` when that key is configured
  explicitly** ([ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection)) —
  which is how a column is kept out of every response without registering a
  DTO at all. Relation properties
  are excluded unless the request includes them deliberately; a class
  getter or method never appears on its own unless it is a real
  `FieldMetadata` entry the adapter reports.
  A registered DTO wins outright over the allowlist rather than
  intersecting with it: it is the narrower, more specific statement.
- **Writable projection** (`create`/`update`/`patch` default): every
  scalar column with `generated: false`, plus every relation (associable
  by id, [ADR-0014](/internals/adr/0014-associate-by-id-not-deep-writes)),
  minus the primary key and the soft-delete marker field, which are
  excluded **regardless of** `generated` — an app-assigned id or a marker
  column that isn't the ORM's own delete-date column would otherwise be an
  ordinary writable field with no other guard. The id is fixed metadata,
  so its exclusion is resolved once; the marker is an ordinary settings key
  (entity → operation → per-call, like any other), so `DefaultDeserializer`
  reads it off `context.config.softDelete.field` **at deserialize time**,
  per call — the same scope the request's own soft-delete strategy
  resolves at — not a value baked in once at bootstrap, so a per-operation
  or per-call override that renames the marker stays covered. Generated
  columns (auto ids, `@CreateDateColumn`, versions) can never be written
  from a request body either — the default deserializer silently strips
  all of these, which is the safe posture in a system with no validation
  stage. An explicit write DTO can still name the id or the marker field (a
  legitimate opt-in for a caller-assigned key); `update`/`patch` write
  paths additionally strip both from the payload before persisting, as
  defence in depth against reassigning an _existing_ row's identity or
  soft-delete state that way.

  This default projection can be narrowed further, without registering a
  DTO at all, by `allowlists.creatable` (for `createOne`) and
  `allowlists.updatable` (for `updateOne`/`patchOne` — the two share one
  list, since both mutate an existing row) — the write-side counterpart to
  `allowlists.selectable` above, and subject to the same rules: it can only
  narrow the derived projection, never widen it, so naming the id or the
  soft-delete marker there has no effect; and a registered write DTO with a
  runtime shape wins outright, exactly as a registered `item`/`list` DTO
  wins over `selectable` — where you register one, it, not the allowlist,
  is the narrowing statement. Unconfigured, both default to the same base
  described above, so an entity that never sets either sees no change
  (issue #259).

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

**DTO mapping first, then field selection.** `select=id,name` can only
narrow what the resolved DTO exposes — selection never widens a
projection. Implemented in `DefaultSerializer.serializeItem`:
projection ∩ selection, applied to every item and list element.

## 6. Included relations

When a response embeds an included relation, the node's shape resolves
from the **target entity's own registered `item`/`list` DTOs** when that
entity has a Kavo config, else its entity-derived default. There is no
per-include DTO slot — the related resource owns its own contract.

## 7. ORM-derived fields (virtual columns, issue #373)

A field with no ordinary storage column is declared on the **ORM**, not on
Kavo — a TypeORM `@VirtualColumn`, a MikroORM `@Formula` — and reported to
core through `FieldMetadata.derivedExpression`, an opaque marker core
never inspects ([ADR-0005](/internals/adr/0005-core-zero-runtime-dependencies)). It is then
an **ordinary `FieldMetadata` entry**, read straight off the row like any
column, subject to the same "selection narrows, never widens" rule of §5
— no separate evaluation step, no serializer-side resolver
([ADR-0046](/internals/adr/0046-derived-fields-come-from-orm-metadata),
which supersedes the `computed`/`resolve` design formerly documented
here).

| Aspect                  | Behavior                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default projection      | **Excluded** unless opted in via an explicit `allowlists.selectable` — the same opt-in rule a relation follows                                                    |
| Explicit DTO            | Narrows it like any other field                                                                                                                                   |
| `selectable`            | Opt-in only; `{ exclude }` never surfaces it, only a plain array can                                                                                              |
| `filterable`/`sortable` | Opt-in only; whether it actually works depends on the adapter (TypeORM/MikroORM: yes; Prisma/Mongoose: field invisible entirely)                                  |
| `searchable`            | **Never** — naming it, opted in or not, is a bootstrap `ConfigurationException`                                                                                   |
| Write payloads          | Never writable — a `create`/`update`/`patch` DTO naming it is a bootstrap error, and the deserializer excludes it from the derived writable projection regardless |
| Precedence chain        | N/A — it is ORM metadata, not `EntityConfig`; only its allowlist membership is configured                                                                         |

A derived field on a **relation target** resolves when that relation is
included — the serializer reads the included node's projection from the
target's own resolved config through the `EntityCatalog` (§6), the same
composition an ordinary column already gets, with no extra machinery and
no context-propagation hazard (there is no resolver left to hand a
context to).

Static typing of the response is unaffected: the entity-derived `ItemDto`
does not grow the key unless the ORM entity class itself declares the
property (a `@VirtualColumn`/`@Formula` field is a real class property, so
it typically does). The generated OpenAPI response schema includes it
under the same rule as any other field: typed from its own
`FieldMetadata`, gated by the resolved `selectable` allowlist.

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

That fallback is the right default for a result that _is_ a row, and a trap
for one that is not: a handler returning `{ applied, skus }` against an
entity with neither column serialized to `{}`, silently, while the static
types promised the shape (#181). The engine now refuses a **custom**
operation whose non-empty result projects to zero keys, naming the
operation and pointing at `dto.output` (doc 07 §1a). A result that is a
narrower entity shape is still served as-is; only zero intersection is
treated as a declaration mistake.

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
