# App context replaces `principal`

**Status:** approved design, pre-implementation
**Date:** 2026-08-30
**Affected packages:** `@kavo/core`, `@kavo/nest`, `examples/nest-typeorm`
**Amends:** ADR-0032 (§217 pins `KavoContext.principal` as `unknown`), ADR-0037 (public `KavoPrincipal`)
**Touches (docs):** ADR-0006, 0019, 0025, 0027, 0031, 0035; architecture 04/06/07/10/18; configuration guides; `guides/wiring-your-own-auth.md` (rewrite)

## Problem

`KavoContext.principal: unknown` is a single fixed field: core never populates or
inspects it, the app puts one value there per call, and four consumers read it —
custom handlers, computed-field resolvers, the read result-cache key
(`canonicalize(principal)`), and the policy DSL (`KavoPrincipal`, `permission()`,
`role()`, `owner()`, `authenticated()`).

This shape forces every app into one opaque slot for "the caller" and gives it no
typing. Apps want to carry their own request-scoped context — tenant id, locale,
feature flags, a request id, the authenticated user — as a typed object they
define, and have Kavo thread it through unchanged.

## Decision

Replace `principal` with an **app context**: one app-defined, app-augmentable
object carried on `KavoContext.app`, typed by an interface the app extends
through TypeScript declaration merging. Core still never populates or inspects it.
`principal` is removed entirely — no field, no call option, no module option, no
deprecated alias.

### Why declaration merging, not a generic type parameter

`@Kavo(Entity)` is a **decorator**. It cannot infer a generic `Ctx` from a
module-level option, so a `KavoContext<Entity, Ctx>` approach erases the app-context
type at the Nest controller boundary — every controller would need an explicit
annotation or lose the typing. A process-wide augmented interface
(`interface KavoAppContext {}`, the `Express.Request` pattern) types every
`context.app.*` read everywhere for free, which matches how request-scoped app
context actually works: one shape per application, not per entity.

A per-entity generic override is explicitly **not** built now (YAGNI); the door
stays open if a real case appears.

**Spike confirmation (2026-08-30):** `declare module "@kavo/core" { interface
KavoAppContext { ... } }` merges correctly even though the interface is declared
in `context/kavo-context.ts` and the barrel re-exports it with `export type`. No
deep import into a subpath is needed, so `.dependency-cruiser.cjs` stays
satisfied. Unaugmented, `KavoAppContext` is `{}` and any `context.app.x` read is a
compile error — the intended upgrade signal for code currently casting
`context.principal`.

## Design

### 1. Core contract — `@kavo/core`

`packages/core/src/context/kavo-context.ts`:

```ts
/**
 * The app context — an app-defined, app-augmented object carried
 * unchanged through the pipeline. Core never populates or inspects it.
 * Empty ({}) until the app augments it:
 *
 *   declare module "@kavo/core" {
 *     interface KavoAppContext {
 *       userId: string;
 *       roles: string[];
 *       tenantId: string;
 *     }
 *   }
 */
export interface KavoAppContext {}

export interface KavoContext<Entity = unknown> {
  // ...unchanged members: entityName, operation, config, repository,
  //    transaction, query, correlationId, state...
  readonly app: KavoAppContext;   // replaces `readonly principal: unknown`
}
```

- `packages/core/src/context/default-kavo-context.ts`: `KavoContextInit.principal?`
  → `app?: KavoAppContext`; `createKavoContext` sets
  `app: Object.freeze(init.app ?? {})` (was `principal: init.principal ?? null`).
