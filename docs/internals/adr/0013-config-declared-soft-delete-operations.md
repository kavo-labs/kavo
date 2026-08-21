# ADR-0013 — Soft-delete operations are enabled from config, not ORM metadata

**Status:** accepted

## Context

Soft delete resolves per entity: an entity carrying a delete-marker
column (`@DeleteDateColumn`, or a column named by `softDelete.field`) is
soft-deletable, everything else is hard-deleted. That decision
needs entity metadata, which exists only at bootstrap.

Route generation, however, runs at **class-decoration time**, where no
ORM metadata exists (ADR-0012) — and it generates one route per enabled
registry entry, from a registry built by the same
`createOperationRegistry` the engine uses. If enablement of `restoreOne`
and `purgeOne` depended on metadata, the two registry builds would
disagree: the engine would enable an operation the router never mapped.
Making `@kavo/nest` read TypeORM metadata to close the gap is exactly
the boundary ADR-0002 forbids.

## Decision

`restoreOne` and `purgeOne` are enabled from **entity config alone** —
the one input both registry builds share:

- `restoreOne` is on when the config _declares_ soft delete for the
  entity: `softDelete: { strategy: "soft" }`, or an explicit
  `softDelete.field`. Inheriting the built-in `strategy: "auto"` is not a
  declaration — `auto` is answered by metadata, which decoration time
  cannot see.
- `purgeOne` is off until named: `operations: { purgeOne: true }`.
  Permanently destroying data is not a default.
- Either may also be switched with the `operations.<id>: true | false`
  shorthand, or enabled by naming it with an object carrying settings
  (issue #257 — declaring `operations` at all makes it an exclusive
  whitelist; see ADR-0015 for what that means for the global default).

`createCrud` — the first moment config and metadata are both known —
rejects the mismatch: enabling a soft-delete operation on an entity that
resolves to a hard delete strategy is a `ConfigurationException` naming
the fix.

The _strategy itself_ stays metadata-driven. An entity with a
`@DeleteDateColumn` and no config still soft-deletes, and its reads still
exclude deleted rows; only the extra routes wait on the declaration.

## Consequences

- Both registry builds reach the same answer from the same input; the
  route table and the service surface cannot drift.
- `@kavo/nest` needs no ORM knowledge, and the generator itself needed
  no change to support soft delete — restore/purge appeared by enabling entries.
- Cost: zero-config soft delete is not _entirely_ zero-config. An entity
  gets soft deletes and exclusion for free, but its restore route takes
  one line (`softDelete: { strategy: "soft" }`). Stating it is also the
  honest signal that un-deleting is now part of the entity's public API.
- If a later change moves route generation behind a bootstrap-time
  registration (a DX option), this rule can relax to pure
  metadata detection without changing any config that exists today —
  declaring soft delete stays valid either way.
