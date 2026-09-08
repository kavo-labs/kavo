# ADR-0052 — `identifier` config key retargets the lookup axis only

**Status:** accepted (issue #419)

## Context

Every `…One` operation resolves the row it acts on — the route `:id`
param, `EntityReader.findOneById`, realtime ids, ETags — straight from
`EntityMetadata.idField` (or `compositeIdFields`, ADR-0039/0040). Apps
routinely want the _public_ identifier to be a different unique scalar
column (`username`, `slug`, `sku`) while the ORM primary key stays the
storage key. Today that needs a fully custom operation per verb, which
forfeits the ETag/precondition and DTO wiring the standard operations give
for free.

The obvious naive approach — let a config key replace `idField` outright —
collides with several invariants that are load-bearing elsewhere:

- the forced sort tiebreaker and cursor/since keyset
  (`query-normalizer.ts`, `since.ts`) need a column that is guaranteed
  unique and immutable to guarantee a total order and stable pagination;
  an app-chosen "identifier" is neither guaranteed by Kavo;
- association-by-id (ADR-0014) resolves a relation reference against the
  _target_ entity's real primary key — `{owner: {id: 7}}` — independent of
  how the _current_ entity's own routes address it;
- immutable-key stripping on writes (`stripImmutableKeys`) exists to
  protect the storage key from client tampering, which has nothing to do
  with which column a route uses to find the row;
- realtime ids (SSE, ADR-0023) need a value that is stable for the
  lifetime of the row, which the storage key already guarantees and an
  arbitrary column is not required to.

None of those seams need to change for this feature to be useful — an app
that wants `GET /users/:username` only needs the _lookup_ to change.
Conflating "how a row is found" with "what identity means for this row"
would force every PK-derived seam above to special-case a value Kavo
cannot itself prove is unique or immutable (`FieldMetadata` carries no
`unique` flag — ADR-0011 keeps field kinds deliberately coarse).

## Decision

A new `identifier` key is added to `KavoSettings`:

```ts
interface KavoSettings {
  // …
  readonly identifier?: { readonly field: string };
}
```

**Scope: global → entity only.** `identifier` is added to `SETTINGS_KEYS`
(so `resolveEntityConfig` merges it like any other settings subtree) but
is deliberately **not** added to any standard or custom operation's
`Allowed` settings union in `entity-config.ts`. That omission is the
existing mechanism (`pagination` already works this way — it is excluded
from every operation but `findMany`) that pins a key to `never` at the
operation and per-call scopes without new merge machinery. Retargeting
the lookup axis per-request or per-operation has no sound use case (the
route shape for `…One` is fixed at decoration time, ADR-0012) and would
let a single entity answer to two different identifiers depending on
which handler ran — confusing for callers and for ETag/cache-key
derivation alike.

**Lookup axis only — nothing else changes:**

| Seam                                          | Follows `identifier`                                 | Stays on the true PK                                      |
| --------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Route `:id` / `findOneById` resolution        | ✓                                                    |                                                           |
| Engine's numeric-id coercion (`coerceId`)     | ✓ (uses the identifier field's `FieldMetadata.kind`) |                                                           |
| Forced sort tiebreaker                        |                                                      | ✓                                                         |
| Cursor / since keyset (ADR-0021/0022)         |                                                      | ✓                                                         |
| Realtime entity id (ADR-0023)                 |                                                      | ✓                                                         |
| Immutable-key stripping on writes             |                                                      | ✓                                                         |
| Association-by-id, both directions (ADR-0014) |                                                      | ✓                                                         |
| ETag / precondition value                     |                                                      | ✓ (still derived from the stored row, not the lookup key) |

