import type { SchemaClass, SchemaLike } from "./schema-class.js";
import type { FieldPath } from "../types/field-path.js";

/**
 * An inline field-list shorthand for a `schema.<slot>` position (issue #386):
 * `{ fields: [...] }` derives a projection/writable-field list without a
 * hand-written class. `schemaClassFromFields` synthesizes a real
 * `SchemaClass` from it at bootstrap (`resolveSchemaClassSlot`), tagged so
 * downstream consumers (`@kavo/nest`'s Swagger generation) can tell it apart
 * from a hand-registered class.
 *
 * Every `schema` position accepts it, `create`/`update` included; those two
 * keep the top-level `EntityConfig.create.fields`/`update.fields`
 * (`config/entity-config.ts`) as the richer form (`apply`, `default`,
 * `{ exclude }`), and a schema-position list wins over it like any class.
 */
export interface FieldsShorthand<Entity> {
  readonly fields: readonly FieldPath<Entity, 1>[];
}

/**
 * Any field-list spelling a schema position accepts: the `{ fields: [...] }`
 * object, or the bare array `[...]` (same meaning, fewer braces).
 */
export type FieldsInput<Entity> = FieldsShorthand<Entity> | readonly FieldPath<Entity, 1>[];

const SHORTHAND_FIELDS = new WeakMap<object, readonly string[]>();

/** The fields behind a shorthand-synthesized class, or `null` for a hand-registered one (or no class at all). */
export function shorthandFieldsOf(schemaClass: SchemaLike<object> | null): readonly string[] | null {
  if (schemaClass === null) {
    return null;
  }
  return SHORTHAND_FIELDS.get(schemaClass) ?? null;
}

export function isFieldsShorthand(value: unknown): value is FieldsInput<unknown> {
  return (
    Array.isArray(value) ||
    (typeof value === "object" && value !== null && Array.isArray((value as { fields?: unknown }).fields))
  );
}

/** Synthesizes a `SchemaClass` from a field list — same key set a hand-written class with those fields would produce. */
export function schemaClassFromFields(fields: readonly string[]): SchemaClass {
  const schemaClass = class FieldsShorthandSchema {
    constructor() {
      for (const field of fields) {
        (this as Record<string, unknown>)[field] = undefined;
      }
    }
  };
  SHORTHAND_FIELDS.set(schemaClass, fields);
  return schemaClass;
}

/** Resolve one class-shaped schema slot entry — a class, a `{ fields }` shorthand, or unset — to a `SchemaClass | null`. */
export function resolveSchemaClassSlot<Entity>(
  entry: SchemaClass | FieldsInput<Entity> | undefined,
): SchemaClass | null {
  if (entry === undefined) {
    return null;
  }
  if (typeof entry === "function") {
    return entry;
  }
  return schemaClassFromFields(
    (Array.isArray(entry) ? entry : (entry as FieldsShorthand<Entity>).fields) as readonly string[],
  );
}
