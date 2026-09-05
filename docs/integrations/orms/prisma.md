# Nest + Prisma

Kavo's engine (`@kavo/core`) is ORM-agnostic. It talks to your data through a small adapter seam. `@kavo/nest` generates the routes, and `@kavo/prisma` adapts Kavo to a Prisma Client. Below is the complete, minimal wiring for that combination.

<script setup lang="ts">
import StackPicker from "../../.vitepress/theme/components/StackPicker.vue";
</script>

<StackPicker orm="prisma" />

If you haven't yet, read [Introduction](/getting-started/introduction) first. This page assumes you already know what `@Kavo()` does and just needs the app wiring.

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

`@kavo/prisma` expects `@prisma/client` (`^5.0.0 || ^6.0.0`) as a peer. Add it to the command above if your app doesn't already have it. `@kavo/nest` expects the Nest runtime your app already has. See [Peer dependencies](/getting-started/installation#peer-dependencies) for the full list with versions, and [Requirements](/getting-started/requirements) for the Node and TypeScript prerequisites.

## Zero-config wiring

Prisma generates no runtime class for a model, so each entity needs a small **marker class**: an empty class whose name matches the Prisma model. It exists purely to give `@Kavo()` a stable identity to key off (see [ADR-0017](/internals/adr/0017-prisma-marker-classes-and-entity-registry) for why):

```ts
// book.entity.ts
export class Book {
  id!: number;
  title!: string;
}
```

`@Kavo(Book)` needs no config object. That's zero-config: the full CRUD surface for free.

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

List every marker class this Kavo root will use in `entities`. That's how a relation on one model resolves back to the right marker class for its target model. Set `caseInsensitiveFilters: false` in that same options object if your database isn't Postgres or MongoDB (MySQL, SQLite, and SQL Server reject Prisma's `mode: "insensitive"` outright).

## Virtual fields

Prisma has no schema-level virtual/generated-column syntax. Its one mechanism is a **client extension**'s `result` field, computed in JavaScript on the client after the query runs:

```ts
const prisma = new PrismaClient().$extends({
  result: {
    book: {
      displayTitle: {
        needs: { title: true, year: true },
        compute(book) {
          return `${book.title} (${book.year})`;
        },
      },
    },
  },
});
```

This is **invisible to Kavo entirely** — `@kavo/prisma` builds `FieldMetadata` from `Prisma.dmmf.datamodel`, which knows nothing about a client extension's `result` fields, so `displayTitle` produces no metadata entry at all (not an entry with an absent `derivedExpression` — no entry, period). It can never be named in `allowlists.filterable`/`sortable`/`selectable`; doing so is a bootstrap error the same way naming a nonexistent column would be. There is also no adapter-level hook here: `createInfrastructure`'s `PrismaClient` and your extended client are two different objects, and Kavo's generated routes query through the former.

To actually surface an extension field over HTTP, reach for a **custom operation** that queries the extended client directly and returns its own shape (`dto.output`) — the extension's field never needs to pass through `@kavo/prisma`'s adapter at all. See [Virtual fields](/features/virtual-fields) for the full picture (including the other three ORMs, which _can_ push a derived field into `WHERE`/`ORDER BY`) and [ADR-0046](/internals/adr/0046-derived-fields-come-from-orm-metadata) for the design.
