# ADR-0006 — Registry-driven operation dispatch

**Status:** accepted

## Context

Three developer needs — disable an operation, override its behavior, add a
new one — plus route generation could each grow their own mechanism
(flags, subclass hooks, decorator magic, hardcoded verb lists).

## Decision

The engine dispatches **every** operation through
`OperationRegistry<TEntity>`. Built-in CRUD handlers are ordinary default
entries — nothing about them is special-cased. Disable = deactivate an
entry; override = swap its handler; custom = add an entry. `@kavo/nest`
generates routes by reading the registry, never from a verb list.

## Consequences

- One mechanism, several behaviors (the same DRY constraint underlying ADR-0001);
  later features (restore/purge) get routes by adding entries, with zero
  changes to the generator.
- Built-ins pay one table lookup of indirection — negligible.
- The registry's shape is load-bearing API: entries carry DTO slots and
  the `meta` bag (ADR-0007) so both the engine and the framework layer can
  read everything they need from one place.

**Amendment (issue #26, superseded below):** `EntityConfig.customOperations` — the config surface for
adding a wholly new operation id, with its own DTOs, dispatched through
the engine — was removed (its only real consumer was the `@Override`
trick documented in `10-nestjs-integration.md` §2, itself superseded by
the fully custom, registry-independent route pattern from issue #26).
The registry mechanism itself is unchanged: `OperationRegistry.register`
still accepts any entry, `disable`/`override` still work by id, and
nothing here special-cases the standard operations. What is gone is the
per-entity config path for reaching `register` with a new id — an action
with no operation identity now reaches for a plain native-decorated
controller method instead, never for engine dispatch.

**Amendment (issue #145):** a config path for a new operation id exists again, and this
time it is a key of `operations` rather than a map of its own. Any
`operations` key outside the eight standard ids is a custom operation: a
`CustomOperationConfig` carrying a required `handler`, an optional
`kind`/`cardinality` (defaulting to a single-row write), an optional `dto`
override, and the `meta.routes` the framework layer reads.

The amendment above was right about the mechanism it removed and wrong
about the need. `customOperations` was a second config surface whose only
consumer registered a handler that never ran, so removing it removed a
trick rather than a capability. But the capability was the point. Without
it, the moment an application needs `markPaidOne` or `publishOne` it leaves
the framework for a native route, and loses DTO resolution, serialization,
the engine pipeline, and (since issue #142) the automatic principal along
with it. Those are what a registry entry buys, and refusing to let an
application name one was refusing them for nothing.

What keeps this from being a repeat of the first attempt:

- **One config surface, not two.** A custom operation is configured exactly
  where a standard one is, and the same per-operation settings, `dto`
  fallbacks and `meta` apply to both. There is no second precedence chain
  to keep in step.
- **`handler` is required.** The old shape allowed an entry whose behavior
  lived somewhere else, which is what made the `@Override` trick possible
  and what made `service.run(id)` and `POST /…` disagree about what the
  operation does. A custom operation now carries its behavior.
- **Nothing reads the registry differently.** The engine still loops over
  entries, and route generation still walks the same table. The two places
  that used to name `findMany` literally (response mapping, and the
  Swagger success schema) now read `descriptor.cardinality`, which is what
  they always meant.

The registry does gain one ordering rule, and it is a routing rule rather
than a dispatch one: custom entries are registered ahead of the standard
table, because registration order is route order (ADR-0012) and an HTTP
router matches in declaration order. Registered after `findOne`, a custom
`GET /orders/pending` would be answered by `GET /orders/:id`.

A custom operation is reachable in code through `KavoService.run(id, …)`,
which is the same engine call the eight named methods make. It stays out of
the GraphQL and MCP bindings, which expose the standard operations only.
