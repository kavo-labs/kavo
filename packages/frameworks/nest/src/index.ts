/**
 * @kavo/nest — NestJS binding for Kavo.
 *
 * `@Kavo(Entity)` generates routes from the entity's operation registry;
 * `KavoModule.forRoot`/`forRootAsync` host the Kavo root instance, the RFC
 * 9457 exception filter, and a discovery binder that finds every
 * `@Kavo`-decorated controller already registered in the app (however it
 * got there — an ordinary Nest `controllers:` array is enough) and binds
 * its service, with no explicit list required. `forFeature` remains for the
 * one case that still needs a real DI provider: a controller that
 * constructor-injects `getKavoServiceToken(Entity)` itself. This package
 * augments core's `OperationMetadata` with its `routes` key (ADR-0007).
 * `@nestjs/*` are peerDependencies; `@nestjs/swagger` is optional.
 */
export { Kavo, getKavoEntities, type KavoControllerMetadata } from "./kavo.decorator.js";
export { Override, type OverrideMetadata } from "./override.decorator.js";
export { getOperation, getResource } from "./route-identity.js";
export { KavoModule, type KavoModuleAsyncOptions, type KavoGraphQLOption, type KavoMcpOption } from "./kavo.module.js";
export type { KavoModuleOptions } from "./kavo-options.js";
export { KavoExceptionFilter } from "./kavo-exception.filter.js";
export { KavoResponseInterceptor } from "./kavo-response.interceptor.js";
export { ConditionalRequest, parseEntityTags } from "./conditional-request.decorator.js";
export { flattenQuery } from "./flatten-query.js";
export { KAVO_API_GUIDE } from "./swagger.js";
export { registerKavoSchemas } from "./register-schemas.js";
export { enumProp, oneOfArray, type SchemaHint } from "./schema-hints.js";
export type { KavoAppContextExtractor, KavoAppContextRequest } from "./app-context.js";
export {
  KAVO_INSTANCE,
  KAVO_MODULE_OPTIONS,
  getKavoServiceToken,
  boundKavoService,
  boundKavoAppContext,
} from "./tokens.js";
export { BaseKavoGraphQLController } from "./graphql/base-kavo-graphql.controller.js";
export { BaseKavoMcpController } from "./mcp/base-kavo-mcp.controller.js";
export type { KavoHttpMethod, KavoRouteOptions } from "./operation-metadata.js";
