# Nest + TypeORM

Kavo's engine (`@kavo/core`) is ORM-agnostic. It talks to your data through a small adapter seam. `@kavo/nest` generates the routes, and `@kavo/typeorm` adapts Kavo to a TypeORM `DataSource`. Below is the complete, minimal wiring for that combination.

<script setup lang="ts">
import StackPicker from "../../.vitepress/theme/components/StackPicker.vue";
</script>

<StackPicker orm="typeorm" />

If you haven't yet, read [Introduction](/getting-started/introduction) first. This page assumes you already know what `@Kavo()` does and just needs the app wiring.

::: code-group

```bash [pnpm]
pnpm add @kavo/core @kavo/nest @kavo/typeorm
```

```bash [npm]
npm install @kavo/core @kavo/nest @kavo/typeorm
```

```bash [yarn]
yarn add @kavo/core @kavo/nest @kavo/typeorm
```

```bash [bun]
bun add @kavo/core @kavo/nest @kavo/typeorm
```

:::

`@kavo/typeorm` expects `typeorm` (`^0.3.20 || ^1.0.0`) as a peer. Add it to the command above if your app doesn't already have it. `@kavo/nest` expects the Nest runtime your app already has. See [Peer dependencies](/getting-started/installation#peer-dependencies) for the full list with versions, and [Requirements](/getting-started/requirements) for the Node and TypeScript prerequisites.

## Zero-config wiring

A plain TypeORM entity:

```ts
// book.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
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
import { createInfrastructure } from "@kavo/typeorm";
import { DataSource } from "typeorm";
import { Book } from "./book.entity.js";
import { BookController } from "./book.controller.js";

const dataSource = await new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [Book],
}).initialize();

@Module({
  imports: [
    KavoModule.forRoot({
      infrastructure: createInfrastructure(dataSource),
    }),
  ],
  controllers: [BookController],
})
export class AppModule {}
```

`createInfrastructure(dataSource)` derives both Kavo's entity metadata and its repository adapter from the `DataSource`'s own TypeORM metadata. Nothing to declare twice.

A complete, runnable app using all of the above lives in [`examples/nest-typeorm`](https://github.com/kavo-labs/kavo/tree/main/examples/nest-typeorm).