- `packages/core/src/service/kavo-call-options.ts`: `KavoCallOptions.principal?: unknown`
  → `app?: KavoAppContext`. JSDoc rewritten (no "authenticated caller …
  `request.user`" language; it is whatever object the caller passes).
- `packages/core/src/index.ts` (barrel, ADR-0010 — explicit list, gated by
  `tests/core-barrel.spec.ts`):
  - **add** `KavoAppContext`
  - **remove** `KavoPrincipal`
- `packages/core/src/config/computed-field.ts`: JSDoc `context.principal` →
  `context.app`.
- `packages/core/src/realtime/realtime-transport.ts`: prose uses "principal"
  generically ("the writing principal's own REST response"); reword to "the
  writing caller's" — no type change.

### 2. Result cache — `packages/core/src/engine/kavo-engine.ts` (ADR-0031)

- Cache key's `canonicalize(principal)` segment → `canonicalize(context.app)`.
- `this.cacheKey(descriptor.id, request.id, request.options?.principal, query)` →
  `... request.options?.app ...`.
- `cacheKey(operationId, id, principal: unknown, query)` signature →
  `app: KavoAppContext`; body `canonicalize(principal)` → `canonicalize(app)`. Key
  format string unchanged in shape (`operation:id:<app>:query`).
- Engine sites at lines ~265 and ~867 (`principal: request.options?.principal`)
  → `app: request.options?.app`.

**Constraint (documented, no escape hatch):** when the result cache is enabled,
`KavoAppContext` must be JSON-canonicalizable — no reference cycles. A cyclic
value (a request object, a logger, a DataSource) makes `canonicalize` recurse
until the stack overflows, inside the cache-key path of an otherwise-successful
read. This is called out in ADR-0031 and in the result-cache guide. Apps that
need a rich, non-serializable app context keep the cache off or narrow what they
put in `app`.

### 3. Policy DSL — `@kavo/core` (ADR-0032, ADR-0037)

The built-in predicate helpers stop reading a fixed `KavoPrincipal` shape off
`context.principal`. `createKavo(options)` gains optional `policy.accessors`,
`createKavo`-scope only (the app-context shape is app-global; per-entity accessors
would be re-declared in every policy block):

```ts
interface PolicyAccessors {
  /** Identity `owner(field)` compares against: entity[field] === subjectId(app). */
  subjectId?: (app: KavoAppContext) => unknown;                // default: (a) => (a as any).userId
  roles?: (app: KavoAppContext) => readonly string[];          // default: (a) => (a as any).roles ?? []
  permissions?: (app: KavoAppContext) => readonly string[];    // default: (a) => (a as any).permissions ?? []
}
```

- `permission(name)` → `permissions(app).includes(name)`
- `role(name)` → `roles(app).includes(name)`
- `owner(field = 'userId')` → `get(entity, field) === subjectId(app)` (dotted path
  support unchanged)
- `authenticated()` → `subjectId(app) != null`
- `when(predicate)` → predicate's first argument is now `app: KavoAppContext`
  (was `principal`)

Defaults reproduce today's conventional behavior with zero config. Nothing is
enforced on `KavoAppContext` — an app whose context has no `userId`/`roles` either
supplies accessors or does not use those helpers.

- `KavoPrincipal` type **deleted** (`packages/core/src/**` + barrel).
- ADR-0037 §84 references `KavoPrincipal` and `evaluatePolicy` — ADR text updated,
  not the helper names.

### 4. `@kavo/nest`

- `packages/frameworks/nest/src/principal.ts` → `app-context.ts`.
  - `KavoPrincipalRequest` → `KavoAppContextRequest` (kept as-is: structural
    request bag, `user?: unknown` + index signature).
  - `KavoPrincipalExtractor` → `KavoAppContextExtractor =
    (request: KavoAppContextRequest) => KavoAppContext`.
  - `KavoPrincipalOption` (`boolean | extractor`) → **removed**. The module option
    becomes a bare function; `true` (meaning `request.user`) has no analogue — a
    plain object cannot imply which fields to pull.
  - `principalFromRequestUser` / `resolvePrincipalExtractor` deleted; the binder
    reads the function directly (`undefined` → no options sent, `context.app`
    stays `{}`).
- `packages/frameworks/nest/src/kavo-options.ts`: `principal?: KavoPrincipalOption`
  → `app?: KavoAppContextExtractor`. JSDoc rewritten.
- `packages/frameworks/nest/src/override.decorator.ts`: `boundKavoPrincipal` →
  `boundKavoAppContext`; returns `{ app }` for the delegated `KavoCallOptions`.
- `packages/frameworks/nest/src/kavo.module.ts`, `kavo.decorator.ts`, `tokens.ts`:
  rename all `principal` wiring to `app`.
- `packages/frameworks/nest/src/index.ts` (barrel): drop `KavoPrincipalRequest`,
  `KavoPrincipalExtractor`, `KavoPrincipalOption`; add `KavoAppContextRequest`,
  `KavoAppContextExtractor`.
- `packages/frameworks/nest/tests/principal.e2e.spec.ts` → `app-context.e2e.spec.ts`,
  rewritten against the new option and a `declare module` augmentation in the
  test file.

### 5. Errors — `packages/core/src/errors/{error-catalog,exceptions}.ts`

Audit for `KAVO_*` code-name strings containing `PRINCIPAL`. Error **codes are a
stable downstream contract** — keep every code string; update only messages and
JSDoc that say "principal". (grep both files during implementation; if no code
name contains `PRINCIPAL`, this step is message-only.)

### 6. Example app — `examples/nest-typeorm` (the adopter migration reference)

Migrate every `principal` use to `app` + one `declare module "@kavo/core"`
augmentation (in a single `src/kavo-app-context.d.ts` or inline in
`app.module.ts`):

- `src/owner/owner-principal.guard.ts` → `owner-app-context.guard.ts`
- `src/owner/owner.policy.ts` — `owner()` / `when()` updated to `app`
- `src/owner/owner.controller.ts`, `src/address/address.controller.ts` —
  `boundKavoAppContext`, injected `base` call options
- `src/app.module.ts` — `KavoModule.forRootAsync({ ..., app: (req) => ... })`
- `tests/policy.e2e.spec.ts`, `tests/support/policy.ts`, `tests/crud-e2e.suite.ts`

### 7. ADR + docs

- **New ADR** via the `add-adr` skill: "App context replaces principal".
  - Records: the `principal` → `app` replacement, declaration-merging over a
    generic (decorator-inference reason), the cache canonicalizability
    constraint, `policy.accessors` with defaults.
  - `## Amends`: ADR-0032 (§217 — `KavoContext.principal` no longer `unknown`, no
    longer exists; `KavoPrincipal` deleted), ADR-0037 (§84 — `KavoPrincipal`
    deleted, helpers now accessor-driven).
- **Update** (principal mentions → app, no behavior change unless noted):
  ADR-0006 §54, ADR-0019 §157, ADR-0025 §27, ADR-0027 §19-20,
  ADR-0031 §62-72 (add the canonicalizability constraint here),
  ADR-0035 §64; architecture 04 (DTO), 06 (errors), 07 (crud-engine),
  10 (nestjs-integration), 18 (realtime); configuration guides
  (`entity-config`, `module-setup`, `operations`, `settings`, `etag-overrides`,
  `index`); `docs/core/services.md`, `docs/core/custom-operations.md`,
  `docs/features/{policy,computed-fields,result-cache}.md`,
  `docs/reference/errors.md`.
- **Rewrite:** `docs/guides/wiring-your-own-auth.md` — currently principal-centric;
  becomes "define your `KavoAppContext`, populate it in an `app` extractor (Nest)
  or per call (`{ app }`), read it in handlers / computed fields / policy". Run
  the `humanizer` pass per `writing-kavo-docs`.

## Non-goals

- No per-entity or per-operation app-context type. `createKavo`-scope only.
- No deprecated `principal` alias, no migration shim. Hard rename.
- No `cache.varyBy` escape hatch. The canonicalizability constraint is documented
  instead.
- Policy DSL keeps its current helper set and single-predicate collapse
  (ADR-0037); only the value source changes.
- Core still does not authenticate, validate, or shape the app context
  (ADR-0032 §8 non-goal preserved).

## Commit sequence (for `/commit`)

1. core contract — `KavoAppContext`, `KavoContext.app`, call option, barrel,
   `createKavoContext`, computed-field / realtime JSDoc, cache key
2. policy accessors — `policy.accessors`, helper retargeting, `KavoPrincipal`
   deletion
3. `@kavo/nest` — `app-context.ts`, module option, `override.decorator`, barrel,
   tests
4. `examples/nest-typeorm` — full migration
5. docs + ADR — new ADR, amended/updated ADRs, architecture docs, guides,
   `wiring-your-own-auth.md` rewrite

## Test surface (see `write-tests`)

- `packages/core/tests/types/*.test-d.ts`: `KavoAppContext` unaugmented is `{}`
  (a `context.app.x` read is `@ts-expect-error`); augmented, the field is typed.
  `KavoCallOptions.app` accepts the augmented shape.
- `packages/core/tests/kavo-service.spec.ts` / `cache.spec.ts`: cache key varies
  by `app`; two different `app` objects never share a cached read; identical `app`
  objects hit.
- `packages/core/tests/policy.spec.ts` + `types/policy.test-d.ts`: default
  accessors reproduce today's `permission`/`role`/`owner`/`authenticated`
  behavior; custom accessors redirect the value source; `when` receives `app`.
- `packages/core/tests/computed-fields.spec.ts`: resolver reads `context.app`.
- `packages/core/tests/core-barrel.spec.ts`: `KavoAppContext` exported,
  `KavoPrincipal` not.
- `packages/frameworks/nest/tests/app-context.e2e.spec.ts`: `app` extractor
  populates `context.app`; unset → `{}`; `boundKavoAppContext` forwards it through
  an override.
- `examples/nest-typeorm/tests/policy.e2e.spec.ts`: end-to-end owner/role checks
  still pass over the migrated wiring.
