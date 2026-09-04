---
name: prisma-adapter
description: Wiring @kavo/prisma into a Nest app — the marker classes Prisma entities need, createInfrastructure's datamodel/entities options, case-insensitive filtering per database, and how the setup differs from the TypeORM path. Use when adding Kavo to a Prisma project, or answering "how do I use Kavo with Prisma" and "why does @Kavo() not accept my Prisma delegate" questions.
---

# Prisma adapter

`@kavo/prisma` adapts Kavo to a Prisma Client. The engine, routes, query
grammar, DTO slots, and error shapes are identical to every other adapter —
only the wiring below differs.

```bash
npm install @kavo/core @kavo/nest @kavo/prisma
```

`@prisma/client` (`^5.0.0 || ^6.0.0`) is a peer dependency.

## The one thing that is not like TypeORM: marker classes

**Prisma generates no runtime class for a model.** `prisma generate` produces
types and a client with delegates (`prisma.book`), but nothing that survives
to runtime as a constructor — and `@Kavo(Entity)` needs a stable runtime
identity to key an entity by.

So each model needs a small **marker class**: an empty class whose name
matches the Prisma model exactly.

```ts
// book.entity.ts
export class Book {
  id!: number;
  title!: string;
}
```

This is the shape of the trap. The natural guess — passing the delegate,
the way you would pass an entity class with TypeORM — does not work:

```ts
@Kavo(prisma.book)        // ✗ wrong — a delegate is not an identity
@Kavo(Book)               // ✓ the marker class
```

**Declare the fields anyway** — they are what gives you type safety. At
runtime `@kavo/prisma` reads only `.name` off the class and takes all real
metadata from Prisma's DMMF, so an empty `class Book {}` still produces
working routes. But the declared fields are what type `createCrud`'s generic
parameters, so an empty marker class collapses `Entity` to `{}` and every
typed surface built on it silently stops checking anything:
`allowed.filterable`/`sortable`/`selectable`, `query.defaultSort`, and the
DTO slot generics all stop rejecting misspelled field names at compile time.

Name-matching is what binds class to model, so a marker class named `Books`
for a model named `Book` will not resolve — that one fails loudly, as a
bootstrap `ConfigurationException` rather than a silent no-op. See ADR-0017
for the full rationale.

## Wiring

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { KavoModule } from "@kavo/nest";
import { createInfrastructure } from "@kavo/prisma";
import { PrismaClient, Prisma } from "@prisma/client";
import { Book } from "./book.entity.js";
import { BookController } from "./book.controller.js";

const prisma = new PrismaClient();

@Module({
  imports: [
    KavoModule.forRoot({
      infrastructure: createInfrastructure(prisma, {
        datamodel: Prisma.dmmf.datamodel,
        entities: [Book],
      }),
    }),
  ],
  controllers: [BookController],
})
export class AppModule {}
```

The controller itself is ordinary — nothing Prisma-specific reaches it:

```ts
@Kavo(Book)
@Controller("books")
export class BookController {}
```

### `createInfrastructure(client, options)`

| Option                   | Required | Meaning                                                                  |
| ------------------------ | -------- | ------------------------------------------------------------------------ |
| `datamodel`              | yes      | `Prisma.dmmf.datamodel` from your generated client — the metadata source |
| `entities`               | yes      | **Every** marker class this Kavo root will use                           |
| `caseInsensitiveFilters` | no       | Defaults to `true`; see below                                            |

`entities` must be complete, not just the models you decorate. It is the
lookup table that resolves a relation on one model back to the target
model's marker class — a missing entry surfaces when a relation is included,
not at bootstrap.

`createPrismaKavo(client, options)` is the same thing folded into a
`createKavo` call for programmatic (non-Nest) use.

## Case-insensitive filtering is database-dependent

`caseInsensitiveFilters` defaults to **`true`**, which makes `ilike` and
friends emit Prisma's `mode: "insensitive"`. Only **PostgreSQL and MongoDB**
support it — MySQL, SQLite, and SQL Server reject it outright, so a query
that should have returned rows fails instead.

```ts
createInfrastructure(prisma, {
  datamodel: Prisma.dmmf.datamodel,
  entities: [Book],
  caseInsensitiveFilters: false, // MySQL, SQLite, SQL Server
});
```

Note this default is the opposite of `@kavo/mikroorm`'s, where the same
setting defaults to off — the two adapters can detect different amounts
about the database underneath them.

## Where to go next

- Routes, allowed, relations, per-operation overrides → `kavo-decorator`
- The `filter`/`sort`/`fields`/`include` wire grammar → `query-grammar`
- Narrowing request/response shapes → `dto-slots`
- Soft delete (declared in config, as with every non-TypeORM adapter) →
  `soft-delete`
