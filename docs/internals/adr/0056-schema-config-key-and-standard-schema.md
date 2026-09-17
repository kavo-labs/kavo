# ADR-0056 — Body validation is `EntityConfig.schema`, resolved by core, run by `@kavo/next`

**Status:** accepted, supersedes [ADR-0057](/internals/adr/0057-next-body-validation-is-a-plain-function-hook)

## Context

ADR-0057 gave `@kavo/next` a `validateBody` option on `createKavoHandler`, keyed by entity, run at request-dispatch time. It worked, but it put validation wiring in the wrong file: a caller had to declare a body's shape at the route-handler call site (`route.ts`), not next to the entity's own `createCrud` config where every other axis of behavior — `filter`, `sort`, `dto` — already lives. It also required a small hand-written adapter (`lib/with-body-validation.ts` in `examples/next-prisma`) turning a Zod schema into `validateBody`'s callback shape, which is exactly the kind of per-app boilerplate a config key should make unnecessary.

The natural place to declare a body's shape is `dto.create`/`update`/`patch` — but those three slots are read by four existing consumers (`resolveDtoSlot`/`DefaultDtoResolver` in core, the response serializer's projection logic, `@kavo/next`'s `buildKavoSchemas` OpenAPI derivation, and `@kavo/nest`'s `applyParamDecorators`, which hands a `dto` class straight to NestJS's `ValidationPipe` as a `design:paramtypes` metatype). All four currently assume a `dto` slot is either a registered class or the `{fields: [...]}` shorthand (ADR issue #386) — never a runtime validator. Overloading `dto` with a third, validator-shaped value means teaching every one of those four call sites to recognize and skip it, including the Nest one where handing a non-class value to `ValidationPipe` as a metatype would fail at runtime, not compile time. That is a multi-package change with real breakage risk for a benefit `dto` doesn't need — `create`/`update`/`patch` bodies already have an independent slot to declare shape in.

`@kavo/core`'s `Dto` type stays deliberately validation-free ("there is no validation subsystem attached to them," `packages/core/src/dto/dto.ts`) — this decision does not reopen that. What it does add is a second, narrower structural key, alongside `dto`, for exactly one job: naming a schema to check a write body against.

This is deliberately named `schema`, not `validate`: [ADR-0055](/internals/adr/0055-schema-is-the-source-of-truth-for-dto-and-validation) already reserves `schema` as the eventual source of truth for DTO shape, input validation, and OpenAPI generation across `@kavo/core`. This ADR is the first concrete slice of that — narrower in scope (input validation only, `@kavo/next` only, no output/OpenAPI role yet) and reached independently via Standard Schema rather than ADR-0055's structural `KavoSchema`/`safeParse` contract. Reconciling the two — whether `@kavo/core`'s eventual `schema` key adopts Standard Schema wholesale, and whether `@kavo/nest`'s OpenAPI generation and `dto` removal (issues #466/#467) build on this ADR's shape — is follow-up work, not decided here.

## Decision

`EntityConfig` gains `schema?: { create?, update?, patch? }`, one slot per write operation — the same three slots `dto` has, but never conflated with it. Each slot accepts anything implementing [Standard Schema V1](https://standardschema.dev) (`schema['~standard'].validate(value)`) — the protocol Zod 4+, Valibot, and ArkType all implement natively, so a caller passes a Zod schema directly with no adapter:

```ts
export const books = kavo.createCrud<Book>(Book, {
  schema: { create: createBookSchema, update: updateBookSchema, patch: patchBookSchema },
  filter: { fields: ["id", "title", "published", "authorId"] },
});
```

- **`@kavo/core` resolves the key but never executes it.** `resolveEntityConfig` (`resolve-entity-config.ts`) bootstrap-checks each configured slot is actually Standard-Schema-shaped (a `ConfigurationException` naming the entity and `schema.<slot>` path otherwise, the same bar every other config error meets) and stores it unresolved on `ResolvedEntityConfig.schema` — the same "resolved but unexecuted" treatment `dto`'s classes get. Core imports nothing from `zod`, `valibot`, or any validator; `StandardSchemaV1` (`packages/core/src/validation/standard-schema.ts`) is the spec's own three-interface shape, copied rather than depended on, so ADR-0005's zero-runtime-dependency rule has nothing to except.
- **`@kavo/next`'s `createKavoHandler` is what actually calls `validate()`**, at dispatch time, right after `readBody` succeeds: it maps the resolved operation id to a slot (`createOne`→`create`, `updateOne`→`update`, `patchOne`→`patch`; a custom write with no slot dispatches unvalidated, exactly as an unregistered `dto` class would), looks up `service.engine.config.schema[slot]`, and awaits `schema['~standard'].validate(body)`. A result with `issues` short-circuits a `400` (`KAVO_NEXT_BODY_VALIDATION_FAILED`, distinct from `badRequestBody()`'s `KAVO_NEXT_INVALID_BODY`, which stays reserved for a body that isn't even valid JSON); a result with `value` replaces the dispatched body with it, honoring a schema that also normalizes or fills in defaults.
- **`@kavo/nest` needs no change.** It already has a working, generic answer — NestJS's own `ValidationPipe` reading whatever a registered `dto` class carries — so `schema` is not read there; a Nest app validates the way it always has.
- No per-call or per-operation override exists for `schema` in this iteration — only the entity-scope slot. `dto`'s per-operation override (`operations.<id>.dto`) is not mirrored here; if a real need for `operations.<id>.schema` surfaces, it is additive, not a breaking change to this shape.

## Consequences

- `examples/next-prisma` declares `schema` directly on each `createCrud` call and drops the ADR-0057 adapter file entirely; `route.ts` collapses to `createKavoHandler(kavo)`, the same auto-discovery form the docs already recommend for the simple case.
- Any Standard-Schema-compliant library works with zero Kavo-side code — this was true of ADR-0057's design too, but now with no per-app adapter needed, since the schema is handed straight to `schema` and `@kavo/next` speaks the protocol itself.
- `@kavo/nest` and `@kavo/next` still validate through genuinely different mechanisms — decorator/reflection metadata versus a config key read at dispatch — because unifying them into one core-level execution path would mean core itself calling `validate()`, which is the validation-subsystem line `Dto`'s own doc comment draws and this ADR does not cross.
- `EntityConfig` now has exactly one `schema` key, contributed to by two ADRs (0055's broader intent, 0056's concrete `@kavo/next` slice) — the follow-up issues that migrate `dto` onto `schema` (#466/#467) inherit this shape rather than choosing a new one.
