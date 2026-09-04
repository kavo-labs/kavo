# Composite primary keys

`@kavo/typeorm` accepts an entity with more than one `@PrimaryColumn`: a natural key with no surrogate `id`, the shape a join-table-style entity often has.

```ts
import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from "typeorm";
import { User } from "../user/user.entity";

@Entity()
export class UserSentence {
  @PrimaryColumn("uuid")
  userId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "userId" })
  user!: User;

  @PrimaryColumn()
  topic!: string;

  @Column()
  key!: string;
}
```

Kavo reports the two columns as `compositeIdFields`, in declaration order. Every seam that addresses a row (routing, pagination, association by id) reads that instead of a single `idField`.

A composite entity's route id is one path segment, its key columns joined by `~`: `GET /user-sentences/u1~billing` addresses `{ userId: "u1", topic: "billing" }`. A literal `~` inside a value is escaped by doubling it (`~~`), since the id has already been through URL decoding by the time Kavo sees it, and percent-escaping the separator would be silently invisible at that point.

The key columns are creatable but not updatable by default: `createOne` accepts them (a natural key the client supplies), while `updateOne`/`patchOne` silently drop them from the body, the same way an unknown key is dropped. The row's identity doesn't change after creation. Narrow `creatable`/`updatable` explicitly if that default is wrong for an entity (see [Allowed](/features/allowed)).

Offset, page, cursor, and since pagination all work. Association by id ([ADR-0014](/internals/adr/0014-associate-by-id-not-deep-writes)) works in both directions: a composite entity can be a relation's source (`include=` from its owner) or its target. A write body names it as either an object keyed by each column (`{ owner: { userId: "u1", topic: "billing" } }`) or the same `~`-delimited scalar a route id uses.

`examples/nest-typeorm`'s `PetTag` (`petId`/`tagId`, no surrogate `id`) is a runnable instance of this shape, served over `GET/PUT/PATCH/DELETE /pet-tags/:petId~:tagId`: [`examples/nest-typeorm/src/pet-tag`](https://github.com/kavo-labs/kavo/tree/main/examples/nest-typeorm/src/pet-tag).

## Limitations

| Area                                 | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@kavo/prisma`                       | Not yet supported, but scoped as the next adapter to gain it — see [ADR-0040](/internals/adr/0040-composite-primary-keys-extend-to-prisma) and issue #269. Still requires exactly one `@id` field until that lands.                                                                                                                                                                                                                                                                                                |
| `@kavo/mongoose`, `@kavo/mikroorm`   | Not supported, undecided. Each still requires exactly one primary column; neither populates `compositeIdFields`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Many-to-many array-mutation writes   | Not supported on a composite-key entity's own relation (`replaceRelation`/`patchRelation`/the `resource` strategy). TypeORM's `RelationQueryBuilder.add`/`.set` validate the member value's shape against the _owning_ side's join-column count, which is 2+ for a composite owner and unsatisfiable by any bare member id. `createCrud` refuses this at bootstrap rather than failing on first request. See [ADR-0039](/internals/adr/0039-composite-primary-keys-are-typeorm-only) for the exact upstream check. |
| One-to-many array-mutation writes    | Supported. The foreign key lives on the child row, not a junction table, so the limitation above doesn't apply.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@kavo/graphql`                      | Not usable. The generated schema types every `id` argument as a non-null GraphQL `Int` (`packages/protocols/graphql/src/schema.ts`), so a composite entity's string id can never be passed through GraphQL's own type coercion. This predates composite-key support and also blocks any string/UUID-keyed entity.                                                                                                                                                                                                  |
| `@kavo/mcp`                          | Works. Its `id` argument schema already accepts `string \| number`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@kavo/nest` / Swagger               | Works. The `:id` route param and its generated `ApiParam` are untyped strings already; the description doesn't spell out the `~`-delimited format, but nothing rejects it.                                                                                                                                                                                                                                                                                                                                         |
| Bulk operations (`createMany`, etc.) | Not built for any entity yet (issue #137), composite-keyed or not. Unrelated to this feature.                                                                                                                                                                                                                                                                                                                                                                                                                      |

Composite keys are otherwise `@kavo/typeorm`-only, with the above table naming every place that boundary shows up.
