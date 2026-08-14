# Nest + Prisma

Kavo's engine (`@kavo/core`) is ORM-agnostic — it talks to your data through a small adapter seam. `@kavo/nest` generates the routes; `@kavo/prisma` adapts Kavo to a Prisma Client. This is the complete, minimal wiring for that combination.

<script setup lang="ts">
import StackPicker from "../../.vitepress/theme/components/StackPicker.vue";
</script>

<StackPicker orm="prisma" />

If you haven't yet, read [Getting started](/getting-started) first — this page assumes you already know what `@Kavo()` does and just needs the app-wiring.

::: code-group

```bash [pnpm]
pnpm add @kavo/core @kavo/nest @kavo/prisma
```

```bash [npm]
npm install @kavo/core @kavo/nest @kavo/prisma
```

```bash [yarn]
yarn add @kavo/core @kavo/nest @kavo/prisma
```

```bash [bun]
bun add @kavo/core @kavo/nest @kavo/prisma
```

:::

`@kavo/prisma` expects `@prisma/client` (`^5.0.0 || ^6.0.0`) as a peer — add it to the command above if your app doesn't already have it — and `@kavo/nest` expects the Nest runtime your app already has. See [Peer dependencies](/getting-started#peer-dependencies) for the full list with versions, and [Requirements](/getting-started#requirements) for the Node and TypeScript prerequisites.

## Zero-config wiring

Prisma generates no runtime class for a model, so each entity needs a small **marker class** — an empty class whose name matches the Prisma model, used purely as a stable identity for `@Kavo()` (see [ADR-0017](/internals/adr/0017-prisma-marker-classes-and-entity-registry) for why):

```ts
// book.entity.ts
export class Book {
  id!: number;
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

`entities` must list every marker class this Kavo root will use — that's how a relation on one model resolves back to the right marker class for its target model. Set `caseInsensitiveFilters: false` in that same options object if your database isn't Postgres or MongoDB (MySQL, SQLite, and SQL Server reject Prisma's `mode: "insensitive"` outright).
