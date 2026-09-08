export {
  createKavoGraphQLSchema,
  mergeKavoGraphQLSchemas,
  type KavoGraphQLOptions,
  type KavoGraphQLCustomOperation,
  type BoundKavoService,
} from "./schema.js";
export { registerKavoGraphQLTypes, getKavoGraphQLTypes, type KavoGraphQLTypes } from "./registry.js";
export { resolveKavoGraphQLSchema, type KavoEntityRef } from "./discovery.js";
export { GraphQLJSON } from "./json-scalar.js";
