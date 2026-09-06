# @kavo/mikroorm

MikroORM adapter for Kavo: implements `RepositoryAdapter`
(`EntityReader` + `EntityWriter`) from `@kavo/core` over a MikroORM
`EntityManager`. `TransactionManager` is not implemented — see the
`@remarks` on that interface in `@kavo/core`.

**May depend on:** `@kavo/core`, `@mikro-orm/core` (peer). **Never on:**
`@kavo/nest` or any framework.

Fully implemented: CRUD, filtering/sorting/pagination (including across
relation paths), soft delete/restore/purge, and nested relation includes
(via `populate`). MikroORM declares no delete-marker column the way
TypeORM's `@DeleteDateColumn` does, so the seam reports none — but read the
soft-delete note under "Known limitations" before assuming that means soft
delete is off until you configure it.

## Usage

Like `@kavo/typeorm` and unlike `@kavo/prisma`, there is nothing to declare
twice: a MikroORM entity is a real runtime class carrying its own metadata,
so the class you pass to `createCrud` _is_ the identity core needs — no
marker classes, no `entities` list beyond the one MikroORM already has.

```ts
import { Collection, Entity, ManyToOne, OneToMany, PrimaryKey, Property, MikroORM } from "@mikro-orm/core";
import { defineConfig } from "@mikro-orm/postgresql";
import { createMikroOrmKavo } from "@kavo/mikroorm";

@Entity()
class Author {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  name!: string;

  @OneToMany(() => Book, (book) => book.author)
  books = new Collection<Book>(this);
}

const orm = await MikroORM.init(defineConfig({ dbName: "app", entities: [Author, Book] }));
const kavo = createMikroOrmKavo(orm, { caseInsensitiveFilters: true });

const authors = kavo.createCrud(Author);
```

`createInfrastructure`/`createMikroOrmKavo` take the `MikroORM` instance
itself rather than an `EntityManager`: every adapter operation calls
`orm.em.fork()` to get its own manager, which is what keeps one request's
identity map out of the next one's.

## `caseInsensitiveFilters`

`ILIKE` maps to MikroORM's `$ilike`, which **only PostgreSQL supports** —
SQLite, MySQL, and MongoDB pass the token through to the driver and fail
with a syntax error. MikroORM's `Platform` exposes nothing to detect this
from, so it is a declared setting, defaulting to `false` (the value that
works everywhere). Turn it on for PostgreSQL.

With it off, `ILIKE` translates exactly like `LIKE`. On SQLite that is not
even a loss — SQLite's own `LIKE` is already ASCII case-insensitive.

## Known limitations

- **`LIKE` escapes are driver-dependent.** MikroORM has no way to attach an
  `ESCAPE` clause to a `LIKE`, so the query grammar's `\` escape for a
  literal `%`/`_` is honored only by drivers that default to backslash
  (PostgreSQL, MySQL). On SQLite, which has no default escape character,
  `filter[name][like]=100\%` matches the literal text `100\` followed by
  anything, rather than the string `100%`.
- **Soft-deleted related rows are pruned in memory.** MikroORM's
  `populateWhere` cannot express per-level scoping: nesting a child condition
  makes it a predicate on the _parent_, so a parent with no surviving
  children disappears instead of coming back empty. The adapter populates
  everything and prunes the loaded tree, which is correct at any depth but
  does fetch soft-deleted related rows before discarding them. Soft-deleted
  _roots_ are still excluded in SQL.
- **`IncludeNode.strategy` is ignored.** MikroORM resolves `populate` with
  its own queries and applies `limit`/`offset` to the root either way, so
  the join/batch distinction has nothing to control here — and MikroORM's
  `strategy` option is per-query rather than per-relation, so it could not
  express a mixed include tree anyway. Same posture as `@kavo/prisma`.
- **MikroORM's own property options win at the boundary.** Rows are
  converted with `wrap(entity).toObject()`, so a custom `serializer` runs
  before core ever sees the row.
- **The soft-delete marker is writable, and it is on by default.** Nothing
  in a MikroORM entity declares a delete column, so the adapter cannot mark
  it generated — but `delete` defaults to
  `{ field: "deletedAt", strategy: "auto" }` and core matches that _name_
  against your columns, so any entity with a `deletedAt` property is
  soft-deletable with no config at all. The marker then sits in the derived
  writable projection: a plain `PATCH` of it soft-deletes a row, bypassing
  `deleteOne`'s already-deleted check and even
  `operations: { deleteOne: false }`. It cannot _revive_ one — writes are
  scoped to the live set, so a soft-deleted row 404s on `PUT`/`PATCH`. This
  is the same hole `@kavo/prisma` and `@kavo/mongoose` have (only
  `@kavo/typeorm` escapes it, because `@DeleteDateColumn` is detectable and
  therefore markable), and the fix belongs in core. Until then, register an
  explicit `update`/`patch` DTO that omits the marker.
- **A non-auto-increment primary key is client-writable.**
  `@PrimaryKey() id: string = v4()` carries none of MikroORM's generated
  flags, so a `PATCH` can rewrite a row's identity. A numeric `@PrimaryKey()`
  is auto-increment and safe. Name the write DTOs explicitly for any entity
  with a caller-assigned key.
- **`hidden` and `lazy` properties are dropped from Kavo entirely.** Not
  merely hidden from responses — excluding them from the metadata seam is
  what keeps them off the default filter/sort allowlists, where an invisible
  but filterable column is a blind extraction oracle. The trade is the one
  `@kavo/mongoose` makes for `select: false`: Kavo does not manage such a
  property at all, so write it through a custom operation or the ORM.
- **A MikroORM `@Filter` is applied on top of Kavo's scoping.** Kavo owns
  soft-delete scoping through `delete.field`; a default-on MikroORM
  soft-delete filter would AND a second predicate onto every query and
  quietly defeat `withDeleted`. Use one or the other, not both.
- **No transactions.** The `TransactionManager` seam is unbuilt across every
  Kavo adapter today.
- **Composite primary keys are refused.** `buildEntityMetadata` raises
  `KAVO_CONFIG_INVALID` for an entity with more than one `@PrimaryKey`.

## Soft delete and unique indexes

A soft-deleted row still occupies its unique indexes, so re-creating "the
same" row after a soft delete raises a 409 conflict — the honest answer,
since the value _is_ taken. The fix is a partial unique index scoped to
live rows:

```sql
CREATE UNIQUE INDEX author_email_live ON author (email) WHERE deleted_at IS NULL;
```

Full design notes: [`docs/internals/architecture/17-mikroorm-adapter.md`](../../../docs/internals/architecture/17-mikroorm-adapter.md).
