# ADR-0018 — A Mongoose model is the entity identity, and `ObjectId` converts at the adapter boundary

**Status:** accepted

## Context

Two things every ORM adapter must supply collide with MongoDB in ways the
first two adapters did not have to face.

**Entity identity.** `createCrud(entity, …)` (ADR-0011) needs a
`ClassRef<Entity>` — a real runtime constructor — as an entity's identity:
it is the key `metadataFor`/`adapterFor` cache by, and the key the whole
`KavoInstance` map holds its per-entity registry under. `@kavo/typeorm`
gets one for free from `@Entity()` classes; `@kavo/prisma` cannot, because
Prisma generates only erased types, so ADR-0017 makes callers declare an
empty **marker class** per model plus an explicit `entities` registry.
Reaching for that same construction here would be the natural move — a
third adapter, a third copy of the marker-class tax.

**The primary key.** Core's `EntityId` is `string | number` and
`FieldKind` is a deliberately coarse six-member union (ADR-0011).
MongoDB's `_id` is a 12-byte `ObjectId`, which is neither. Widening core
to admit it would put an ORM-specific type into the package that is
supposed to know no ORM (ADR-0001, ADR-0005), and would oblige every other
adapter and every consumer to handle a case only MongoDB can produce.

## Decision

**A Mongoose model _is_ the `ClassRef`.** `mongoose.model(...)` returns a
constructor, so it satisfies `ClassRef<T> = abstract new (...args: never[])
=> T` directly. `@kavo/mongoose` therefore declares no marker classes and
takes no `entities` list: `createInfrastructure(connection)` reads
`connection.models`, which is the name→model registry Prisma has to ask the
caller to rebuild by hand. Anything satisfying `{ models }` is accepted —
`mongoose`, `mongoose.connection`, or a `createConnection()` handle.

Two edges follow from that:

- **Names come from `modelName`, never `entity.name`.** A Mongoose model's
  function `name` is the useless string `"model"`. `buildEntityMetadata`
  reads `modelName`; `entity.name` is never consulted.
- **A non-model entity fails loudly.** No type-level check can tell a
  Mongoose model from any other class, so `asModel` guards at runtime and
  raises a `ConfigurationException` naming the entity.

**`ObjectId` converts at the adapter boundary, and core does not change.**
`EntityId` stays `string | number`; `FieldKind` gains no `objectId` member;
`_id` is reported as `kind: "string"`.

- _Outbound_: every `ObjectId` leaving the adapter becomes its hex string.
  The conversion recurses, because populated relations carry their own
  `_id`s and a to-many `ref` array is an array of them.
- _Inbound_: nothing to do. Mongoose casts query and write values against
  the schema, so a hex string handed to `{ _id: id }` becomes an `ObjectId`
  without this package ever constructing one — which is why
  `@kavo/mongoose` needs no `bson` import.
- _Malformed_: an id that is not a valid `ObjectId` raises a Mongoose
  `CastError`, mapped to **`NotFoundException`**. A malformed id names a
  document that cannot exist, so it is answered exactly like a well-formed
  id that isn't there — which is also what `@kavo/typeorm` does for a
  non-matching integer id, and avoids making the endpoint an oracle for the
  key format. A `CastError` on any _other_ path is a coercion failure and
  maps to `KAVO_QUERY_INVALID_VALUE` (400), per doc 06.

## Consequences

- Setting up `@kavo/mongoose` costs nothing beyond the models an app has
  already declared — no marker classes, no entity list, nothing to keep in
  sync with the schema. This is the payoff for Mongoose keeping real
  runtime constructors where Prisma does not.
- The identity claim is a _type_ claim, so it is pinned by a compile-only
  test (`tests/types/model-as-class-ref.test-d.ts`). If a future Mongoose
  release drops the construct signature from `Model`, the build breaks —
  which is the correct alarm, because this ADR's premise would be gone.
- Entities are keyed on `_id`, and that name reaches the wire: responses
  carry `_id`, not `id`. Mongoose's `id` virtual is not used — virtuals are
  absent from `schema.paths` and are not applied to the `lean` reads this
  adapter issues, so honouring it would mean inventing a field the metadata
  seam cannot see.
- `EntityMetadata.softDeleteField` is always `null` from this adapter —
  Mongoose declares no `@DeleteDateColumn` equivalent — so soft delete is
  always explicit `delete.field` configuration here, never
  auto-detected. Same position as `@kavo/prisma` (ADR-0017).
- Because the id is a string on the wire, an entity's id sorts and compares
  lexicographically wherever core treats it as an ordinary value. That is
  already true of any string-keyed entity under the other adapters.
