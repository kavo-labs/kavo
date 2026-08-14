# Soft delete

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

For the `softDelete` config key itself (`field`, `strategy`), see [Settings](/guides/configuration/settings#softdelete).
