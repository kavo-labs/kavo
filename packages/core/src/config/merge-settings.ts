import type { KavoSettings } from "./settings.js";
import type { DeepPartial } from "../types/utility.js";

/**
 * Merge algebra for the settings tree (normative):
 *
 * - Scalars and objects-as-values: nearer scope **replaces** farther scope,
 *   key by key — an override supplies only the keys it changes.
 * - `false` disables an inheritable feature where the schema allows it
 *   (`softDelete: false`): the `false` replaces the whole subtree.
 * - Arrays replace wholesale (no element merging).
 *
 * The base is always a *complete* `KavoSettings`, so the result is too.
 * `cache` merges with exactly this generic algebra — nothing special-case
 * about it (ADR-0031 as amended): the result cache's on/off is carried by
 * `ttl` itself, so `cache: { ttl: 60 }` against the `ttl: 0` default is on
 * and `cache: { etag: false }` is off, with no presence rule to track.
 */
export function mergeSettings(
  base: KavoSettings,
  ...overrides: readonly (DeepPartial<KavoSettings> | undefined)[]
): KavoSettings {
  let result: Record<string, unknown> = { ...base };
  for (const override of overrides) {
    if (override === undefined) {
      continue;
    }
    result = mergeLevel(result, override as Record<string, unknown>);
  }
  return result as unknown as KavoSettings;
}

function mergeLevel(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const current = result[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      result[key] = mergeLevel(current, value);
    } else {
      // Scalars, arrays, `false`-disables, and object-over-non-object:
      // nearer scope replaces.
      result[key] = value;
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Recursively freeze a settings tree (resolved config is immutable). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
