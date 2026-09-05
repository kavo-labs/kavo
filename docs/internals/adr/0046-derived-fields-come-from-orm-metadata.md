# ADR-0046 — Derived fields come from ORM metadata; core stays expression-agnostic

**Status:** accepted

Supersedes [ADR-0019](0019-computed-fields-are-serializer-evaluated.md).

## Context

ADR-0019's `computed` feature made a virtual field first-class by
evaluating a `resolve(entity, context)` function at response mapping —
deliberately never filterable, sortable, or writable, because it had no
column behind it. That design bought ORM-independence at the cost of the
database: every supported ORM already has its own virtual/generated-column
mechanism (`@VirtualColumn` in TypeORM, `@Formula` in MikroORM, a client
extension in Prisma, a schema virtual in Mongoose), and two of them
(TypeORM, MikroORM) expose the derived expression as real SQL — schema
metadata Kavo could read and push down to `WHERE`/`ORDER BY`, the same way
an ordinary column already is.

Keeping `computed` and adding this SQL-pushdown case alongside it would
leave two competing mechanisms for the same concept: a JS resolver for
some fields, an ORM expression for others, on the same entity, with
different allowlist rules for each. That is the kind of split complexity
ADR-0019 itself existed to keep out of the response path. The cleaner cut
is to retire the resolver entirely and let the ORM own the definition —
core reads whatever expression the adapter reports and treats it exactly
like a column wherever the adapter can make that true.

## Decision

**`FieldMetadata` gains an optional `derivedExpression: unknown` marker.**
Core never inspects, parses, or builds it (ADR-0005) — it exists purely to
round-trip from the adapter that produced it back to that same adapter,
the same opacity `EntityMetadata`'s other adapter-supplied values already
have. A field with `derivedExpression` set has no backing storage column;
one without it is an ordinary column, `derivedExpression` absent entirely
(not `undefined` as a marker value — the key itself is omitted).

**A derived field is opt-in to `filterable`/`sortable`/`selectable` via
`allowlists`, never a default.** The same rule a relation already follows
(ADR-0028): ORM metadata supplies shape, never permission. Concretely, in
`resolveAllowlists`:

- The unconfigured default for every allowlist excludes a derived field —
  it is computed from the entity's own (non-derived) columns only.
- An explicit array may name a derived field, and it works exactly like
  naming any other column would, subject to what the adapter can
  translate (below).
- `selectable`'s `{ exclude }` form resolves against own columns only —
  matching a relation, a derived field is never reachable through
  `{ exclude }`, only through an explicit array.
- `creatable`/`updatable` reject a derived field by name at bootstrap: it
  has no writable storage, so it can never be written, the same rule
  ADR-0019 held for `computed`.
- `searchable` rejects a derived field unconditionally, opted in or not:
  there is no ORM-independent way to turn an arbitrary derived expression
  into a `WHERE ... ILIKE` fragment.
- A `create`/`update`/`patch` DTO naming a derived field is a bootstrap
  `ConfigurationException` (`rejectDerivedWriteDtoKeys`), for the same
  wire reason ADR-0019 rejected one naming `computed`: the generated
  OpenAPI body would advertise a property the engine unconditionally
  discards.

**Per-adapter translation, not a Kavo-side expression language.** Whether
a derived field can actually satisfy an opt-in allowlist entry is entirely
the adapter's decision, made once at metadata-derivation time by whether
it reports a `derivedExpression` at all:

- **`@kavo/typeorm`** populates it from `@VirtualColumn`'s `query`
  function — the same alias-parameterized SQL fragment TypeORM itself
  calls to populate the property on load. `FilterTranslator.columnRef`
  inlines it, parenthesized, in place of `alias.field` for a root-level
  field named in a filter or sort; `SELECT` needs no adapter change at
  all, because a `@VirtualColumn` is a real TypeORM column and TypeORM's
  own entity hydration already includes it whenever the property is on
  the entity, independent of `select=` (selection is core's own
  "kept internally, stripped late" narrowing, not a `SELECT`-clause
  change).
- **`@kavo/mikroorm`** populates it from `@Formula`/`@Property({ formula
})`'s callback. No adapter-side inlining is needed: MikroORM resolves a
  formula property natively by property name in `where` and `orderBy`, so
  the existing `FilterTranslator` and sort code already work by
  referencing the name, unchanged. `derivedExpression` carries the
  formula callback purely as a presence marker and for debug output.
- **`@kavo/prisma`** and **`@kavo/mongoose`** report no `derivedExpression`
  at all, for the same underlying reason in both cases: their derived-field
  mechanisms — a Prisma client extension's `result.<model>.<field>.compute`,
  a Mongoose `schema.virtual(...).get(...)` — are JavaScript evaluated by
  the client library on an already-fetched object, never described by the
  metadata source each adapter reads (Prisma's DMMF, Mongoose's
  `schema.paths`). Such a field therefore produces **no `FieldMetadata`
  entry at all**, not an entry with `derivedExpression` absent — it is
  invisible to Kavo's query engine entirely. Naming it in a filter or sort
  is an ordinary unknown-field 400 (`KAVO_QUERY_INVALID_FIELD`), the same
  as any other name the entity does not declare. It may still be exposed
  response-only through a registered `item`/`list` DTO or a custom
  operation that reaches for the extended client / virtual directly — Kavo
  itself supplies no wiring for that, unlike ADR-0019's `resolve`.

**`computed` is removed, not deprecated.** `ComputedFieldDescriptor`,
`ComputedFieldMap`, `EntityConfig.computed`, `resolveComputedFields`,
`rejectComputedWriteDtoKeys`, and `ResolvedEntityConfig.computed` are gone
from `@kavo/core`; `DefaultSerializer`/`DefaultDeserializer` no longer take
or reference a computed map. `@kavo/nest`'s `applyResponseSchemaDocs` drops
its separate `computedFieldNames` loop — a derived field is now an
ordinary `FieldMetadata` entry, typed and gated by `selectable` exactly
like any other field, in the same loop.

## Consequences

- **Capability regression, accepted and not replaced.** ADR-0019's
  `resolve(entity, context)` let a derived value vary by caller — a
  `viewer` field keyed off `context.app`, say. An ORM-derived expression is
  evaluated by the database once per row; nothing about it can vary by the
  request that happens to be reading the row. An app that needs a
  per-caller-varying value now reaches for a custom operation, an explicit
  `item`/`list` DTO computed in application code, or a policy — not a
  Kavo-native derived-field mechanism. The same is true for the
  cross-ORM-identical-behavior-over-class-instances-vs-plain-objects
  guarantee ADR-0019's resolver gave: a derived field's exact behavior
  (kind coercion, nullability) is now whatever the ORM reports for it,
  same as any other column, rather than a Kavo-normalized contract.
- **#174's hazard (a `computed` resolver on an included relation target
  receiving the root request's context) no longer applies.** There is no
  resolver left to hand a context to; a derived field on a relation target
  is read straight off the target's own hydrated row, exactly like any of
  its ordinary columns.
- **#140 (aggregation's home) is untouched by this ADR.** A `@VirtualColumn`
  subquery or `@Formula` expression can express a per-row aggregate (a
  related-row count, say), but bucketed self-aggregation (`GROUP BY`
  across a whole collection) is a different shape of problem and stays
  out of scope here, as it did before.
- A derived field's `kind`/`nullable` come from whatever the adapter
  reports for the ORM-declared column type — there is no way for Kavo to
  infer a derived SQL expression's result type independently, so an
  adapter that gets this wrong (declaring `number` for a boolean
  expression, say) produces a coercion mismatch the same as a
  misdeclared ordinary column would.
