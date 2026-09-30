# Soft delete

Give an entity a delete-marker column and Kavo stops actually deleting rows on `DELETE /books/:id`. It stamps the marker instead, and every read (`GET /books`, `GET /books/:id`, includes) automatically excludes stamped rows, with no query changes on your side:

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

- **Restore.** `@Kavo(Book, { delete: { strategy: "soft" } })` turns on `PATCH /books/:id/restore`, which clears the marker and returns the row again.
- **Purge.** `DELETE /books/:id/purge` permanently removes an already-soft-deleted row. Naming `purgeOne` declares `operations` as an [exclusive whitelist](/guides/configuration/operations#operations), so every other standard operation needs naming too: `@Kavo(Book, { operations: { createOne: true, findOne: true, findMany: true, updateOne: true, patchOne: true, deleteOne: true, purgeOne: true } })`.

Both can be combined. Attempting to restore a row that isn't deleted, or purge one that is still live, returns a 409, not a silent no-op.

A soft-deleted row is gone from the client's side by default: `?withDeleted=true` (live and deleted rows) and `?onlyDeleted=true` (a trash view) answer `400 KAVO_QUERY_UNSUPPORTED_PARAM` until the entity opts in with `delete.allowDeletedReads`:

```ts
@Kavo(Book, { delete: { allowDeletedReads: true } })
```

Opt in per read instead with `operations: { findMany: { delete: { allowDeletedReads: true } } }`, and gate who may use the flags with a `policy` reading `context.query`. A programmatic `QueryContext` (`service.findMany({ withDeleted: true })`) is server code, so it is never gated. See [Soft delete, restore & purge](/internals/architecture/11-soft-delete) for the full behavior: unique-index caveats, cascades, and what's deliberately not built (bulk restore/purge).

For the `delete` config key itself (`field`, `strategy`), see [Settings](/guides/configuration/settings#softdelete).
