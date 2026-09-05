# Entities

An entity is whatever your ORM already gives you: a TypeORM `@Entity()` class, a Prisma marker class, a Mongoose model, or a MikroORM `@Entity()` class. Kavo doesn't ask you to declare anything a second time. It reads the entity's own metadata (columns, relations, the primary key) through the ORM adapter you installed, and derives everything else from that.

```ts
// book.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column()
  author!: string;
}
```

## `@Kavo()`

One decorator turns an empty controller into a full CRUD surface for that entity:

```ts
@Kavo(Book)
@Controller("books")
export class BookController {}
```

`@Kavo(Entity, config?)` runs at class-definition time, the moment Nest's router scan can see the generated methods. It does three things: builds the entity's [operation registry](/core/crud-operations), generates one route per enabled operation, and binds a typed [`DefaultKavoService`](/core/services) that both the generated routes and your own code can call. `config` is entirely optional. Every field it accepts falls back to an entity-derived default, which is why the example above works with no config object at all.

Outside Nest, the same thing happens through `createCrud(Entity, config?)`. `@Kavo` is sugar over it for the Nest binding (see [Routes & controllers](/core/routes-and-controllers)).

## Zero-config behavior

With no config, Kavo derives everything it needs from the entity's own metadata:

- **Writable columns** (`create`/`update`/`patch` bodies): every scalar column that isn't database-generated. An auto-increment id or a `@CreateDateColumn` is excluded automatically. Sending one in a request body is silently stripped, not an error.
- **Readable columns** (responses): every own scalar column, plus any opted-in [virtual field](/features/virtual-fields) your ORM declares.
- **Filterable, sortable, and selectable fields**: every scalar column, unless you narrow one of the [allowlists](/features/allowlists) explicitly.
- **Includable relations**: none, until you name one in `allowlists.includable`. This is the one allowlist that defaults closed rather than open ([ADR-0028](/internals/adr/0028-includable-relations-move-into-allowlists)).

None of this requires a DTO class, a service, or a repository. See [DTOs](/core/dtos) for what registering one narrows, and [Quick start](/getting-started/quick-start) for the end-to-end walkthrough.

## What Kavo needs from an entity

- **At least one primary column.** A single primary column is the common case, reported as `idField`. `@kavo/typeorm` also supports a composite primary key, two or more `@PrimaryColumn`s, reported as `compositeIdFields`; the other ORM adapters still require exactly one. See [Composite primary keys](/features/composite-primary-keys) for the route-id encoding, the creatable/updatable split, and what still doesn't work.
- **Scalar columns and relations, distinguished by the ORM's own metadata.** A relation-shaped property is never treated as a writable scalar. Association happens by id, not by embedding a related object in the body ([ADR-0014](/internals/adr/0014-associate-by-id-not-deep-writes)).
- **A registered identity the ORM can resolve at runtime.** For TypeORM and MikroORM, that's the decorated class itself. Mongoose uses the model, since it already is the identity ([ADR-0018](/internals/adr/0018-mongoose-models-are-entity-identities)). Prisma needs a small marker class, since it generates no runtime class per model ([ADR-0017](/internals/adr/0017-prisma-marker-classes-and-entity-registry)). See your ORM's [integration page](/integrations/orms/typeorm) for the exact shape.

An entity that never goes through `@Kavo`/`createCrud` can still get served as a relation target included from another entity, through a derived, unconfigured projection of its own columns.
