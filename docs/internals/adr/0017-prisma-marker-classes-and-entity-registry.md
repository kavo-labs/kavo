# ADR-0017 — Prisma marker classes and the explicit entity registry

**Status:** accepted

## Context

`createCrud(entity, …)` (ADR-0011) requires a `ClassRef<Entity>` — a real
runtime class — as an entity's identity: it is the key `metadataFor`/
`adapterFor` cache by, and the value the whole `KavoInstance` map keys its
per-entity registry on. `@kavo/typeorm` gets this for free: a TypeORM
entity is a genuine class decorated with `@Entity()`, and its
`DataSource` already holds every entity class the app registered
(`entities: [...]`), so a relation's target model resolves to a real
class via `relation.inverseEntityMetadata.target`.

Prisma has neither half of that. A Prisma model produces no runtime
class — `@prisma/client`'s generated output is TypeScript types (`type
Author = { … }`), erased at compile time, with no `new Author()`
anywhere. And Prisma Client carries no registry of "every model class the
app uses" the way a TypeORM `DataSource` does, because there is no class
to register in the first place.

## Decision

`@kavo/prisma` asks the caller to declare one empty **marker class** per
Prisma model, matched to its DMMF model by name:

```ts
class Author {}
// ↔ model Author { … } in schema.prisma
```

This class carries no behavior — it exists purely to be the `ClassRef`
identity `createCrud` needs. `buildEntityMetadata` looks it up by
`entity.name` against `datamodel.models`; a name mismatch is a bootstrap
`ConfigurationException`, not a silent no-op.

Because Prisma has no built-in registry, `createInfrastructure`
takes an explicit `entities: readonly ClassRef[]` — every marker class
the Kavo root will ever see — alongside `datamodel`. A relation's target
model name resolves back to _its_ marker class through a `name → class`
map built from that list once, at infrastructure construction. Declaring
a marker class without adding it to `entities` is a discoverable failure
only if something actually asks for that relation's target (a lazy
`ConfigurationException` from `RelationDescriptor.target()`), not an
upfront validation pass — the same posture core takes toward other lazy
relation targets.

## Consequences

- Setting up `@kavo/prisma` costs one extra declaration TypeORM users
  don't pay: a marker class per model, plus registering all of them with
  `createInfrastructure`/`createPrismaKavo`. This is the actual
  price of Prisma not generating classes — no cheaper option preserves
  `ClassRef` as core's entity identity without changing core itself.
- A marker class may declare fields (`class Author { id!: number; … }`)
  purely for the caller's own type safety on `createCrud`'s generic
  parameters; `@kavo/prisma` never reads instance properties off it, only
  `.name`.
- `EntityMetadata.softDeleteField` is always `null` from this adapter —
  Prisma has no `@DeleteDateColumn`-equivalent declaration to detect, so
  soft delete is always explicit `delete.field` configuration here,
  never auto-detected (unlike `@kavo/typeorm`).
