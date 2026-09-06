---
name: soft-delete
description: Reference for Kavo's soft delete, restore, and purge behavior — strategy resolution (auto/soft/hard), enabling restoreOne/purgeOne, read semantics and withDeleted, and edge cases (unique constraints, cascades). Use when configuring delete, wiring restore/purge routes, or answering "what happens to a deleted row" questions.
---

# Soft delete, restore & purge reference

Deleting a row can mean two things. Kavo resolves which one **per entity, at
bootstrap**, and every layer downstream reads that one answer instead of
re-deciding. Full detail: `docs/internals/architecture/11-soft-delete.md`.
Wire-level `withDeleted=true` grammar is in the `query-grammar` skill;
config precedence is in the `global-config` skill.

## Opting in

```ts
@Entity()
class Owner implements SoftDeletable {
  @DeleteDateColumn() deletedAt!: Date | null;
}
```

That's the whole opt-in for the common case — no `@Kavo` config needed.
`DELETE /owners/:id` now stamps the marker instead of removing the row, and
every read excludes stamped rows.

## Strategy resolution (`resolveSoftDelete`)

| Settings                            | Result                                                   |
| ----------------------------------- | -------------------------------------------------------- |
| `delete: false`                     | `hard`                                                   |
| `delete.strategy: "hard"`           | `hard`                                                   |
| `delete.strategy: "soft"`           | `soft` — no marker field on the entity is a config error |
| `delete.strategy: "auto"` (default) | `soft` when a marker field exists, else `hard`           |

The marker field is the configured `delete.field` (default
`"deletedAt"`) if the entity has that column, otherwise whatever the ORM
declares (`@DeleteDateColumn` in `@kavo/typeorm`). Explicit config wins over
detection; an entity with neither costs nothing.

This resolves at **every** settings scope, so one operation or a single
call can narrow it:

```ts
@Kavo(Owner, {
  operations: { deleteOne: { delete: { strategy: "hard" } } },
})
```

## Operations

| Operation    | Behavior                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `deleteOne`  | Hard or soft per the resolved strategy. Soft-deleting an already-deleted row → 409 `KAVO_ALREADY_DELETED`.             |
| `restoreOne` | Clears the marker, returns the revived row in the `item` slot (no new DTO shape). A live row → 409 `KAVO_NOT_DELETED`. |
| `purgeOne`   | Permanently removes an already-soft-deleted row. A live row → 409 `KAVO_NOT_DELETED`. Under `hard` it's just a delete. |

**Enablement is config-declared, not metadata-driven** (ADR-0013) —
`restoreOne`/`purgeOne` don't just appear because the entity has a marker
column:

```ts
@Kavo(Owner, {
  delete: { strategy: "soft" }, // enables PATCH /:id/restore
  operations: { purgeOne: true },   // enables DELETE /:id/purge
})
```

Enabling either on an entity that resolves to `hard` is a bootstrap
`ConfigurationException`. Reads and `deleteOne` adapt with **no config at
all** — it's only the restore/purge routes that need an explicit opt-in.

## Read semantics

Soft-deleted rows are invisible by default — to `findOne`, `findMany`,
`count`, and to `updateOne`/`patchOne` (a write never touches a deleted
row; reviving one is `restoreOne`'s job, not a side effect of a write).

`withDeleted=true` opts back in on both wire and programmatic paths. On an
entity that is **not** soft-deletable, the parameter is rejected
(`KAVO_QUERY_UNSUPPORTED_PARAM`), never silently ignored — a client that
believes it's seeing deleted rows should be told it isn't.

In `@kavo/typeorm`: for a real `@DeleteDateColumn`, TypeORM already excludes
deleted rows and the adapter opts in with `.withDeleted()`; for an ordinary
column named through config, the adapter adds `<alias>.<field> IS NULL`
itself.

## Edge cases worth knowing before you hit them

- **Unique constraints.** A soft-deleted row still occupies its unique
  indexes — re-creating "the same" row raises a unique violation (mapped to
  409, same as any conflict; the value genuinely _is_ taken). Kavo does not
  rewrite indexes for you. Standard fix: a partial/filtered unique index
  over live rows only —
  `CREATE UNIQUE INDEX owner_email_live ON owner (email) WHERE deleted_at IS NULL;`
  (Postgres/SQLite support this directly; MySQL needs a generated column.)
- **Cascading soft delete is deliberately not automatic.** One `DELETE`
  silently stamping rows across several tables is a footgun. Write an
  explicit cascade yourself (an `@Override`'d operation, or a fully custom
  route) — that also lets you decide ordering and what happens when one leg
  fails.
- **Related rows.** Soft-deleted related rows are excluded from included
  relations by the same rule that governs root reads. Root-level
  `withDeleted` applies to the **root only** — it never widens what an
  included relation returns.
- **Bulk** (`restoreMany`, `deleteMany`, …) is the optional half of soft
  delete and is not built — those registry entries stay disabled and
  calling one raises `OperationDisabledException`. The single-item surface
  is complete without it.