`EntityMetadata.idField`/`compositeIdFields` are never mutated or
shadowed by this feature — `identifier` resolves to a value that lives
only on `ResolvedEntityConfig`, consulted by exactly two call sites:
route-id coercion and `findOneById`. Every PK-derived seam in the table's
right column already reads `EntityMetadata` directly (confirmed by
inspection: `query-normalizer.ts`, `since.ts`, `kavo-engine.ts`'s
`realtimeEntityId`, `kavo.ts`'s association resolution), so none of them
needed to change — they are structurally incapable of noticing
`identifier` exists.

**Composite-key entities are out of scope for v1.** If
`metadata.compositeIdFields` is set, configuring `identifier` on that
entity is rejected at bootstrap (`ConfigurationException`,
`KAVO_CONFIG_INVALID`) — a composite natural key already has no single
column an alternate scalar identifier could cleanly replace at the route
level, and the issue explicitly scopes multi-column alternate keys out.

**Validation, at `createCrud` bootstrap** (mirrors `validateSincePagination`'s
shape, `resolve-entity-config.ts`):

- `identifier.field` must name a real entry in `metadata.fields` — not a
  relation, not `metadata.idField` itself (that's just unset), and not a
  derived field (ADR-0050 — a derived expression has no addressable
  storage column an adapter's `WHERE identifier = ?` could reliably hit).
- its `FieldMetadata.kind` must be `"string"` or `"number"` — the two
  kinds `coerceId` already knows how to coerce a route-string into.
  `"boolean"`/`"date"`/`"enum"`/`"json"` are rejected; none is a sound
  natural key for a URL segment in v1.
- the target entity's adapter must support identifier-based lookup —
  see below. An adapter that doesn't is a bootstrap
  `ConfigurationException`, not a silent fall-back to the PK.

**Uniqueness is caller-beware, not Kavo-proven.** `FieldMetadata` has no
`unique` flag (ADR-0011), so core cannot verify the configured field is
actually unique. A non-unique `identifier` makes `findOneById` return
whichever matching row the adapter's underlying query happens to pick —
documented as an explicit caveat, not guarded against. This mirrors how
Kavo already trusts the ORM's own schema for other invariants it cannot
re-derive (e.g. it does not verify a `filterable` column is indexed).

**Adapter capability, not a blanket implementation.** `RepositoryAdapter`
gains an optional capability query, following ADR-0039's
`supportsArrayMutation?` precedent:

```ts
interface RepositoryAdapter<Entity> {
  // …
  supportsIdentifierField?(field: string): boolean;
}
```

Unimplemented (`undefined`) means "this adapter cannot look up by a
field other than its primary key" — checked once at `createCrud`
bootstrap when `identifier` is configured, turned into a
`ConfigurationException` rather than adapter-specific runtime breakage.
`@kavo/typeorm`, `@kavo/prisma`, and `@kavo/mongoose` implement it
(returning `true` for any non-relation, non-generated column); `@kavo/mikroorm`
does not implement it, so configuring `identifier` on a MikroORM entity
is a bootstrap error — consistent with that adapter being out of scope
per the issue.

**Threading the resolved field to the adapter.** The route `:id` is one
lookup axis shared by every `…One` operation — `findOne` reads it,
`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne` all locate the
same row before mutating it — so `EntityReader.findOneById` and every
single-row `EntityWriter` method (`update`/`patch`/`delete`/`restore`/
`purge`) gain the same optional trailing parameter:

```ts
findOneById(id, query, context, identifierField?: string): Promise<Entity | null>;
update(id, data, context, identifierField?: string): Promise<Entity>;
// same addition on patch/delete/restore/purge
```

`built-in-handlers.ts` passes `context.config.identifierField` at every
one of these call sites; an adapter reads `identifierField ?? this.idField`
(its own stored primary-key column name), so an omitted argument — every
pre-existing caller, including tests that construct a `KavoContext` by
hand — is byte-identical to today. This keeps the composition root
(`createCrud`) as the sole place resolving config, rather than widening
`KavoInfrastructure.adapterFor`'s signature to carry `ResolvedEntityConfig`
into adapter construction.

## Consequences

- Unset (the default, `identifier` absent), behavior is byte-identical to
  today: `resolveEntityConfig` leaves `identifierField` as
  `metadata.idField`-equivalent (i.e. `findOneById`'s new parameter is
  `undefined`, and every adapter's existing PK-based lookup path is
  untouched).
- A future "alternate key participates in cursor/since pagination too"
  feature is additive: it would extend the table's left column, not
  revisit this ADR's boundary — the boundary itself (lookup axis vs.
  identity-bearing axis) stays intact.
- `@kavo/graphql`/`@kavo/mcp` hardcoding the id arg name (also called out
  as a known gap in ADR-0039/0040) is unaffected by this ADR and remains
  a separate follow-up, per the issue's stated out-of-scope list.
- Adopters must independently guarantee the configured field is unique;
  Kavo surfaces no runtime warning if it isn't, only whatever ambiguous
  row the adapter's query returns.
