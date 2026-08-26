import type { DtoClass } from "./dto.js";

const shapeCache = new WeakMap<DtoClass, readonly string[] | null>();

/**
 * The runtime key set of a DTO class, from the own enumerable properties
 * of a fresh instance.
 *
 * TypeScript class fields only exist at runtime when initialized
 * (`declare`-style or `!`-asserted fields erase), so a DTO class that
 * initializes its fields (`id = 0`) yields a precise projection, while a
 * purely declarative one yields `null` — "shape unknown" — and the caller
 * falls back to the entity-derived default. This keeps DTO classes doing
 * what v6 promises (typing, serialization, Swagger) without requiring
 * decorators or a reflection library.
 */
export function dtoShapeKeys(dto: DtoClass | null): readonly string[] | null {
  if (dto === null) {
    return null;
  }
  const cached = shapeCache.get(dto);
  if (cached !== undefined) {
    return cached;
  }
  let keys: readonly string[] | null;
  try {
    const instance = new dto();
    const ownKeys = Object.keys(instance as object);
    keys = ownKeys.length > 0 ? Object.freeze(ownKeys) : null;
  } catch {
    keys = null;
  }
  shapeCache.set(dto, keys);
  return keys;
}
