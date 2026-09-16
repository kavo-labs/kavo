/**
 * `@kavo/next`'s module augmentation of core's opaque `OperationMetadata`
 * (ADR-0007): route concerns attach to operation registry entries without
 * core knowing HTTP exists. This is the same `meta.routes` convention
 * `@kavo/nest` augments core with — an entity's `operations.<id>.meta.routes`
 * configures one route shape that both bindings read identically, so an app
 * that migrates from `@Kavo` to `createKavoHandler` (or serves both) keeps
 * its custom-route configuration unchanged.
 */

/** HTTP verbs the route resolver can dispatch. */
export type KavoHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface KavoRouteOptions {
  readonly method?: KavoHttpMethod;
  /** Route path relative to the entity's segment (`":id/activate"`). */
  readonly path?: string;
  /**
   * `false` = service-only: the operation stays callable in code, but no
   * route is dispatched to (`http: false`).
   */
  readonly enabled?: boolean;
  /** Success status override (defaults: 201 create, 204 delete, 200 else). */
  readonly successStatus?: number;
}

declare module "@kavo/core" {
  interface OperationMetadata {
    routes?: KavoRouteOptions;
  }
}
