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
import { PrismaClient } from "./generated/prisma/client";
import { createPrismaKavo } from "@kavo/prisma";
import metadata from "./generated/kavo-metadata";

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
  metadata,
  entities: [Author, Book],
});

const authors = kavo.createCrud(Author);
```

Set `caseInsensitiveFilters: false` when the connector isn't Postgres or
MongoDB — Prisma's `mode: "insensitive"` (used to translate the `ilike`
filter operator) is rejected outright by MySQL, SQLite, and SQL Server.

## Relation writes: associate by id

Per ADR-0014 ("associate by id, not deep writes"), a relation is set in
one of two ways, the same contract `@kavo/typeorm` exposes:

- **The scalar foreign-key field** (`{ authorId: 5 }`). This needs the
  Prisma schema to declare that key as an explicit scalar on the relation
  (`authorId Int?` alongside `author Author? @relation(fields: [authorId],
references: [id])`), the [documented best
  practice](https://www.prisma.io/docs/orm/prisma-schema/data-model/relations)
  for any 1:1/1:n relation.
- **A reference under a to-one relation's own key** (`{ author: { id: 5 } }`).
  The adapter turns it into Prisma's `connect`; `null` leaves it unset on
  create and `disconnect`s it on update. A dangling id is a 422
  `KAVO_UNRESOLVED_RELATION`, the same as the `authorId` spelling. Anything
  other than `{ <id>: <string | number> }` or `null` — a nested write such
  as `{ author: { create: { … } } }`, a reference with no id — is a 400
  `KAVO_ASSOCIATION_INVALID_SHAPE`, and nothing is written.

A **to-many** relation key (`{ books: [...] }`) is refused with a 400
`KAVO_ASSOCIATION_INVALID_SHAPE`: associate those rows by writing each
one's own foreign key instead. Send one spelling per relation per request:
Prisma rejects a body that mixes `authorId` with `author`. An **implicit
many-to-many** relation (no scalar field on either side; Prisma manages the
join table) has no foreign key to write; a custom operation handler
reaching for the raw Prisma Client is the escape hatch there, as for any
write shape Kavo doesn't model directly.
