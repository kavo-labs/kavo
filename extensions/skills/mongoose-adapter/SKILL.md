---
name: mongoose-adapter
description: Wiring @kavo/mongoose into a Nest app — models as entity identities, ObjectId rendered as hex strings and _id-keyed DTOs, declared soft delete, ref paths as relation and foreign key at once, and the cross-relation filter that is refused. Use when adding Kavo to a Mongoose/MongoDB project, or answering "how do I use Kavo with Mongoose" and "why is my id a string" questions.
---

# Mongoose adapter

`@kavo/mongoose` adapts Kavo to a Mongoose connection. The engine, routes,
query grammar, and DTO slots are identical to every other adapter — the
differences below come from MongoDB itself, not from Kavo.

```bash
npm install @kavo/core @kavo/nest @kavo/mongoose
```

`mongoose` (`^7.0.0 || ^8.0.0`) is a peer dependency.

## The model _is_ the entity identity

Unlike Prisma, there is **nothing to declare twice**. A Mongoose model is
already a constructor, so it is the identity `@Kavo()` wants — no marker
class, no entity list (ADR-0018).

```ts
// book.model.ts
import mongoose, { Schema } from "mongoose";

const bookSchema = new Schema({
  title: { type: String, required: true },
});

export const Book = mongoose.model("Book", bookSchema);
```

```ts
@Kavo(Book) // the model itself
@Controller("books")
export class BookController {}
```

## Wiring

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { KavoModule } from "@kavo/nest";
import { createInfrastructure } from "@kavo/mongoose";
import mongoose from "mongoose";
import { BookController } from "./book.controller.js";

await mongoose.connect(process.env.MONGO_URL!);

@Module({
  imports: [
    KavoModule.forRoot({
      infrastructure: createInfrastructure(mongoose.connection),
    }),
  ],
  controllers: [BookController],
})
export class AppModule {}
```

`createInfrastructure(connection)` derives both the entity metadata and the
repository adapter from the connection's own registered models.

**Define models at module scope, before connecting.** `@Kavo()` generates its
routes at class-decoration time, and Mongoose buffers commands until
`connect()` resolves — a model created after the decorator runs is not
registered in time.

## Ids are strings, and the field is `_id`

MongoDB's primary key is `_id`, and the adapter renders every `ObjectId` as a
hex **string** at the boundary. So responses are keyed by `_id`, not by a
numeric `id`, and a DTO declares it as a string:

```ts
export class BookItemDto {
  _id = "";
  title = "";
}
```

A malformed id is a **404, not a 500** — a string that cannot be an
`ObjectId` names a document that cannot exist.

## Soft delete is declared, not inferred

Mongoose has no `@DeleteDateColumn` equivalent, so add an ordinary schema
path and name it in config. That declaration is what generates
`PATCH /books/:id/restore` (ADR-0013):

```ts
@Kavo(Book, { softDelete: { field: "deletedAt" } })
@Controller("books")
export class BookController {}
```

## A `ref` path is the relation _and_ the foreign key

One schema path gives you all three at once:

```
GET  /books?include=author            # embedded, loaded via populate
GET  /books?filter[author][eq]=<id>   # filterable — it is the FK too
POST /books  {"author":"<id>"}        # writable by id (ADR-0014)
```

Mark it includable like any other relation:

```ts
@Kavo(Book, { relations: { edges: { author: { includable: true } } } })
@Controller("books")
export class BookController {}
```

**Filtering across a relation is refused.** `filter[author.name]` returns a
**400**, not an empty result — MongoDB resolves a dotted path inside a
document, never across a `ref`. Dotted paths into an _embedded_ object work
normally; it is only traversal through a reference that has no equivalent.

## Where to go next

- Routes, allowed, relations, per-operation overrides → `kavo-decorator`
- The `filter`/`sort`/`fields`/`include` wire grammar → `query-grammar`
- Narrowing request/response shapes → `dto-slots`
- Restore/purge semantics → `soft-delete`
