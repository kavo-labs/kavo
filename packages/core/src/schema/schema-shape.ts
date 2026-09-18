import type { SchemaClass } from "./schema-class.js";

const shapeCache = new WeakMap<SchemaClass, readonly string[] | null>();

/**
 * The runtime key set of a class-shaped schema, from the own enumerable
 * properties of a fresh instance. A class that initializes its fields
 * (`id = 0`) yields a precise projection; a purely declarative one yields
 * `null` — "shape unknown" — and the caller falls back to the
 * entity-derived default.
 */
export function schemaShapeKeys(schema: SchemaClass | null): readonly string[] | null {
  if (schema === null) {
    return null;
  }
  const cached = shapeCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  let keys: readonly string[] | null;
  try {
    const instance = new schema();
    const ownKeys = Object.keys(instance as object);
    keys = ownKeys.length > 0 ? Object.freeze(ownKeys) : null;
  } catch {
    keys = null;
  }
  shapeCache.set(schema, keys);
  return keys;
}
