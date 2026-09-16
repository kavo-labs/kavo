/**
 * @kavo/next — Next.js App Router binding for Kavo.
 *
 * `createKavoHandler({ users: usersCrud, ... })` returns
 * `{ GET, POST, PUT, PATCH, DELETE }` App Router route handlers that
 * dispatch through each entity's operation registry at request time — the
 * same registry `createCrud` built and `@kavo/nest`'s `@Kavo` would read,
 * since the App Router has no decorator/DI container to generate static
 * routes at all (ADR-0016; the sibling package doc explains why this
 * depends only on `@kavo/core`, never on `@kavo/nest`). This package
 * augments core's `OperationMetadata` with the same `routes` key
 * `@kavo/nest` does (ADR-0007) — the two bindings read one configuration
 * convention. `next` is an optional peerDependency: nothing here imports
 * it at runtime, since App Router handlers are plain functions over the
 * Fetch API's `Request`/`Response`.
 */
export {
  createKavoHandler,
  type KavoHandlerEntities,
  type KavoHandlerOptions,
  type KavoRouteHandler,
  type KavoRouteHandlers,
} from "./create-kavo-handler.js";
export { resolveRoute, type ResolvedRoute } from "./resolve-route.js";
export { matchRoute, type RouteMatch } from "./match-route.js";
export { parseWireParams } from "./query-params.js";
export { parseEntityTags, readPreconditions } from "./preconditions.js";
export { toResponse } from "./kavo-response.js";
export { toErrorResponse, toKavoExceptionShape } from "./error-response.js";
export type { KavoHttpMethod, KavoRouteOptions } from "./route-metadata.js";
export { buildKavoSchemas, type KavoOpenApiComponents } from "./openapi/build-kavo-schemas.js";
export type { JsonSchema } from "./openapi/json-schema.js";
