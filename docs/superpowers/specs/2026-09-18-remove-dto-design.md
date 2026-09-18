# Remove `dto`; `schema` becomes the only slot-config mechanism

**Date:** 2026-09-18
**Status:** approved for implementation planning

## Context

ADR-0055 introduced `schema` (a per-slot, input/output-split map of
`KavoSchema` validators) as "the source of truth for DTO shape, input
validation, and OpenAPI component generation," explicitly deciding `schema`
"replaces `dto` outright — no coexistence period." In practice `schema`
landed _alongside_ `dto` (`entity-schema.ts`'s own module doc says so), with
`dto` deletion deferred as follow-up work — re-deriving `KavoService`'s
typed surface, and migrating `@kavo/nest`/`@kavo/graphql`/`@kavo/mcp` off
`dto`-reading. `KavoService`'s typed surface (`SchemaInputOf`/`SchemaOutputOf`/
`SchemaQueryOf`) already resolves from `schema` first and falls through to
the old `DtoInputOf`/`DtoOutputOf`/`DtoQueryOf` helpers only when no schema
is configured for a slot.

This spec finishes that follow-up: `dto` is deleted outright, and the one
capability it had that `schema` didn't — a real class a framework's
`ValidationPipe`/class-validator integration can bind to — becomes a second
accepted shape for a `schema` slot, rather than a separate config key.

## Decision

### The unifying contract

Every `schema` slot (`schema.input.{create,update,patch,query}`,
`schema.output.{item,list}`, and their `operations.<id>.schema.*` overrides)
accepts one of two shapes:

```ts
type SchemaLike<T> = KavoSchema<T> | SchemaClass<T>;

interface KavoSchema<Output> {
  safeParse(input: unknown): SchemaParseResult<Output>;
}

/** A registerable class: plain, no-argument, shape-only — today's `DtoClass`, renamed. */
type SchemaClass<Shape extends object = object> = new () => Shape;
```

Downstream code branches on which shape it got, by testing for `safeParse`
(the same structural check `entity-schema.ts` already makes today via
`isKavoSchema`):

- **Validator kind** (`KavoSchema`, e.g. Zod): `safeParse` runs at the
  engine's deserialization stage for input (`SchemaValidationException` on
  failure) and at response mapping for output (the parsed `data` replaces
  the value — self-narrowing, since a Zod object schema strips unrecognized
  keys by default). This is exactly today's `schema` behavior; nothing here
  changes.
- **Class kind** (`SchemaClass`): no core-level validation runs — a bare
  class has no `safeParse`, the same "shapes for typing, serialization, and
  Swagger docs — no validation subsystem attached" posture `dto.ts`
  documents today. Shape narrowing instead comes from reflecting a fresh
  instance's own enumerable keys (today's `dtoShapeKeys`, ported verbatim).
  `@kavo/nest`'s `ValidationPipe`/class-validator wiring attaches to this
  variant exactly as it attaches to `dto` today.

This merge is what satisfies "keep class-validator support" without a
second config key: a class-validator-decorated class _is_ a `SchemaClass`,
just handed to `schema` instead of `dto`.

### `{ fields: [...] }` shorthand survives

`schema.patch`/`schema.output.item`/`schema.output.list` keep accepting the
inline `{ fields: [...] }` form (today's `FieldsShorthand`, ported from
`dto-fields-shorthand.ts` to a `schema`-module equivalent) — it synthesizes
a `SchemaClass` from the field list, so it is just sugar for the class
variant above, not a third shape.

### Module layout

`packages/core/src/dto/` is deleted. Its surviving pieces move to
`packages/core/src/schema/`:

