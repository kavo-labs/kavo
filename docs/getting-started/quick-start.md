# Quick start

## Zero-config `@Kavo()`

Given a plain TypeORM entity:

```ts
// book.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column()
  author!: string;
}
```

put `@Kavo(Book)` on an empty Nest controller:

```ts
// book.controller.ts
import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Book } from "./book.entity.js";

@Kavo(Book)
@Controller("books")
export class BookController {}
```

That's it — no config object, no service, no repository wiring in the controller. This generates:

| Method   | Route        | What it does                                |
| -------- | ------------ | ------------------------------------------- |
| `POST`   | `/books`     | Create a book                               |
| `GET`    | `/books`     | List books — filtering, sorting, pagination |
| `GET`    | `/books/:id` | Get one book                                |
| `PUT`    | `/books/:id` | Replace a book                              |
| `PATCH`  | `/books/:id` | Partially update a book                     |
| `DELETE` | `/books/:id` | Delete a book                               |

Requests and responses are shaped straight from `Book`'s own columns — there's no DTO to write until you want to narrow or reshape what's exposed. The list route (`GET /books`) already understands query-string filtering and sorting out of the box, for example:

```http
GET /books?filter[author][eq]=Tolkien&sort=-title&limit=10&offset=0
```

## Wiring it into a Nest app

`@Kavo`-decorated controllers need one thing from the app: a `KavoModule` that hands them infrastructure (a `DataSource`, in the TypeORM case).

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { KavoModule } from "@kavo/nest";
import { createInfrastructure } from "@kavo/typeorm";
import { DataSource } from "typeorm";
import { BookController } from "./book.controller.js";

const dataSource = await new DataSource({/* ...your TypeORM connection options... */}).initialize();

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

`KavoModule` discovers every `@Kavo`-decorated controller registered in `controllers: [...]` and binds each one's generated service — no per-entity registration step.

See [Soft delete](/features/soft-delete) for how to add restore/purge to an entity, and [Configuration](/guides/configuration/) once zero-config isn't enough.
