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
 *
 * One key breaks the otherwise uniform algebra on purpose (ADR-0031):
 * **`cache`**. Its *presence* in an override implies `enabled: true` —
 * `cache: { ttl: 60 }` opts the scope in without spelling `enabled` — so
 * the generic object merge is followed by a presence check that flips
 * `enabled` when the override never said it. An override that did say
 * `enabled: false` (or `cache: false`, the wholesale disable) is honored
 * as written. This applies at every scope, because `mergeLevel` is the one
 * function the whole precedence chain runs through.
 */
export function mergeSettings(
  base: KavoSettings,
  ...overrides: readonly (DeepPartial<KavoSettings> | undefined)[]
): KavoSettings {
  let result: Record<string, unknown> = { ...base };
  for (const override of overrides) {
    if (override === undefined) continue;
    result = mergeLevel(result, override as Record<string, unknown>);
  }
  return result as unknown as KavoSettings;
}

function mergeLevel(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = result[key];
    if (key === "cache" && value !== false && isPlainObject(value)) {
      // ADR-0031's presence rule, and only when the override merged: a
      // plain-object `cache` override against a plain-object base. `false`
      // (wholesale disable) and object-over-non-object fall through to the
      // ordinary replace below.
      const merged = isPlainObject(current) ? mergeLevel(current, value) : { ...value };
      if (!("enabled" in value)) merged.enabled = true;
      result[key] = merged;
      continue;
    }
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
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
