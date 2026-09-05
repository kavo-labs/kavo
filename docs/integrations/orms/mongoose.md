# Nest + Mongoose

Kavo's engine (`@kavo/core`) is ORM-agnostic. It talks to your data through a small adapter seam. `@kavo/nest` generates the routes, and `@kavo/mongoose` adapts Kavo to a Mongoose model. Below is the complete, minimal wiring for that combination.

<script setup lang="ts">
import StackPicker from "../../.vitepress/theme/components/StackPicker.vue";
</script>

<StackPicker orm="mongoose" />

If you haven't yet, read [Introduction](/getting-started/introduction) first. This page assumes you already know what `@Kavo()` does and just needs the app wiring.

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

`@kavo/mongoose` expects `mongoose` (`^7.0.0 || ^8.0.0`) as a peer. Add it to the command above if your app doesn't already have it. `@kavo/nest` expects the Nest runtime your app already has. See [Peer dependencies](/getting-started/installation#peer-dependencies) for the full list with versions, and [Requirements](/getting-started/requirements) for the Node and TypeScript prerequisites.

## Zero-config wiring

A plain Mongoose model. Unlike Prisma, there is nothing to declare twice. A Mongoose model is already a constructor, so the model **is** the entity identity `@Kavo()` wants: no marker class and no entity list (see [ADR-0018](/internals/adr/0018-mongoose-models-are-entity-identities) for why):

```ts
// book.model.ts
import mongoose, { Schema } from "mongoose";

const bookSchema = new Schema({
  title: { type: String, required: true },
});

export const Book = mongoose.model("Book", bookSchema);
```

`@Kavo(Book)` needs no config object. That's zero-config: the full CRUD surface for free.

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

`createInfrastructure(connection)` derives both Kavo's entity metadata and its repository adapter from the connection's own registered models. Nothing to declare twice. Define your models at module scope, before connecting: `@Kavo()` generates routes at class-decoration time, and Mongoose buffers commands until `connect()` resolves.

## What's different from a SQL adapter

### Ids are strings

MongoDB's primary key is `_id`, and `@kavo/mongoose` renders every `ObjectId` as a hex string at the adapter boundary. Responses are keyed by `_id`, not a numeric `id`, so DTOs declare `_id = ""`. A malformed id is a 404, not a 500.

### Soft delete is declared, not inferred

Mongoose has no `@DeleteDateColumn` equivalent, so add an ordinary path and name it in config:

```ts
@Kavo(Book, { softDelete: { field: "deletedAt" } })
@Controller("books")
export class BookController {}
```

That declaration is what generates the `PATCH /books/:id/restore` route ([ADR-0013](/internals/adr/0013-config-declared-soft-delete-operations)).

### A `ref` path is both the relation and the foreign key

One schema path gives you all of these:

```
GET  /books?include=author            # embedded, loaded by populate
GET  /books?filter[author][eq]=<id>   # filterable, because it's the FK too
POST /books  {"author":"<id>"}        # writable by id (ADR-0014)
```

Mark it includable the same way as any other relation:

```ts
@Kavo(Book, { relations: { edges: { author: { includable: true } } } })
```

### Virtual fields

Mongoose's own mechanism is a **schema virtual**: a getter registered on the schema, never stored:

```ts
const bookSchema = new Schema({ title: String, year: Number });
bookSchema.virtual("displayTitle").get(function () {
  return `${this.title} (${this.year})`;
});
```

This is **invisible to Kavo entirely**. `@kavo/mongoose` builds `FieldMetadata` from `schema.paths` only, and Mongoose keeps a virtual in `schema.virtuals`, a separate map — so `displayTitle` produces no metadata entry at all. Naming it in `allowlists.filterable`/`sortable`/`selectable` is a bootstrap error, the same as naming a nonexistent path. Nor does it survive at the adapter boundary even for a plain response: every row this adapter hands to core has already gone through `document.toObject({ getters: false, virtuals: false, ... })` (see [Mongoose adapter](/internals/architecture/15-mongoose-adapter)), which drops both getters and virtuals on purpose — a hydrated `Document`'s own getters are not something core should ever see accidentally, unlike TypeORM's class instances.

To surface a virtual over HTTP, reach for a **custom operation** that reads the hydrated Mongoose document directly (`context.repository` gives you the model through `@kavo/mongoose`'s own seam, or inject the model separately) and returns its own shape (`dto.output`). See [Virtual fields](/features/virtual-fields) for the full picture (including the two ORMs that _can_ push a derived field into `WHERE`/`ORDER BY`) and [ADR-0050](/internals/adr/0050-derived-fields-come-from-orm-metadata) for the design.

### Filtering across a relation is refused

`filter[author.name]` returns a 400 rather than silently matching nothing. MongoDB resolves a dotted path inside a document, never across a `ref`. Dotted paths into an embedded object still work normally.

A complete, runnable app using all of the above lives in [`examples/nest-mongoose`](https://github.com/kavo-labs/kavo/tree/main/examples/nest-mongoose).
