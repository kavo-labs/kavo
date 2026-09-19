# @kavo/core

Framework- and ORM-independent contracts and type system for Kavo.

**Zero runtime dependencies** — this package must not depend on NestJS or
TypeORM, directly or transitively (enforced by `.dependency-cruiser.cjs`).
It currently contains types only; runtime code (engine, config
resolution, query parsing) is layered in separately.

## Layout

```
src/
├─ types/          EntityId, FieldPath, shared type utilities
├─ query/          Filter AST, pagination, sort, field selection, contexts
├─ schema/         schema slots (class or validator), resolver
├─ dto/            list envelope, bulk envelope
├─ errors/         KavoExceptionShape, error codes, problem details
├─ config/         Settings schema, global/entity config, resolved config
├─ operations/     Operation ids, handler contract, registry
├─ relations/      Relation registry, include tree, include resolver
├─ context/        KavoContext, KavoRequest, KavoResponse
├─ serialization/  Serializer, Deserializer
├─ persistence/    EntityReader/Writer, RepositoryAdapter, soft delete, transactions
├─ service/        KavoService, per-call options
└─ index.ts        Explicit named barrel — the public API surface
```

Only the barrel (`@kavo/core`) is public API; deep imports are not.

See `docs/internals/architecture/03-core-contracts-and-type-system.md` for
the generic-parameter table, `FieldPath` notes, and the module-augmentation
pattern for `OperationMetadata`.
