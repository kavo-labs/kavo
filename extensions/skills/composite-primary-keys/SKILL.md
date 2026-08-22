---
name: composite-primary-keys
description: Reference for composite primary key support in @kavo/typeorm — the compositeIdFields metadata field, the ~-delimited route-id encoding, the creatable/updatable split, and every place composite keys don't yet work (other ORM adapters, many-to-many array-mutation, @kavo/graphql). Use when an entity has more than one @PrimaryColumn, or when a route id, association, or array-mutation write on such an entity behaves unexpectedly.
---

# Composite primary key reference (`@kavo/typeorm`)

An entity with more than one `@PrimaryColumn` — a natural key with no
surrogate `id` — is supported, TypeORM only:

```ts
@Entity()
export class UserSentence {
  @PrimaryColumn("uuid")
  userId!: string;

  @PrimaryColumn()
  topic!: string;

  @Column()
  key!: string;
}
```

`EntityMetadata.compositeIdFields` reports the key columns, in declaration
order. `idField` still exists (the first declared column, for callers that
only ever need one name) but nothing that addresses a row's real identity
may rely on it alone once `compositeIdFields` is set.

## Route id encoding

One path segment, key columns joined by `~`:

```
GET /user-sentences/u1~billing   →  { userId: "u1", topic: "billing" }
```

A literal `~` inside a value is escaped by doubling it (`~~`) — the id has
already passed URL decoding by the time Kavo sees it, so percent-escaping
the separator would be silently invisible. `encodeCompositeId`/
`decodeCompositeId` (`@kavo/core`'s barrel) implement the codec; a malformed
id (wrong part count) is a clean 400, never a driver error.

## Writable defaults

Key columns are **creatable but not updatable**: `createOne` accepts them
(a natural key the client supplies), `updateOne`/`patchOne` silently drop
them from the body — the row's identity doesn't change after creation.
This is the one case where `creatable`'s and `updatable`'s shared default
diverges; narrow either explicitly (see the `kavo-decorator` skill) if that
default is wrong for an entity.

## Pagination

Offset, page, cursor, and since all work. Cursor/since force the sort's
tail to the _full_ `compositeIdFields` tuple, in declaration order, instead
of a single `idField` — `sort=-createdAt,userId,topic`, not
`sort=-createdAt,userId`. A since token's id half reuses the same
`~`-delimited encoding a route id uses.

## Association by id (ADR-0014)

Works in both directions:

- **As a relation's source** — an owner entity can `include=` it normally.
- **As a relation's target** — a write body names it as an object keyed by
  each column (`{ owner: { userId: "u1", topic: "billing" } }`) or the bare
  `~`-delimited scalar (`{ owner: "u1~billing" }`). Either narrows to the
  target's real column names before it reaches the adapter.

## Limitations — read before you rely on one of these

| Area                                                                                                                                  | Status                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@kavo/prisma`, `@kavo/mongoose`, `@kavo/mikroorm`                                                                                    | **Not supported.** Each still requires exactly one primary column; none populates `compositeIdFields`. This is `@kavo/typeorm` only.                                                                                                                                                                                                                                     |
| Many-to-many array-mutation writes (`replaceRelation`/`patchRelation`/the `resource` strategy) on a composite entity's _own_ relation | **Not supported.** TypeORM's `RelationQueryBuilder.add`/`.set` validate the member value's shape against the _owning_ side's join-column count — 2+ for a composite owner, unsatisfiable by any bare member id on the other side. Upstream TypeORM behavior, not a Kavo choice. `createCrud` refuses this at bootstrap (`ConfigurationException`), not on first request. |
| One-to-many array-mutation writes on a composite entity's own relation                                                                | **Supported.** The foreign key lives on the child row, not a junction table, so the limitation above doesn't apply.                                                                                                                                                                                                                                                      |
| `@kavo/graphql`                                                                                                                       | **Not usable for a composite-key entity.** The generated schema types every `id` argument as a non-null GraphQL `Int` (`schema.ts`), so a composite entity's string id can never pass GraphQL's own type coercion. Pre-dates composite-key support; also blocks any string/UUID-keyed entity.                                                                            |
| `@kavo/mcp`                                                                                                                           | **Works.** Its `id` argument schema already accepts `string \| number`.                                                                                                                                                                                                                                                                                                  |
| `@kavo/nest` routes / `@nestjs/swagger`                                                                                               | **Works.** `:id` is an untyped route param already; the generated `ApiParam` doesn't spell out the `~`-delimited format, but nothing rejects it.                                                                                                                                                                                                                         |
| Bulk operations (`createMany`, `updateMany`, …)                                                                                       | Not built for any entity yet — unrelated to composite keys.                                                                                                                                                                                                                                                                                                              |

Full design and the exact upstream TypeORM check:
`docs/internals/adr/0039-composite-primary-keys-are-typeorm-only.md`.