| Today                                                                                                                                          | Becomes                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dto/kavo-schema.ts`                                                                                                                           | `schema/kavo-schema.ts` (unchanged)                                                                                                                                                                                                                             |
| `dto/entity-schema.ts`                                                                                                                         | `schema/entity-schema.ts` — `EntitySchemaMap`/`EntitySchema` slot types widen from `KavoSchema<T>` to `SchemaLike<T>`                                                                                                                                           |
| `dto/dto-shape.ts` (`dtoShapeKeys`)                                                                                                            | `schema/schema-shape.ts` (`schemaShapeKeys`, same reflection logic, typed against `SchemaClass`)                                                                                                                                                                |
| `dto/dto-fields-shorthand.ts`                                                                                                                  | `schema/schema-fields-shorthand.ts`                                                                                                                                                                                                                             |
| `dto/dto.ts` (`Dto`, `DtoClass`, `DtoSlot`, `OperationDtoMap`, `DtoResolver`, `OperationDtoOverride`, `DtoInputOf`/`DtoOutputOf`/`DtoQueryOf`) | deleted outright — `SchemaClass` replaces `DtoClass`; `DtoResolver` folds into the existing `SchemaResolver`/`DefaultSchemaResolver`; the `Dto*Of` helpers are deleted, and `SchemaInputOf`/`SchemaOutputOf`/`SchemaQueryOf` lose their fallback branch to them |
| `dto/default-dto-resolver.ts`                                                                                                                  | deleted — `DefaultSchemaResolver` (already exists) is the only resolver                                                                                                                                                                                         |

## Package-by-package consequences

### `@kavo/core`

- `config/entity-config.ts`: `EntityConfig.dto`, `OperationConfig.dto`, and
  `CustomOperationConfig.dto` deleted. `schema` (already present) is the
  only slot-config key; its per-operation override
  (`OperationSchemaOverride`) is unchanged in shape.
- `config/resolve-entity-config.ts`: drop `DefaultDtoResolver`
  construction. `rejectDerivedWriteDtoKeys`'s bootstrap conflict-check
  (registered write class vs. derived `create.fields`/`update.fields`)
  re-targets `schema.input.create`/`schema.input.update`.
- `config/resolved-entity-config.ts`: drop `dto: DtoResolver`; `schema:
SchemaResolver` is the only resolver field.
- `operations/default-operation-registry.ts` /
  `operations/operation-registry.ts`: `OperationDescriptor.input`/`output`/
  `query` (typed `DtoClass | null`) are deleted; only `schemaInput`/
  `schemaOutput`/`schemaQuery` remain (already `KavoSchema<unknown> | null`
  today — widen to `SchemaLike<unknown> | null`). The existing
  `resolveSchemaOverride` bootstrap check (per-operation-kind field
  validation) is unchanged; `resolveDtoOverride` is deleted.
- `serialization/serializer.ts` / `default-serializer.ts`: `serializeItem`/
  `serializeList`/`deserialize` rename their `dto` parameter to `schema:
SchemaLike<T> | null`. Narrowing branches on kind: validator kind passes
  through unchanged here (the engine's later `safeParse` step is what
  narrows/validates it — unchanged from today's `schema.output`/
  `schema.input` path); class kind runs `schemaShapeKeys` reflection
  immediately (today's `narrowToDto`/writable-projection logic, unchanged
  behavior, renamed).
- `engine/kavo-engine.ts`: delete every `config.dto.resolve(...)` call and
  its dto-specific error-message branch. `applyOutputSchema`/
  `deserializeWithSchema` gain a kind check — `.safeParse` only runs when
  the resolved schema actually has one; a class-kind schema skips straight
  to the serializer/deserializer's own reflection narrowing, running no
  engine-level validation (matching `dto`'s posture exactly, now expressed
  as "this schema happens to be class-shaped" rather than a separate
  code path).
- `service/kavo-service.ts` / `default-kavo-service.ts` /
  `service/custom-operation.ts`: `SchemaInputOf`/`SchemaOutputOf`/
  `SchemaQueryOf` lose their fallback branch to `DtoInputOf`/`DtoOutputOf`/
  `DtoQueryOf` — one source of truth.
- `index.ts`: the `Dto*` barrel exports are dropped; the `schema` module's
  surface (`KavoSchema`, `SchemaClass`, `SchemaLike`, `EntitySchema`,
  `SchemaResolver`, `DefaultSchemaResolver`, `SchemaInputOf`/
  `SchemaOutputOf`/`SchemaQueryOf`, `OperationSchemaOverride`) is exported
  instead. This is a deliberate change to the explicit named list
  (ADR-0010) — no `export *`.

### `@kavo/nest`

- `kavo.decorator.ts`: swaps `DefaultDtoResolver`/`OperationDtoMap`/
  `bodyDtoFor` for their `schema`-module equivalents. The `design:
