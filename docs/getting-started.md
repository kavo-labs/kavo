# Getting started

Kavo turns your ORM entities into a full REST CRUD API. Define the entity once, add one decorator, and you get create, read, update, delete, filtering, sorting, pagination, nested includes, and field selection — with no hand-written controller methods.

Today Kavo supports NestJS as the framework, over TypeORM, Prisma, Mongoose, or MikroORM as the ORM. This guide uses Nest + TypeORM as its example stack; see [Nest + Prisma](/integrations/nest/prisma), [Nest + Mongoose](/integrations/nest/mongoose), and [Nest + MikroORM](/integrations/nest/mikroorm) for the equivalents.

## Requirements

- **Node.js 20 or newer** — every `@kavo/*` package declares `engines.node: ">=20"`, so your package manager will warn (or, under `engine-strict`, refuse) an install on an older release.
- **ESM** — every `@kavo/*` package ships as ESM only, with no CommonJS entry point. Your app must be ESM too (`"type": "module"` in its `package.json`), which the default `nest new` scaffold is not.
- **Decorator metadata** — `experimentalDecorators` and `emitDecoratorMetadata` must be on. `@Kavo()` reads your entity's decorator metadata, and so do TypeORM's columns and Nest's DI.

A `tsconfig.json` that satisfies all three:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "strict": true,
    "skipLibCheck": true
  }
}
```

`useDefineForClassFields: false` is load-bearing at `ES2022` and above. With it on, every declared field is emitted as a real class field, so a fresh entity carries an own key for _every_ column — set to `undefined` — whether the adapter hydrated it or not. A partially-hydrated entity then looks fully populated: Kavo projects a response with `Object.keys(entity)` when no field selection narrows it, so those columns surface in the body as `undefined` rather than being absent, and TypeORM's persistence diffing reads them as explicit values. With it off, only fields with an initializer are assigned and the rest are left to the prototype — which is what Kavo's own packages and both example apps compile with.

## Install

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

- `@kavo/core` — the engine.
- `@kavo/nest` — generates the NestJS routes.
- `@kavo/typeorm` — adapts Kavo to a TypeORM `DataSource`. See [Nest + TypeORM](/integrations/nest/typeorm) for the full wiring.

### Peer dependencies

Kavo never bundles your framework or your ORM. Each package declares what it expects as a peer — a Nest app already has most of them:

- **`@kavo/core`** — none. It has zero runtime dependencies.
- **`@kavo/nest`** — `@nestjs/common` and `@nestjs/core` (`^10.0.0 || ^11.0.0`), `reflect-metadata` (`^0.1.13 || ^0.2.0`), `rxjs` (`^7.8.0`).
- **`@kavo/typeorm`** — `typeorm` (`^0.3.20 || ^1.0.0`).
- **`@kavo/prisma`** — `@prisma/client` (`^5.0.0 || ^6.0.0`).
- **`@kavo/mongoose`** — `mongoose` (`^7.0.0 || ^8.0.0`).
- **`@kavo/mikroorm`** — `@mikro-orm/core` (`^7.0.0`), plus the MikroORM driver package your database needs.
- **`@kavo/graphql`** — `graphql` (`^17.0.0`), optional.
- **`@kavo/mcp`** — `@modelcontextprotocol/sdk` (`^1.0.0`), optional.

Three of `@kavo/nest`'s own peers are declared **optional** — `@nestjs/swagger` (`^8.0.0 || ^11.0.0`) for generated OpenAPI docs, `graphql` (`^17.0.0`) for the GraphQL controller, and `@modelcontextprotocol/sdk` (`^1.0.0`) for the MCP controller — so nothing makes you configure a protocol you don't serve.

**Both hops say optional**, which is what keeps them out of the tree. `@kavo/nest` depends on `@kavo/graphql` and `@kavo/mcp` outright, so your package manager resolves the binding and then the binding's peer; while those two declared theirs required, npm, pnpm and bun installed `graphql` and the MCP SDK into every REST-only app anyway. Both are optional on both hops now, so a REST-only install gets neither, and you add the protocol library when you opt into the protocol.

### GraphQL and MCP

The same entities can be served over GraphQL and the Model Context Protocol, through the same engine.

Inside a Nest app you never install the Kavo bindings directly — `@kavo/nest` depends on both `@kavo/graphql` and `@kavo/mcp`. Add only the protocol library you intend to use:

::: code-group

```bash [pnpm]
pnpm add graphql                    # GraphQL
pnpm add @modelcontextprotocol/sdk  # MCP
```

```bash [npm]
npm install graphql                    # GraphQL
npm install @modelcontextprotocol/sdk  # MCP
```

```bash [yarn]
yarn add graphql                    # GraphQL
yarn add @modelcontextprotocol/sdk  # MCP
```

```bash [bun]
bun add graphql                    # GraphQL
bun add @modelcontextprotocol/sdk  # MCP
```

:::

Both bindings are host-framework-agnostic, so they also work without Nest. Installed that way you add the Kavo package yourself, alongside `@kavo/core` and whichever ORM adapter you use:

::: code-group

```bash [pnpm]
pnpm add @kavo/core @kavo/graphql graphql
pnpm add @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

```bash [npm]
npm install @kavo/core @kavo/graphql graphql
npm install @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

```bash [yarn]
yarn add @kavo/core @kavo/graphql graphql
yarn add @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

```bash [bun]
bun add @kavo/core @kavo/graphql graphql
bun add @kavo/core @kavo/mcp @modelcontextprotocol/sdk
```

:::

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

```
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

## Soft delete

Give an entity a delete-marker column and Kavo stops actually deleting rows on `DELETE /books/:id` — it stamps the marker instead, and every read (`GET /books`, `GET /books/:id`, includes) automatically excludes stamped rows, with no query changes on your side:

```ts
import { Entity, PrimaryGeneratedColumn, Column, DeleteDateColumn } from "typeorm";

@Entity()
export class Book {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}
```

That column alone is enough for `deleteOne` to soft-delete and for reads to hide deleted rows. Two more capabilities are opt-in, one config line each, because each is a piece of public API worth stating on purpose rather than getting for free:

- **Restore** — `@Kavo(Book, { softDelete: { strategy: "soft" } })` turns on `PATCH /books/:id/restore`, which clears the marker and returns the row again.
- **Purge** — `@Kavo(Book, { operations: { purgeOne: true } })` turns on `DELETE /books/:id/purge`, which permanently removes an already-soft-deleted row.

Both can be combined. Attempting to restore a row that isn't deleted, or purge one that is still live, returns a 409, not a silent no-op. Pass `?withDeleted=true` on a read to opt back into seeing soft-deleted rows for that request. See [Soft delete, restore & purge](/internals/architecture/11-soft-delete) for the full behavior — unique-index caveats, cascades, and what's deliberately not built (bulk restore/purge).
