# ADR-0057 — `@kavo/next` validates a write body through a plain function hook, not a decorator

**Status:** superseded by [ADR-0056](/internals/adr/0056-schema-config-key-and-standard-schema)

## Context

`@kavo/nest` never built its own validation system. `applyParamDecorators` (`kavo.decorator.ts`) writes `design:paramtypes` metadata at decoration time so NestJS's own global `ValidationPipe` resolves a metatype off a registered `dto.create`/`update`/`patch` class — whatever that class is decorated with, `class-validator`, `zod` via `nestjs-zod`, or anything else the pipe understands. The fix is deliberately generic, "not tied to one validation library."

`@kavo/next` has no decoration-time step to hang an equivalent trick off of: `createKavoHandler` resolves routes at request time (ADR-0054), and its route handlers are plain functions over the Fetch API's `Request`/`Response`, not classes NestJS's reflection metadata can attach to. A caller who wants body validation here had nothing to plug into — `examples/next-prisma` grew a local, Zod-specific workaround (`lib/with-body-validation.ts`) that wrapped `createKavoHandler`'s returned handlers from the outside, keyed on HTTP method rather than operation id, and wasn't reusable by another app.

`@kavo/core`'s `Dto` type is deliberately validation-free — "DTOs in v6 are shapes for typing, serialization, and Swagger docs — there is no validation subsystem attached to them" (`packages/core/src/dto/dto.ts`). Any body-validation seam for `@kavo/next` has to be a framework-binding-level exception to that, the same way Nest's `ValidationPipe` integration already is, not a change to core.

## Decision

`createKavoHandler`'s `KavoHandlerOptions` gains `validateBody?: Readonly<Record<string, KavoBodyValidator>>` — one validator function per entity key, the same keys the `entities` map (or its auto-discovered equivalent) uses.

```ts
export type KavoBodyValidator = (body: unknown, context: KavoBodyValidationContext) => KavoBodyValidationResult;

export interface KavoBodyValidationContext {
  readonly operation: string;
  readonly method: KavoHttpMethod;
}

export type KavoBodyValidationResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly issues: readonly KavoBodyValidationIssue[] };
```

- The validator is a plain function, run at request time inside `createKavoHandlerFromEntities`'s dispatch loop, right after `readBody` succeeds and before the `KavoRequest` is built — there is no decoration-time equivalent to hook into, so the hook lives at the one place a body actually exists.
- It receives the resolved operation id (`createOne`/`updateOne`/`patchOne`/a custom write's id) and HTTP method, so one validator can branch the way `@kavo/nest`'s separate `dto.create`/`update`/`patch` slots do, without `@kavo/next` needing three separate option keys.
- `KavoBodyValidationResult`'s shape mirrors a Zod schema's own `safeParse` result (`success`/`data`/`error.issues`) closely enough that adapting one is a two-line function — but the type itself imports nothing from `zod`, so `@kavo/next` incurs no validation dependency, matching how core stays validation-free and Nest's own hook is library-agnostic.
- A validator returning `success: false` short-circuits with a 400 problem-details response carrying a new `KAVO_NEXT_BODY_VALIDATION_FAILED` code and an `errors[]` extension of `{path, message}` — distinct from `badRequestBody()`'s existing `KAVO_NEXT_INVALID_BODY`, which is reserved for a body that isn't even valid JSON. A validator returning `success: true` replaces the dispatched body with `result.data`, so a validator that also normalizes or fills in defaults (a Zod `.transform()`, for instance) is honored.
- An entity with no entry in `validateBody` dispatches exactly as before this option existed — the hook is additive, never required.

## Consequences

- `examples/next-prisma` drops `lib/with-body-validation.ts` and passes `validateBody` directly to `createKavoHandler`, with a small local adapter turning each entity's Zod schemas into a `KavoBodyValidator`. That adapter — not `@kavo/next` — is the only place `zod` is imported.
- Because the hook keys on operation id rather than HTTP method, a future custom write operation gets validation for free the same way a standard one does, with no new option shape.
- `@kavo/nest` and `@kavo/next` still don't share a validation mechanism — Nest's stays decorator/reflection-based, Next's is a plain callback — because nothing in `.dependency-cruiser.cjs` lets one framework binding import the other's internals, and unifying them into one shared shape in core would reopen the validation-free-core decision this ADR deliberately doesn't touch.