paramtypes` metadata trick (issue #281) that lets Nest's global
  `ValidationPipe` find a `metatype` for a generated route's body now
  checks whether the resolved `schema.input.<slot>` is class-shaped before
  writing that metadata — a validator-kind schema gets no metatype (there
  is nothing for `ValidationPipe` to instantiate), a class-kind one gets
  exactly today's treatment.
- `swagger.ts` / `kavo.module.ts`: their `dtoResolver`-based OpenAPI
  generation (`schemaFromDto`, reflecting an instantiated class) becomes
  one branch of a `schema`-resolver-based generator; the other branch — a
  validator-kind schema — generates from `KavoSchema`'s structural
  contract via a new **optional** `toJSONSchema?(): object` method on the
  `KavoSchema` interface (satisfied natively by Zod 3.24+/4). A validator
  that doesn't supply it yields no schema-derived OpenAPI body, falling
  back to the entity-derived default — the same fallback an unconfigured
  slot already gets today.

### `@kavo/graphql`, `@kavo/mcp`, `@kavo/next`

No `dto`-module import exists in any of the three today — confirmed by
inventory. Only doc-comment wording naming `dto.output`/`dto.input` in
`packages/protocols/graphql/src/schema.ts`'s error messages and
`packages/frameworks/next/src/openapi/entity-schemas.ts`'s comments needs
updating to `schema.output`/`schema.input`.

### `@kavo/typeorm`, `@kavo/prisma`, `@kavo/mongoose`, `@kavo/mikroorm`

No library-code dependency. Test fixtures (`soft-delete.spec.ts` in each
adapter package, `typeorm/tests/adapter.spec.ts`) that configure `dto:
{...}` are renamed to `schema: {...}`.

## Breaking change, no migration shim

Per ADR-0055's own stated policy — "this repo is in heavy development and
does not need a write-deprecation path" — `dto` is deleted outright, not
deprecated. Every entity currently configured with `dto` needs a `schema`
equivalent; there is no dual-read period.

## Docs / ADRs

- ADR-0055 gets a short addendum (or a superseding ADR-0056) recording that
  `dto` is now fully removed and that `schema` absorbed the class-based
  mechanism as its `SchemaClass` variant, closing the "consequences" items
  it left open.
- The 22 ADRs ADR-0055 flagged for a `dto`-wording audit (0006, 0009, 0011,
  0014, 0019, 0020, 0021, 0023, 0024, 0026, 0029, 0031, 0032, 0033, 0034,
  0036, 0042, 0044, 0046, 0048, 0050, 0052) get swept in the same pass —
  wording only, not re-litigating the decisions they record.
- `docs/getting-started/`, `docs/core/`, `docs/guides/` and the
  `add-config-key`/`add-operation` skills get a grep-and-replace pass for
  `dto:`-configured examples → `schema:` examples (including one example
  using the `SchemaClass`/class-validator variant, so both shapes stay
  documented).

## Testing

- Every `packages/core/tests/**` spec currently configuring `dto: {...}`
  moves to `schema: {...}`, using either a `KavoSchema` (Zod) or a plain
  class per case — plus new coverage for the merge itself: a class-kind
  `schema.input` skipping engine-level validation, and a validator-kind one
  raising `SchemaValidationException`.
- `@kavo/nest` tests covering `ValidationPipe`/class-validator wiring
  re-target a class-kind `schema.input.<slot>`.
- `@kavo/nest` OpenAPI tests cover both the `toJSONSchema()`-derived branch
  and the class-reflection branch.
- ORM adapters' `soft-delete.spec.ts`/`adapter.spec.ts` fixtures renamed
  from `dto:` to `schema:`.

## Non-goals

- No migration shim, deprecation warning, or dual-read period (see above).
- No change to `EntityConfig.create`/`update`'s top-level `WriteFieldsConfig`
  (`fields`/`default`/`apply`) — that's a separate, already-shipped
  mechanism (issue #388), untouched by this change.
- `toJSONSchema?()` is optional and additive to `KavoSchema`; this spec
  does not mandate any particular validation library or require core to
  depend on one (ADR-0005 unchanged).
