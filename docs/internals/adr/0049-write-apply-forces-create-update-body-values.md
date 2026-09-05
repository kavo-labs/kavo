# ADR-0049 — `create.apply`/`update.apply` force write-body values

**Status:** accepted

## Context

ADR-0048 gave `filter`/`sort`/`select`/`include` an `apply` callback: an
unconditional, per-request constraint that composes with whatever the client
sent rather than being replaced by it. For single-row writes
(`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne`) it folds
`filter.apply`'s result into the same pre-fetch-by-id the `policy` stage
already pays for, so a row outside the constraint answers `404` before any
handler runs.

That covers which **existing row** a write may reach. It says nothing about
the **values** a `createOne`/`updateOne` body may set. A tenant-scoped
`Order` entity can have `filter.apply` restrict every read and every
existing-row write to `tenantId = ctx.tenantId`, and a client can still
`POST /orders` with `{ tenantId: "some-other-tenant", ... }` and create a row
outside its own scope outright — there is no existing row for `filter.apply`
to scope on `createOne`.

`EntityConfig.create`/`.update` (`WriteFieldsConfig`, issue #388) already
carry `default`, but `default` is client-overridable by design: it fills a
field the body omits, and a body that sends the field wins outright. That is
exactly wrong for a forced invariant — an app cannot express "this field is
always `ctx.tenantId`, no matter what the client sends" with a mechanism
whose whole contract is that the client's own value always wins. ADR-0048's
own "`apply` is not `default`" section already reserved this distinction for
exactly this case.

## Decision

`WriteFieldsConfig` (`create`/`update`) gains an `apply` callback, next to
`fields`/`default`:

```ts
create: {
  apply: (args) => ({ tenantId: args.context.app?.tenantId }),
},
update: {
  apply: (args) => ({ tenantId: args.context.app?.tenantId }),
},
```

**Shape.** Reuses `ApplyArgs<Entity>` — the same argument shape
`filter.apply`/`sort.apply`/`select.apply`/`include.apply` already take
(`context`, `resource`, `operation`, `params`) — rather than inventing a
second callback shape. `WriteApply<Entity>` is
`(args: ApplyArgs<Entity>) => Partial<EntityInput<Entity>> | undefined | Promise<...>`.
A key the returned object omits (or a call returning `undefined`) is left
alone, not reset to anything.

**Composition is the opposite of `default`'s.** `apply`'s result overwrites
whatever the client sent for that key — the same one-way relationship
`filter.apply` already has with the client's own filter, applied to an
object merge instead of an `AND`. When a field is named by both `default`
and `apply`, `apply` wins: it is the unconditional constraint, `default` only
a fallback for an absent value.

**Scope, matching `default`'s own.** `create.apply` runs on `createOne`
only (and `createMany`, once #137 lands); `update.apply` runs on `updateOne`
only, never `patchOne` — a `PATCH` omitting a field means "leave it
unchanged," the same reasoning that already keeps `update.default` off
`patchOne`. Whether a forced value should ever override that omission
semantics is a separate decision, left out here.

**Where it runs.** After `resolveInput` has produced the deserialized body
(`KavoEngine.run`), so the forced values reach the adapter exactly as if the
client had sent them, and `filter.apply`'s own single-row scoping (which
runs earlier, during the pre-fetch) is untouched by this change.
`applyWriteApply` mutates the already-deserialized body in place rather than
reconstructing `resolveInput`'s two write shapes (`createOne`'s input _is_
the body; `updateOne`'s wraps it under `data`).

**Not bootstrap-validated**, for the same reason ADR-0048 already gives
`filter.apply`/`select.apply`/`sort.apply`: it is evaluated per request with
an arbitrary runtime value, so there is nothing to check ahead of time
beyond "is it callable at all" (`resolveWriteApply`, mirroring
`assertIsPolicyFunction`'s treatment of a non-function `policy`).

## Non-goals

- **`patchOne` gaining `apply`/`default` semantics.** Left for a future
  decision if the omission-means-unchanged contract ever needs revisiting.
- **A per-operation `apply` scope beyond `create`/`update`'s own entity-wide
  config** — matches ADR-0048's own "entity-wide, not per-operation (yet)"
  scope note.
- **Field-level visibility or masking.** Unrelated to forcing write values;
  ADR-0048 already carves this out for the read-side `apply`s.

## Consequences

- Closes the write-side half of issue #138: an entity with `filter.apply`
  scoping its reads and existing-row writes, plus `create.apply`/
  `update.apply` forcing the same scoping key on write bodies, has no gap
  left for a client to create or relabel a row outside its own scope.
- `default` and `apply` remain two visibly different keys with different
  composition rules on the same `WriteFieldsConfig`, exactly as ADR-0048
  anticipated.
