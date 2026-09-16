import type { KavoHandlerEntities } from "../create-kavo-handler.js";
import { buildEntitySchemas } from "./entity-schemas.js";
import { sharedKavoSchemas } from "./shared-schemas.js";
import type { JsonSchema } from "./json-schema.js";

export interface KavoOpenApiComponents {
  readonly schemas: Record<string, JsonSchema>;
}

/**
 * The `@kavo/nextjs` equivalent of `@kavo/nest`'s `registerKavoSchemas`:
 * the same `entities` map `createKavoHandler` takes, turned into the
 * `components.schemas` an OpenAPI document needs — no dependency on
 * `@nestjs/swagger`, since there is no NestJS document to hoist schemas
 * out of here.
 *
 * A caller splices the result into its own document, typically served from
 * a hand-written route:
 *
 * ```ts
 * // app/api/openapi.json/route.ts
 * import { buildKavoSchemas } from "@kavo/next";
 * import { users, projects } from "../../../kavo";
 *
 * export function GET() {
 *   const { schemas } = buildKavoSchemas({ users, projects });
 *   return Response.json({
 *     openapi: "3.1.0",
 *     info: { title: "My API", version: "1.0.0" },
 *     paths: {},
 *     components: { schemas },
 *   });
 * }
 * ```
 *
 * Building `paths` (one entry per resolved route) is left to the caller:
 * unlike `@kavo/nest`, whose routes exist as real Nest handlers a Swagger
 * pass can walk, `@kavo/next`'s routes are resolved at request time —
 * `resolveRoute`/`matchRoute` are exported precisely so a caller who wants
 * a `paths` document can walk the same `engine.registry.all()` this
 * function does and reuse the identical route shapes.
 */
export function buildKavoSchemas(entities: KavoHandlerEntities): KavoOpenApiComponents {
  const schemas: Record<string, JsonSchema> = { ...sharedKavoSchemas() };
  for (const service of Object.values(entities)) {
    const entityName = service.engine.metadata.name;
    Object.assign(schemas, buildEntitySchemas(entityName, service.engine));
  }
  return { schemas };
}
