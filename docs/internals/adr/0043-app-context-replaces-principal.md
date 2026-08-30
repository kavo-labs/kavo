# ADR-0043 — `KavoContext.app` (an app-defined context) replaces `principal`

**Status:** accepted — amends [ADR-0032](/internals/adr/0032-policy-authorization-dsl) §217 and [ADR-0037](/internals/adr/0037-policy-collapses-to-a-single-predicate)

## Context

`KavoContext.principal: unknown` was a single fixed, untyped slot. Core never
populated or inspected it (doc 01 §8); it was whatever `KavoCallOptions.principal`
carried, `null` otherwise, and four consumers read it — custom operation
handlers, computed-field resolvers, the read result-cache key, and a `policy`
function. ADR-0032 §217 pinned it as `unknown` on purpose: "nothing about this ADR
narrows the context contract itself."

That shape forced every application into one opaque box named for one use
(authentication), with no typing. Applications want to carry their own
request-scoped context — the authenticated user, a tenant id, a locale, a request
id, feature flags — as a typed object they define, and have Kavo thread it through
unchanged.

A generic type parameter (`KavoContext<Entity, Ctx>`) was rejected: `@Kavo` is a
**decorator** and cannot infer a generic from a module-level option, so the type
would erase at the Nest controller boundary. A process-wide augmented interface —
the `Express.Request` pattern — types every `context.app.*` read for free and
matches how request-scoped context actually works: one shape per application, not
per entity.

## Decision

`KavoContext.principal` is removed entirely. In its place:

- **`KavoContext.app: KavoAppContext`** — a per-request object Kavo carries but
  never populates, inspects, or shapes. `KavoAppContext` is an **empty interface**
  exported from the `@kavo/core` barrel (ADR-0010), widened by the application
  through declaration merging:

  ```ts
  declare module "@kavo/core" {
    interface KavoAppContext {
      userId: string;
      roles: string[];
    }
  }
  ```

  Unaugmented it is `{}`, and every field read is a compile error — the signal to
  declare the fields the application uses. Core `src` stays zero-import
  (ADR-0005): `KavoAppContext` is a bare `interface`, no runtime.

- **`KavoCallOptions.app?: KavoAppContext`** — the one channel a programmatic
  caller fills it through. `createKavoContext` defaults it to a shared frozen `{}`.

- **`@kavo/nest`'s `app` module option** — `(request: KavoAppContextRequest) =>
KavoAppContext`, a bare function bound onto each controller instance by the
  discovery pass and run per request in the generated handler. There is no `true`
  shorthand: a plain object cannot imply which fields to pull. Unset → generated
  routes send `options: null` and `context.app` stays `{}`. `boundKavoAppContext`
  is the counterpart for methods Kavo does not generate; it throws on an object
  the binder never visited rather than answering `{}` (issue #142).

- **Result cache** — the read cache key canonicalizes `context.app` where it
  canonicalized `principal`. `KavoAppContext` must therefore be
  JSON-canonicalizable — no reference cycles — whenever the result cache is
  enabled (ADR-0031). No escape hatch; the constraint is documented.

- **Policy** — a `policy` function reads `args.context.app`. ADR-0037 already
  collapsed `policy` to a single predicate, so there is no built-in helper set or
  `KavoPrincipal` type to retarget; only the field name changes.

The word "principal" does not appear anywhere in `packages/**` after this change.
Kavo is pre-1.0; there is no deprecated alias, migration shim, or compatibility
error code.

## Consequences

- One `KavoAppContext` shape per process. A per-entity or per-operation context
  type is explicitly not provided (YAGNI); the decorator-inference problem above
  is why, and the door stays open if a real case appears.
- An application that never augments `KavoAppContext` gets a compile error on any
  `context.app.<field>` read. That is the intended upgrade signal for code that
  used to cast `context.principal`.
- ADR-0032 §217's "`KavoContext.principal` stays `unknown`" no longer holds;
  ADR-0037's reference to a `KavoPrincipal` cast target is void.
- **The type says more than the runtime guarantees.** `createKavoContext` and
  `@kavo/nest`'s `boundKavoAppContext` hand out `{}` typed as `KavoAppContext`, so
  a non-optional augmented field (`userId: string`) is `undefined` at run time on
  any request with no or a partial `app` extractor — every GraphQL/MCP call
  included. `wiring-your-own-auth.md` tells integrators to declare fields optional
  unless an extractor is guaranteed to fill them.
- **`KavoAppContext` must be plain, shallow data when the result cache is on.**
  The cache key canonicalizes it (§Result cache); a class instance with prototype
  getters canonicalizes identically for every caller and collapses the cache
  bucket, and a cyclic value overflows the stack. Documented as an integrator
  constraint (ADR-0031, the result-cache and auth guides), not enforced.
