# Nest + Mongoose

Kavo's engine (`@kavo/core`) is ORM-agnostic — it talks to your data through a small adapter seam. `@kavo/nest` generates the routes; `@kavo/mongoose` adapts Kavo to a Mongoose model. This is the complete, minimal wiring for that combination.

<script setup lang="ts">
import StackPicker from "../../.vitepress/theme/components/StackPicker.vue";
</script>

<StackPicker orm="mongoose" />

If you haven't yet, read [Getting started](/getting-started) first — this page assumes you already know what `@Kavo()` does and just needs the app-wiring.

::: code-group

```bash [pnpm]
pnpm add @kavo/core @kavo/nest @kavo/mongoose
```

```bash [npm]
npm install @kavo/core @kavo/nest @kavo/mongoose
```

```bash [yarn]
yarn add @kavo/core @kavo/nest @kavo/mongoose
```

```bash [bun]
bun add @kavo/core @kavo/nest @kavo/mongoose
```

:::

`@kavo/mongoose` expects `mongoose` (`^7.0.0 || ^8.0.0`) as a peer — add it to the command above if your app doesn't already have it — and `@kavo/nest` expects the Nest runtime your app already has. See [Peer dependencies](/getting-started#peer-dependencies) for the full list with versions, and [Requirements](/getting-started#requirements) for the Node and TypeScript prerequisites.

## Zero-config wiring

A plain Mongoose model. Unlike Prisma, there is nothing to declare twice: a Mongoose model is already a constructor, so the model **is** the entity identity `@Kavo()` wants — no marker class and no entity list (see [ADR-0018](/internals/adr/0018-mongoose-models-are-entity-identities) for why):

```ts
// book.model.ts
import mongoose, { Schema } from "mongoose";

const bookSchema = new Schema({
  title: { type: String, required: true },
});

export const Book = mongoose.model("Book", bookSchema);
```

`@Kavo(Book)` with no config object — zero-config, the full CRUD surface for free:

```ts
// book.controller.ts
import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Book } from "./book.model.js";

@Kavo(Book)
@Controller("books")
export class BookController {}
```

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

`createInfrastructure(connection)` derives both Kavo's entity metadata and its repository adapter from the connection's own registered models — nothing to declare twice. Define your models at module scope, before connecting: `@Kavo()` generates routes at class-decoration time, and Mongoose buffers commands until `connect()` resolves.

## What's different from a SQL adapter

**Ids are strings.** MongoDB's primary key is `_id`, and `@kavo/mongoose` renders every `ObjectId` as a hex **string** at the adapter boundary. Responses are keyed by `_id`, not a numeric `id`, so DTOs declare `_id = ""`. A malformed id is a 404, not a 500.

**Soft delete is declared, not inferred.** Mongoose has no `@DeleteDateColumn` equivalent, so add an ordinary path and name it in config:

```ts
@Kavo(Book, { softDelete: { field: "deletedAt" } })
@Controller("books")
export class BookController {}
```

That declaration is what generates the `PATCH /books/:id/restore` route ([ADR-0013](/internals/adr/0013-config-declared-soft-delete-operations)).

**A `ref` path is both the relation and the foreign key.** One schema path gives you all of these:

```
GET  /books?include=author            # embedded, loaded by populate
GET  /books?filter[author][eq]=<id>   # filterable, because it's the FK too
POST /books  {"author":"<id>"}        # writable by id (ADR-0014)
```

Mark it includable the same way as any other relation:

```ts
@Kavo(Book, { relations: { edges: { author: { includable: true } } } })
```

**Filtering _across_ a relation is refused.** `filter[author.name]` returns a 400 rather than silently matching nothing — MongoDB resolves a dotted path inside a document, never across a `ref`. Dotted paths into an embedded object work normally.

A complete, runnable app using all of the above lives in [`examples/nest-mongoose`](https://github.com/kavo-labs/kavo/tree/main/examples/nest-mongoose).
