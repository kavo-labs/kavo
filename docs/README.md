# Kavo documentation

Design documentation for the Kavo framework, maintained alongside the code.

These documents and the [ADRs](internals/adr/) are authoritative.

## Blueprint

- [architecture/01-system-architecture.md](internals/architecture/01-system-architecture.md) — layers, boundaries, lifecycle, patterns, non-goals, tradeoffs
- [architecture/02-monorepo-and-packages.md](internals/architecture/02-monorepo-and-packages.md) — package design, dependency rules, tooling, versioning
- [architecture/03-core-contracts-and-type-system.md](internals/architecture/03-core-contracts-and-type-system.md) — generic parameters, `FieldPath`, module augmentation

## Walking skeleton

- [architecture/04-schema-system.md](internals/architecture/04-schema-system.md) — the schema system: the six slots, derivation rules, resolution, serialization order
- [architecture/05-query-grammar.md](internals/architecture/05-query-grammar.md) — the query-string grammar reference: operators, rules, limits, coercion
- [architecture/06-error-handling.md](internals/architecture/06-error-handling.md) — exception hierarchy, error-code catalog, problem details
- [architecture/07-crud-engine.md](internals/architecture/07-crud-engine.md) — request lifecycle, context, built-in handlers, root factory
- [architecture/08-configuration.md](internals/architecture/08-configuration.md) — schema, precedence chain, merge semantics, bootstrap validation
- [architecture/09-typeorm-adapter.md](internals/architecture/09-typeorm-adapter.md) — metadata seam, query translation, error mapping, seams
- [architecture/10-nestjs-integration.md](internals/architecture/10-nestjs-integration.md) — module design, route generation, exception filter, Swagger

## Core features

- [architecture/11-soft-delete.md](internals/architecture/11-soft-delete.md) — strategy resolution, restore/purge, `withDeleted`, unique-index and cascade edges
- [architecture/12-relations-and-includes.md](internals/architecture/12-relations-and-includes.md) — relation registry, include resolution, join/batch loading, pagination rule, write-side
- [architecture/13-graphql-binding.md](internals/architecture/13-graphql-binding.md) — package boundary, schema construction, multi-entity schemas, the Nest binding
- [architecture/14-prisma-adapter.md](internals/architecture/14-prisma-adapter.md) — marker classes, metadata seam, query translation, error mapping
- [architecture/15-mongoose-adapter.md](internals/architecture/15-mongoose-adapter.md) — model identity, ObjectId conversion, populate, relation-path limits
- [architecture/17-mikroorm-adapter.md](internals/architecture/17-mikroorm-adapter.md) — MetadataStorage seam, FilterQuery translation, per-operation EntityManager forks
- [architecture/16-mcp-binding.md](internals/architecture/16-mcp-binding.md) — package boundary, toolset construction, result shape and error mapping, the Nest binding

## Reference

- [adr/](internals/adr/) — architecture decision records, referenced elsewhere instead of re-arguing
