import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { OperationId } from "@kavo/core";
import type { KavoControllerMetadata } from "./kavo.decorator.js";
import { KAVO_CONTROLLER_METADATA, KAVO_OPERATION_METADATA } from "./tokens.js";

const reflector = new Reflector();

/**
 * The name of the entity a pending request's route is `@Kavo`-decorated
 * for, read off the class-level controller metadata — `"Post"` for
 * `@Kavo(Post)`. Answers `undefined` for a route Kavo does not own, never
 * throws.
 *
 * The counterpart of `KavoContext.entityName`, but read from Nest's
 * `ExecutionContext` (`context.getClass()`), because a `Guard` or
 * `Interceptor` runs before the controller method — the point at which the
 * engine builds `KavoContext`. That is the whole point of this accessor and
 * `getOperation`: an app-wide guard-based authorization layer can learn
 * which resource a request targets without re-deriving it from the URL.
 */
export function getResource(context: ExecutionContext): string | undefined {
  const metadata = reflector.get<KavoControllerMetadata | undefined>(KAVO_CONTROLLER_METADATA, context.getClass());
  return metadata?.entity.name;
}

/**
 * The `OperationId` a pending request's route serves, read off the
 * per-method metadata `applyRouteDecorators` writes on every generated and
 * `@Override`'d route — standard ids, custom-operation ids, and
 * synthesized `replace<Relation>`/`list<Relation>` sub-collection ids
 * alike. Answers `undefined` for a route Kavo does not own, never throws.
 *
 * The counterpart of `KavoContext.operation`, read from
 * `context.getHandler()` for the same pre-engine reason as `getResource`.
 * A manual-method-wins method generates no route through Kavo and so has no
 * metadata here; a service-only operation (`meta.routes.enabled: false`)
 * generates no route at all, so there is nothing for a guard to intercept.
 */
export function getOperation(context: ExecutionContext): OperationId | undefined {
  return reflector.get<OperationId | undefined>(KAVO_OPERATION_METADATA, context.getHandler());
}