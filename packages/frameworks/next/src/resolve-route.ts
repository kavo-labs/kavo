import type { OperationDescriptor, StandardOperationId } from "@kavo/core";
import type { KavoHttpMethod, KavoRouteOptions } from "./route-metadata.js";

/**
 * The default route shape for each standard operation — identical to
 * `@kavo/nest`'s own `STANDARD_ROUTES` table, so the two bindings agree on
 * where an unconfigured entity's routes live. A new standard operation
 * needs an entry here (keyed by `StandardOperationId`, so a typo fails the
 * build).
 */
const STANDARD_ROUTES: Readonly<
  Partial<Record<StandardOperationId, { method: KavoHttpMethod; path: string; status: number }>>
> = {
  createOne: { method: "POST", path: "", status: 201 },
  findMany: { method: "GET", path: "", status: 200 },
  findOne: { method: "GET", path: ":id", status: 200 },
  updateOne: { method: "PUT", path: ":id", status: 200 },
  patchOne: { method: "PATCH", path: ":id", status: 200 },
  deleteOne: { method: "DELETE", path: ":id", status: 204 },
  restoreOne: { method: "PATCH", path: ":id/restore", status: 200 },
  purgeOne: { method: "DELETE", path: ":id/purge", status: 204 },
};

/**
 * Write operations that target a row by id and take no request body —
 * `restoreOne`/`purgeOne`. Mirrors `@kavo/nest`'s `BODYLESS_WRITES`: a
 * request against one of these ids is never parsed as JSON, even when the
 * body is present.
 */
export const BODYLESS_WRITES: ReadonlySet<StandardOperationId> = new Set<StandardOperationId>([
  "restoreOne",
  "purgeOne",
]);

const ARRAY_MUTATION_METHODS: Readonly<Record<"replace" | "list" | "add" | "remove", KavoHttpMethod>> = {
  replace: "PUT",
  list: "GET",
  add: "POST",
  remove: "DELETE",
};

export interface ResolvedRoute {
  readonly method: KavoHttpMethod;
  readonly path: string;
  readonly status: number;
  readonly hasIdParam: boolean;
}

/**
 * The route a registry entry dispatches to, or `null` for a service-only
 * operation (`meta.routes.enabled: false`). Ported from `@kavo/nest`'s
 * `resolveRoute` — same defaults, same fallback order (explicit
 * `meta.routes` → array-mutation convention → standard-operation table →
 * the custom-operation default `POST /<operation id>`) — because dispatch
 * here has to agree with what `@kavo/nest` would generate for the same
 * `createCrud` config.
 */
export function resolveRoute(descriptor: OperationDescriptor<object>): ResolvedRoute | null {
  const options: KavoRouteOptions = descriptor.meta.routes ?? {};
  if (options.enabled === false) {
    return null;
  }

  const arrayMutation = descriptor.meta.arrayMutation;
  if (arrayMutation !== undefined) {
    const method = options.method ?? ARRAY_MUTATION_METHODS[arrayMutation.action];
    const path = options.path ?? `:id/${arrayMutation.relation}`;
    const status = options.successStatus ?? 200;
    return { method, path, status, hasIdParam: path.includes(":id") };
  }

  const standard = STANDARD_ROUTES[descriptor.id as StandardOperationId];
  const method = options.method ?? standard?.method ?? "POST";
  const path = options.path ?? standard?.path ?? descriptor.id;
  const status = options.successStatus ?? standard?.status ?? (method === "POST" ? 201 : 200);
  return { method, path, status, hasIdParam: path.includes(":id") };
}
