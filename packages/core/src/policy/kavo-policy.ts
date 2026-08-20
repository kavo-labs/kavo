import type { KavoContext } from "../context/kavo-context.js";
import type { KavoRequest } from "../context/kavo-request.js";
import type { OperationId } from "../operations/operation.js";

/**
 * The request-level identifier a policy gets alongside `context`/`entity` —
 * the piece `context` itself never carries at all (ADR-0037):
 * `KavoContext` has no `id` field. The type allows `null`, for an operation
 * with no single-row target (`createOne`/`findMany`).
 *
 * Coerced against the id column's kind before a policy ever sees it — the
 * engine's policy stage runs `id` through the same `coerceId` every other
 * consumer of `request.id` does, so a numeric id column always hands a
 * policy a `number`, never the raw URL-path string HTTP requests carry it
 * as. Comparing `params.id` to a numeric literal is safe.
 *
 * Deliberately **not** `KavoRequest.query` too: over HTTP that field is a
 * `WireQuery` at runtime (raw bracket-key params, pre-coercion), not the
 * `QueryContext` its type declares, so exposing it here would type-check
 * against a shape it never actually has. `context.query` is already the
 * normalized query and is what a policy should read instead.
 */
export type WhenParams<Entity = unknown> = Pick<KavoRequest<Entity>, "id">;

/**
 * The single object argument a policy is called with (ADR-0037). `resource`
 * and `operation` mirror `context.entityName`/`context.operation` at the top
 * level so a policy doesn't have to reach through `context` for them.
 *
 * `entity` is present for a single-row operation (`findOne`/`updateOne`/
 * `patchOne`/`deleteOne`/`restoreOne`/`purgeOne`) — the engine always
 * pre-fetches the row before calling a configured policy on one of those.
 * It is `undefined` on `createOne`/`findMany`, where there is no single row.
 */
export interface PolicyArgs<Entity = unknown> {
  readonly context: KavoContext<Entity>;
  readonly entity?: Entity;
  readonly resource: string;
  readonly operation: OperationId;
  readonly params: WhenParams<Entity>;
}

/**
 * A resolved `policy` entry (ADR-0037): a single predicate over the
 * request, evaluated by the engine's policy stage before a request reaches
 * its handler. `true` allows the request through; `false` denies it with
 * `ForbiddenException`. Ordinary JS (`&&`, `||`, `!`, early returns)
 * composes multiple conditions — there is no separate combinator API.
 *
 * Resolved at three scopes, nearest wins: `operations.<id>.policy`, else
 * `EntityConfig.policy` (one default for every operation on the entity),
 * else `GlobalConfig.policy` (`createKavo({ policy })`), else unrestricted.
 * `operations.<id>.policy: false` opts one operation out of an inherited
 * entity- or global-scope default, back to unrestricted.
 */
export type Policy<Entity = unknown> = (args: PolicyArgs<Entity>) => boolean | Promise<boolean>;
