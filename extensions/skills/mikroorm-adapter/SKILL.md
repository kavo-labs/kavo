---
name: mikroorm-adapter
description: Wiring @kavo/mikroorm into a Nest app — passing the MikroORM instance rather than an EntityManager, why no RequestContext middleware is needed, opt-in case-insensitive filtering, declared soft delete, and native cross-relation filtering. Use when adding Kavo to a MikroORM project, or answering "how do I use Kavo with MikroORM" and "why does ilike not work" questions.
---

# MikroORM adapter

`@kavo/mikroorm` adapts Kavo to a MikroORM `EntityManager`. Setup is closest
to the TypeORM path — a decorated entity class is the identity, so nothing is
declared twice — with the differences below.

```bash
npm install @kavo/core @kavo/nest @kavo/mikroorm
```

`@mikro-orm/core` (`^7.0.0`) is a peer dependency, plus whichever driver
package your database needs (`@mikro-orm/postgresql`, `@mikro-orm/mysql`,
`@mikro-orm/sqlite`, …), and `@mikro-orm/decorators` if you declare entities
with decorators (below).

## The entity class is the identity

**Decorators moved out of `@mikro-orm/core` in v7.** They live in
`@mikro-orm/decorators/legacy` now; `@mikro-orm/core` still exports the
runtime pieces (`MikroORM`, `Collection`, `wrap`, …). Importing `Entity` from
`@mikro-orm/core` is the v6 spelling and no longer resolves.

```ts
// book.entity.ts
import { Entity, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";

@Entity()
export class Book {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  title!: string;
}
```

```ts
@Kavo(Book)
@Controller("books")
export class BookController {}
```

## Wiring — pass the ORM, not the EntityManager

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

`createInfrastructure` takes the **`MikroORM` instance**, not an
`EntityManager`, on purpose. MikroORM is a Unit-of-Work ORM whose
`EntityManager` holds an identity map, so every Kavo operation calls
`orm.em.fork()` to get its own — the isolation a request-scoped
`RequestContext` would give a hand-written app.

**You do not need `RequestContext` middleware for Kavo's routes.** Adding it
is not required and buys nothing here.

## Case-insensitive filtering is opt-in

`filter[name][ilike]=ada%` maps to MikroORM's `$ilike`, which **only
PostgreSQL supports** — every other driver receives the token verbatim and
fails with a syntax error. MikroORM exposes no way to detect this, so it is a
declared setting, defaulting to **off**:

```ts
createInfrastructure(orm, { caseInsensitiveFilters: true }); // PostgreSQL only
```

With it off, `ilike` behaves exactly like `like`. On SQLite that is not even
a loss — SQLite's own `LIKE` is already ASCII case-insensitive.

(Note this is the opposite default from `@kavo/prisma`, where the same
setting is on unless you turn it off.)

## Soft delete is declared, not inferred

MikroORM has no `@DeleteDateColumn` equivalent — its soft-delete pattern is a
user-defined `@Filter`, which Kavo cannot detect. Add an ordinary property
and name it in config; that is what generates `PATCH /books/:id/restore`
(ADR-0013):

```ts
@Kavo(Book, { softDelete: { field: "deletedAt" } })
@Controller("books")
export class BookController {}
```

**Do not _also_ enable a MikroORM soft-delete `@Filter`.** Kavo owns the
scoping, and a second default-on predicate quietly defeats `withDeleted`.

## Filtering and sorting across a relation work natively

MikroORM nests relation paths in its own query language, so
`filter[author.name][eq]=Ada` needs no join bookkeeping — only an allowlist
entry, which is a separate decision from whether the relation may be
included:

```ts
@Kavo(Book, {
  allowed: { filterable: ["title", "author.name"] },
  relations: { edges: { author: { includable: true } } },
})
@Controller("books")
export class BookController {}
```

## Two smaller traps

- **`ESCAPE` in `like` patterns depends on your driver.** MikroORM cannot
  attach an `ESCAPE` clause, so `\` escaping a literal `%`/`_` works on
  PostgreSQL and MySQL (which default to backslash) but not on SQLite.
- **`@Property({ hidden: true })` beats a Kavo DTO.** Rows are converted with
  MikroORM's own `toObject()`, so a hidden property is gone before core sees
  it — naming it in a DTO will not bring it back.

## Where to go next

- Routes, allowed, relations, per-operation overrides → `kavo-decorator`
- The `filter`/`sort`/`fields`/`include` wire grammar → `query-grammar`
- Narrowing request/response shapes → `dto-slots`
- Restore/purge semantics → `soft-delete`
