# Nest + MikroORM

Kavo's engine (`@kavo/core`) is ORM-agnostic — it talks to your data through a small adapter seam. `@kavo/nest` generates the routes; `@kavo/mikroorm` adapts Kavo to a MikroORM `EntityManager`. This is the complete, minimal wiring for that combination.

<script setup lang="ts">
import StackPicker from "../../.vitepress/theme/components/StackPicker.vue";
</script>

<StackPicker orm="mikroorm" />

If you haven't yet, read [Getting started](/getting-started) first — this page assumes you already know what `@Kavo()` does and just needs the app-wiring.

::: code-group

```bash [pnpm]
pnpm add @kavo/core @kavo/nest @kavo/mikroorm
```

```bash [npm]
npm install @kavo/core @kavo/nest @kavo/mikroorm
```

```bash [yarn]
yarn add @kavo/core @kavo/nest @kavo/mikroorm
```

```bash [bun]
bun add @kavo/core @kavo/nest @kavo/mikroorm
```

:::

`@kavo/mikroorm` expects `@mikro-orm/core` (`^7.0.0`) as a peer, plus whichever MikroORM driver package your database needs (`@mikro-orm/postgresql`, `@mikro-orm/mysql`, `@mikro-orm/sqlite`, …) — add them to the command above if your app doesn't already have them — and `@kavo/nest` expects the Nest runtime your app already has. See [Peer dependencies](/getting-started#peer-dependencies) for the full list with versions, and [Requirements](/getting-started#requirements) for the Node and TypeScript prerequisites.

## Zero-config wiring

A plain MikroORM entity. Like TypeORM and unlike Prisma, there is nothing to declare twice: an `@Entity()` class is a real runtime class carrying its own metadata, so the class **is** the entity identity `@Kavo()` wants — no marker class and no entity list beyond the one MikroORM already has:

```ts
// book.entity.ts
import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity()
export class Book {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  title!: string;
}
```

`@Kavo(Book)` with no config object — zero-config, the full CRUD surface for free:

```ts
// book.controller.ts
import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Book } from "./book.entity.js";

@Kavo(Book)
@Controller("books")
export class BookController {}
```

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { KavoModule } from "@kavo/nest";
import { createInfrastructure } from "@kavo/mikroorm";
import { MikroORM } from "@mikro-orm/core";
import { defineConfig } from "@mikro-orm/postgresql";
import { Book } from "./book.entity.js";
import { BookController } from "./book.controller.js";

const orm = await MikroORM.init(defineConfig({ dbName: process.env.DB_NAME!, entities: [Book] }));

@Module({
  imports: [
    KavoModule.forRoot({
      infrastructure: createInfrastructure(orm),
    }),
  ],
  controllers: [BookController],
})
export class AppModule {}
```

`createInfrastructure(orm)` derives both Kavo's entity metadata and its repository adapter from the ORM's own registered entities — nothing to declare twice.

It takes the `MikroORM` instance rather than an `EntityManager` on purpose. MikroORM is a Unit-of-Work ORM whose `EntityManager` holds an identity map, so every Kavo operation calls `orm.em.fork()` to get its own — the same isolation a request-scoped `RequestContext` gives a hand-written MikroORM app. You do not need to set up `RequestContext` middleware for Kavo's routes.

## Case-insensitive filtering is opt-in

`filter[name][ilike]=ada%` maps to MikroORM's `$ilike`, which **only PostgreSQL supports** — every other driver receives the token verbatim and fails with a syntax error. MikroORM exposes no way to detect this, so it is a declared setting, defaulting to off:

```ts
createInfrastructure(orm, { caseInsensitiveFilters: true }); // PostgreSQL
```

With it off, `ilike` behaves exactly like `like`. On SQLite that is not even a loss — SQLite's own `LIKE` is already ASCII case-insensitive.

## What's different from `@kavo/typeorm`

**Soft delete is declared, not inferred.** MikroORM has no `@DeleteDateColumn` equivalent — its soft-delete pattern is a user-defined `@Filter`, which Kavo cannot detect — so add an ordinary property and name it in config:

```ts
@Kavo(Book, { softDelete: { field: "deletedAt" } })
@Controller("books")
export class BookController {}
```

That declaration is what generates the `PATCH /books/:id/restore` route ([ADR-0013](/internals/adr/0013-config-declared-soft-delete-operations)). Do not _also_ enable a MikroORM soft-delete `@Filter`: Kavo owns the scoping, and a second default-on predicate would quietly defeat `withDeleted`.

**Filtering and sorting across a relation work natively.** MikroORM nests relation paths in its own query language, so `filter[author.name][eq]=Ada` needs no join bookkeeping — just the allowlist entry, which is its own decision independent of whether the relation may be included:

```ts
@Kavo(Book, {
  allowlists: { filterable: ["title", "author.name"] },
  relations: { edges: { author: { includable: true } } },
})
```

**`ESCAPE` in `like` patterns depends on your driver.** MikroORM cannot attach an `ESCAPE` clause, so `\` escaping a literal `%`/`_` works on PostgreSQL and MySQL (which default to backslash) but not on SQLite.

**`@Property({ hidden: true })` wins over a Kavo DTO.** Rows are converted with MikroORM's own `toObject()`, so a hidden property is gone before core sees it, even if a DTO names it.

A complete, runnable app using all of the above lives in [`examples/nest-mikroorm`](https://github.com/kavo-labs/kavo/tree/main/examples/nest-mikroorm) — the same Pet domain `examples/nest-typeorm` serves, under this adapter.

Full design notes, including the metadata mapping and the error-mapping table: [MikroORM adapter](/internals/architecture/17-mikroorm-adapter).
