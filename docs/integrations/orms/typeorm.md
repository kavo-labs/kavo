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

## Virtual fields

A `@VirtualColumn` is a real TypeORM column with no backing storage — its `query` function is the same alias-parameterized SQL fragment TypeORM itself uses to populate the property on load. Kavo reads it off the entity's metadata and inlines it into `WHERE`/`ORDER BY` too, so it works like any other column once opted in:

```ts
// book.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, VirtualColumn } from "typeorm";

@Entity()
export class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @VirtualColumn({ query: (alias) => `LOWER(${alias}.title)` })
  titleLower!: string;
}
```

```ts
@Kavo(Book, {
  allowlists: { filterable: ["titleLower"], sortable: ["titleLower"], selectable: ["id", "title", "titleLower"] },
})
```

```
GET /books?filter[titleLower][eq]=dune&sort=titleLower
```

A derived field is **opt-in** to `filterable`/`sortable`/`selectable`, the same rule a relation follows — leave it off `allowlists` and it never appears, is never filterable, and is never sortable. `SELECT` needs no extra config beyond `selectable`: since it's a real TypeORM column, ordinary entity hydration already includes it.

### The other way: a plain class getter

TypeORM's QueryBuilder hands back real entity **class instances**, not plain objects, so an ordinary JavaScript getter also reaches the response, with no decorator and no ORM involvement at all:

```ts
// book.entity.ts
@Entity()
export class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column()
  year!: number;

  get displayTitle(): string {
    return `${this.title} (${this.year})`;
  }
}
```

A getter carries no `FieldMetadata` — Kavo's metadata seam only ever sees `@Column`/`@VirtualColumn`, so there is nothing to opt into `allowlists` and no way to filter or sort on it. It reaches a response only through a **registered DTO** that names it:

```ts
class BookItemDto {
  id = 0;
  title = "";
  displayTitle = ""; // the initializer's value is never used — see below
}

@Kavo(Book, { dto: { item: BookItemDto } })
```

The DTO's own `displayTitle = ""` initializer only registers the **key**: `DefaultSerializer` reads the _value_ straight off the real `Book` instance at response time (`source.displayTitle`), which is what invokes the getter. Leave `displayTitle` off the DTO and it never appears — with no DTO at all, the entity-derived default projection is `metadata.fields` only, and a getter is never in `metadata.fields`.

Reach for `@VirtualColumn` when the value needs to be filterable/sortable, or you want it without hand-writing an `item`/`list` DTO. Reach for a plain getter when it's genuinely response-only and you already have (or want) an explicit DTO. See [Virtual fields](/features/virtual-fields) for the full picture (including a correlated-subquery example for a relation count) and [ADR-0050](/internals/adr/0050-derived-fields-come-from-orm-metadata) for the design.

A complete, runnable app using all of the above lives in [`examples/nest-typeorm`](https://github.com/kavo-labs/kavo/tree/main/examples/nest-typeorm).
