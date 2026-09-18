import type { SchemaClass } from "./schema-class.js";
import type { FieldsShorthand } from "../config/write-fields.js";

const SHORTHAND_FIELDS = new WeakMap<SchemaClass, readonly string[]>();

/** The fields behind a shorthand-synthesized class, or `null` for a hand-registered one (or no class at all). */
export function shorthandFieldsOf(schemaClass: SchemaClass | null): readonly string[] | null {
  if (schemaClass === null) {
    return null;
  }
  return SHORTHAND_FIELDS.get(schemaClass) ?? null;
}

export function isFieldsShorthand(value: unknown): value is FieldsShorthand<unknown> {
  return typeof value === "object" && value !== null && Array.isArray((value as { fields?: unknown }).fields);
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
  entry: SchemaClass | FieldsShorthand<Entity> | undefined,
): SchemaClass | null {
  if (entry === undefined) {
    return null;
  }
  if (typeof entry === "function") {
    return entry;
  }
  return schemaClassFromFields(entry.fields as readonly string[]);
}
