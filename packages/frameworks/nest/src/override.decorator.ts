import type { OperationId } from "@kavo/core";
import { KAVO_OVERRIDE_METADATA } from "./tokens.js";

/** What `@Override` records per decorated method, read back by `@Kavo`. */
export interface OverrideMetadata {
  readonly operationId: OperationId;
}

/**
 * Marks a hand-written controller method as an operation's implementation
 * while `@Kavo` still generates that operation's route from the registry —
 * method, path, status, `@Param`/`@Query`/`@Body`, and Swagger metadata, all
 * identical to what a generated route would carry. `operationId` defaults to
 * the decorated method's own name, the same inference manual-method-wins
 * already uses; pass it explicitly when the method name differs.
 *
 * The decorated method must accept parameters in the same fixed position
 * `@Kavo` would apply to a generated route — reads:
 * `(id?, query, preconditions, request)`; writes:
 * `(id?, body?, preconditions, request)` — undecorated, since Kavo supplies
 * those decorators itself, and declared only as far along as the method
 * actually reads. Adding your own `@Param`/`@Query`/`@Body` on an
 * overridden method is a decoration-time error (duplicate route-argument
 * metadata).
 *
 * The two trailing parameters are what an override needs to keep behavior a
 * generated route would have given it for free: `preconditions` carries the
 * `If-Match`/`If-None-Match` tokens the engine enforces (ADR-0020), and
 * `request` is what `boundKavoPrincipal(this, request)` runs the module's
 * configured `principal` extractor against.
 *
 * For a read operation, `query` arrives already wrapped in `WireQuery` — the
 * same `Query(new WireQueryPipe())` decorator `@Kavo` applies to a generated
 * route is applied to the `@Override`'d method's `query` param too, since
 * both go through the same `applyParamDecorators` call site. No manual
 * `flattenQuery`/`WireQuery` wrapping is needed before delegating:
 *
 * ```ts
 * @Override()
 * async findOne(id: EntityId, query: WireQuery) {
 *   return this.base.findOne(id as never, query as never);
 * }
 * ```
 *
 * ## What an override inherits, and what it does not
 *
 * Everything about the *route* is inherited by construction — method, path,
 * success status, param wiring, Swagger metadata — because both paths go
 * through the same `applyRouteDecorators` call. What is not inherited is
 * anything the **engine** does, because the override is what replaced the
 * call into it:
 *
 * | Behavior                    | Inherited | Why                                                                       |
 * | --------------------------- | --------- | ------------------------------------------------------------------------- |
 * | Route, params, Swagger      | yes       | same wiring as a generated route                                          |
 * | `ETag` on a single item     | yes       | supplied for a bare return by `@Kavo` (ADR-0027)                          |
 * | `If-Match` → `412`          | **no**    | evaluated in the engine; reaches it only if you forward `preconditions`   |
 * | `If-None-Match` → `304`     | **no**    | same                                                                      |
 * | Row scoping, auth           | n/a       | never Kavo's; that is why you are overriding                              |
 *
 * So an override that only needs the tag can ignore all of this: return the
 * typed service's item and `@Kavo` hashes it. One that needs the
 * **precondition** must pass `preconditions` on, which reaches the engine
 * either through `KavoCallOptions` or by calling `execute` directly:
 *
 * ```ts
 * @Override()
 * async updateOne(id: EntityId, body: Partial<Todo>, preconditions: RequestPreconditions | null) {
 *   return this.base.engine.execute({
 *     operation: "updateOne",
 *     id,
 *     body: body as never,
 *     query: null,
 *     options: null,
 *     preconditions,
 *   });
 * }
 * ```
 *
 * That form returns the engine envelope, which `KavoResponseInterceptor`
 * unwraps and tags exactly as it would a generated route's.
 *
 * One caveat worth knowing before relying on `If-Match` from an override:
 * the engine evaluates it against a **canonical read** — what `findOne`
 * would serve for that id — so an override that serves a *reshaped*
 * representation hands the client a tag the check can never match, and
 * every conditional write answers `412`. Serve the canonical shape, or set
 * `caching: { etag: false }` for that operation and own the concurrency
 * control yourself.
 *
 * Distinct from plain manual-method-wins: an undecorated method whose name
 * matches an operation id suppresses that route entirely — no method/path/
 * status/Swagger wiring happens for it. `@Override` keeps all of that,
 * swapping only which function backs the route.
 */
export function Override(operationId?: OperationId): MethodDecorator {
  return (target, propertyKey) => {
    const id = operationId ?? (propertyKey as OperationId);
    Reflect.defineMetadata(KAVO_OVERRIDE_METADATA, { operationId: id } satisfies OverrideMetadata, target, propertyKey);
  };
}
