# ADR-0040 — Composite primary keys extend to `@kavo/prisma`

**Status:** accepted (issue #266)

## Context

ADR-0039 shipped composite primary key support for `@kavo/typeorm` only, and
named the other three adapters "a separate, larger effort tracked only if
it's ever needed" — issue #266 was filed as the placeholder for that
decision. It cannot be picked up as-is: before any adapter work starts,
something has to decide _which_ adapter needs it first, since Prisma's
composite `@@id`, Mongoose's document-`_id` model, and MikroORM's composite
`@PrimaryKey()` columns are three different natural shapes, each requiring
its own metadata and query-building work.

Of the three, Prisma's is the closest fit to what ADR-0039 already built.
Prisma's `@@id([a, b])` block attribute is the idiomatic, commonly-reached-for
way to declare a natural composite key on a Prisma model — schema-declared,
not synthesized — so its semantics (one row, N key columns, no surrogate)
line up directly with `EntityMetadata.compositeIdFields` as ADR-0039 defined
it. Mongoose has no native compound-`_id` concept — a Mongoose document's
`_id` is a single field by design, so "composite key" there would mean a
different feature (a compound _unique index_ used as an addressing key, not
a primary key) rather than a straightforward extension of the same contract.
MikroORM's composite `@PrimaryKey()` columns are structurally close to
TypeORM's, but its query surface is declarative (filter objects, not a query
builder), which changes how a composite `WHERE` gets built. Both are
plausible follow-ups, but neither is the closest match, so neither is
decided here.

## Decision

`@kavo/prisma` is the next adapter to gain composite primary key support.
Concrete acceptance criteria are tracked in issue #269
(`packages/orms/prisma`'s composite-key work), scoped and shaped after
`packages/orms/typeorm/tests/composite-primary-key.spec.ts` the way ADR-0039
was validated for TypeORM: creates/reads/updates/patches/deletes by the
composite route id, key-value round-tripping through the `~`-delimited
encoding (including an escaped literal `~`), offset pagination, cursor and
since pagination using the full composite tiebreaker, and association-by-id
in both directions. `@kavo/prisma` has no relation array-mutation writes at
all yet (`RepositoryAdapter.replaceRelation`/etc. are unimplemented for this
adapter, independent of composite keys), so ADR-0039's many-to-many
limitation has no Prisma analogue to carry forward.

`@kavo/mongoose` and `@kavo/mikroorm` remain out of scope, undecided — not
ruled out, just not this issue's or this follow-up's problem. Each still
hard-fails on multiple primary-key columns
(`packages/orms/mongoose/src/metadata.ts`,
`packages/orms/mikroorm/src/metadata.ts`), unchanged by this ADR. A future
decision to extend to either gets its own ADR amendment (or successor),
following the same pattern this one does for Prisma.

The core contract needs no changes: `EntityMetadata.compositeIdFields` and
the route id / cursor / since / association-by-id machinery ADR-0039 built
are already adapter-agnostic. The Prisma-specific work is metadata
population and query/write logic:

- `packages/orms/prisma/src/metadata.ts`'s `buildEntityMetadata` currently
  throws when `idFields.length !== 1` (`model.fields.filter(isId)`). A
  Prisma `@@id([...])` composite key does not set `isId` on its member
  fields at all — it surfaces as a separate `model.primaryKey: { name,
fields: string[] }` DMMF property, which `PrismaDatamodel`
  (`packages/orms/prisma/src/datamodel.ts`) does not currently model and
  will need to.
- The Prisma repository adapter's row-addressing methods need a composite
  `WHERE` built from `compositeIdFields`, the way `@kavo/typeorm`'s
  `updateCriteria`/`findOneCriteria` do — Prisma's own composite-key `where`
  shape (`{ a_b: { a, b } }`, keyed by the `@@id` block's synthesized or
  named compound-field key) is the natural target, not a hand-rolled
  equality chain.
- Composite key columns get the same creatable-but-not-updatable default
  ADR-0039 established.

`@kavo/graphql`'s hardcoded `GraphQLInt` id argument (noted as a known gap in
ADR-0039) remains a gap regardless of which ORM adapter gains composite-key
support first; it is not addressed by this ADR or its follow-up issue.

## Consequences

- `docs/features/composite-primary-keys.md`'s limitations table gets a
  `@kavo/prisma` row once the follow-up lands, distinct from the
  still-unsupported `@kavo/mongoose`/`@kavo/mikroorm` row.
- Issue #269 is scoped narrowly enough to be `status:ready` immediately,
  unlike #266, which stays open only as the record of _why_ Prisma was
  chosen first and _that_ Mongoose/MikroORM remain undecided.
- This ADR does not implement anything; `packages/orms/prisma` is unchanged
  until the follow-up issue's own PR lands.
