# @kavo/prisma

Prisma adapter for Kavo: implements `RepositoryAdapter`
(`EntityReader` + `EntityWriter`) from `@kavo/core` over a Prisma Client
model delegate. `TransactionManager` is not implemented — see the
`@remarks` on that interface in `@kavo/core`.

**May depend on:** `@kavo/core`, `@prisma/client` (peer). **Never on:**
`@kavo/nest` or any framework.

Fully implemented: CRUD, filtering/sorting/pagination, soft delete
(explicit `delete.field` only — Prisma declares no delete-marker
column the way TypeORM's `@DeleteDateColumn` does), and relation
includes all run through this adapter.

## Usage

Prisma generates no runtime class for a model, so each entity needs a
caller-declared **marker class** as its `ClassRef` identity, matched by
name to the schema (`class Author {}` ↔ `model Author { … }`). See
`docs/internals/adr/0017-prisma-marker-classes-and-entity-registry.md` for why.

```ts
import { PrismaClient, Prisma } from "@prisma/client";
import { createPrismaKavo } from "@kavo/prisma";

class Author {
  id!: number;
  email!: string;
  name!: string;
}
class Book {
  id!: number;
  title!: string;
}

const prisma = new PrismaClient();
const kavo = createPrismaKavo(prisma, {
  datamodel: Prisma.dmmf.datamodel,
  entities: [Author, Book],
});

const authors = kavo.createCrud(Author);
```

Set `caseInsensitiveFilters: false` when the connector isn't Postgres or
MongoDB — Prisma's `mode: "insensitive"` (used to translate the `ilike`
filter operator) is rejected outright by MySQL, SQLite, and SQL Server.

## Relation writes: explicit scalar foreign keys only

Per ADR-0014 ("associate by id, not deep writes"), a relation is set by
writing its scalar foreign-key field directly (`{ authorId: 5 }`), the
same contract `@kavo/typeorm` exposes. This requires the Prisma schema to
declare that foreign key as an explicit scalar field on the relation
(`authorId Int?` alongside `author Author? @relation(fields: [authorId],
references: [id])`) — the [documented best
practice](https://www.prisma.io/docs/orm/prisma-schema/data-model/relations)
for any 1:1/1:n relation. An **implicit many-to-many** relation (no
scalar field on either side, Prisma manages the join table itself) has no
foreign key for a DTO to expose, so it cannot be associated through the
normal write path — a custom operation handler reaching for the raw
Prisma Client is the escape hatch, same as any write shape Kavo doesn't
model directly.
