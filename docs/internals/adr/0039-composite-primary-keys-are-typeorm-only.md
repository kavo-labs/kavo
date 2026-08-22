# ADR-0039 — Composite primary keys, `@kavo/typeorm` only, plain CRUD only

**Status:** accepted (issue #261)

## Context

Every prior version of Kavo required exactly one primary column: `EntityMetadata.idField: string` is a scalar, and the request pipeline reads it as one — the forced sort tiebreaker, cursor/since pagination's keyset, the default writable-projection exclusion, association-by-id (ADR-0014), and the route `:id` param all assume a single scalar identity.

That rules out a real, common shape: a join-table-style entity whose natural key is composite and has no surrogate id (`UserSentence { userId, topic }`, the motivating report — issue #261). Forcing a surrogate `id` column onto such an entity just to use Kavo is a real adopter cost for something plenty of schemas legitimately do without one.

Supporting composite keys everywhere `idField` is read today is a large change: it touches core's config resolution, serializer, engine, and every ORM adapter's own metadata seam independently. Doing all of it in one pass — including generalizing cursor/since pagination's single-tiebreaker keyset to an N-column row-value comparison, and every array-mutation relation-write primitive — was assessed and explicitly deferred; see Consequences.

## Decision

`EntityMetadata` gains an optional `compositeIdFields?: readonly string[]`, populated only by `@kavo/typeorm`'s `buildEntityMetadata` when an entity declares more than one `@PrimaryColumn`/`@PrimaryGeneratedColumn`. `idField` is untouched and stays required — a single-key entity behaves exactly as it did before this field existed, and `@kavo/prisma`/`@kavo/mongoose`/`@kavo/mikroorm` still require exactly one primary column outright (their metadata builders never populate `compositeIdFields`).

A composite-key entity's route id is one path segment: its key columns, in declaration order, joined by `~` (`encodeCompositeId`/`decodeCompositeId`, `@kavo/core`'s public barrel). A literal `~` inside a value is escaped by doubling it (`~~`) — chosen because the id has already passed through URL decoding by the time core sees it, so percent-escaping the separator would be silently invisible. The engine only shape-validates a composite id (it decodes into the right number of parts, or the request is a clean 400); the per-field `string`/`number` decode and the `WHERE` clause it turns into is `@kavo/typeorm`'s own job, since it is the only adapter that ever sees one.

Composite key columns are **creatable but not updatable** by default: a natural key is something the client legitimately supplies on `createOne` (the same reason association-by-id's `{owner: {id}}` can name an id on create), but immutable on every write after that — the one place `creatable`'s and `updatable`'s shared default diverges.

Three things this issue does not extend to a composite key fail loudly, at bootstrap, rather than silently misbehave at request time:

- **Cursor and since pagination.** Both force a sort tiebreaker on `idField` alone (ADR-0021, ADR-0022); a composite key has no single column to force it on. `resolveEntityConfig` rejects `pagination.strategy: "cursor"` / `"since"` on a composite-key entity outright. Offset and page pagination are unaffected.
- **Being the target of an association-by-id write** (ADR-0014). `{owner: {id: 7}}` has no meaning for a target with no single `idField`; `createCrud` rejects a relation whose target is a composite-key entity, once that target is registered on the same catalog.
- **Array-mutation relation writes** (`replaceRelation`/`patchRelation`/the `resource` strategy) on the composite-key entity itself. Every array-mutation primitive on `RepositoryAdapter` keys off the parent's own id; none of `@kavo/typeorm`'s implementations decode a composite one. `createCrud` rejects a relation that opts a composite-key entity's own relation into `write`.

## Consequences

- A composite-key entity is fully usable for plain CRUD (`createOne`/`findOne`/`findMany`/`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne`) with offset or page pagination, and as the _source_ side of an ordinary to-one/to-many relation (it can still `include=` a single-key relation, and be included as a relation's own list from a single-key owner).
- Cursor/since pagination, association-by-id as a target, and array-mutation writes on a composite-key entity are explicit gaps, not silently degraded behavior — each is a `ConfigurationException` at bootstrap, naming the restriction. Lifting the pagination one requires generalizing the keyset from a single tiebreaker field to an N-column row-value comparison (`(a,b,c) > (x,y,z)`, expressed as TypeORM's OR-chain expansion since it has no native row-value comparison in the query builder) — tracked as a follow-up rather than folded into this change.
- `@kavo/typeorm`'s `TypeOrmRepositoryAdapter` decodes a composite id into TypeORM's own native composite-key criteria shape (a `{ column: value }` record) wherever it addresses one row by id — `Repository.update`/`.delete` and `SelectQueryBuilder.where` already accept that shape natively, so no bespoke `WHERE`-building was needed beyond the decode.
- Batched relation includes (`batchLoad`, the `whereInIds` reload behind a to-many `include=`) were generalized to key on the full primary-key tuple rather than assuming one column, since a composite-key entity can appear as the _parent_ side of its own to-many include, not only as the entity this issue's route-id work targets directly.
