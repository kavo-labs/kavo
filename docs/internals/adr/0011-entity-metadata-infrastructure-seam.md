# ADR-0011 — Entity-metadata & infrastructure seam

**Status:** accepted

## Context

Core needs to know entity shape at runtime — which columns exist, their
types, which are generated, which properties are relations — to derive
DTO defaults, derive the default `allowed` configuration, and coerce wire
values against column types. That knowledge lives in ORM
metadata, and core must not import an ORM (ADR-0001, ADR-0005).

## Decision

Core defines an ORM-independent description —
`EntityMetadata`/`FieldMetadata` (`core/src/metadata/`) — and a
`KavoInfrastructure` contract (`metadataFor` + `adapterFor` per entity).
Adapter packages implement it (`createInfrastructure(dataSource)`
translates TypeORM metadata); `createKavo` receives it once, and
`createCrud` may override per entity (`runtime.adapter`/`runtime.metadata`),
which is also the unit-test path (in-memory fakes, no ORM).

## Consequences

- Core stays metadata-_driven_ without being metadata-_aware_ of any ORM;
  the dependency direction of ADR-0001 holds with runtime code.
- One extra concept for adapter authors, but it is the entire adapter
  bootstrap contract — everything else is `RepositoryAdapter`.
- `@kavo/nest` receives infrastructure through DI options
  (`KavoModule.forRoot({ infrastructure })`), not an `orm: "typeorm"`
  string — no name registry, no framework→adapter import, any future
  adapter plugs in unchanged.
- Field kinds are deliberately coarse (`string`/`number`/`boolean`/
  `date`/`enum`/`json`) — enough for coercion and derivation; anything
  finer stays adapter-internal.
