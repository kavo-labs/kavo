import type { DtoClass, FieldsShorthand } from "./dto.js";

/**
 * Field lists behind a shorthand-synthesized `DtoClass` — a `WeakMap`
 * rather than a property on the class itself, so the synthesized class
 * stays a plain, no-argument shape indistinguishable from a hand-written
 * one to anything that doesn't ask this module.
 */
const SHORTHAND_FIELDS = new WeakMap<DtoClass, readonly string[]>();

/**
 * The fields behind a shorthand-synthesized class, or `null` for a
 * hand-registered one (or no class at all). `@kavo/nest`'s Swagger
 * generation uses this to fall back to its ORM-metadata-driven body schema
 * for a shorthand slot instead of introspecting the synthesized class,
 * which carries no type information of its own.
 */
export function shorthandFieldsOf(dtoClass: DtoClass | null): readonly string[] | null {
  if (dtoClass === null) {
    return null;
  }
  return SHORTHAND_FIELDS.get(dtoClass) ?? null;
}

export function isFieldsShorthand(value: unknown): value is FieldsShorthand<unknown> {
  return typeof value === "object" && value !== null && Array.isArray((value as { fields?: unknown }).fields);
}

/**
 * Synthesizes a `DtoClass` from a field list: a constructor that assigns
 * `undefined` to each named field, giving `dtoShapeKeys` (the serializer's
 * and deserializer's own introspection) the same key set a hand-written
 * class with those fields would produce.
 */
export function dtoClassFromFields(fields: readonly string[]): DtoClass {
  const dtoClass = class FieldsShorthandDto {
    constructor() {
      for (const field of fields) {
        (this as Record<string, unknown>)[field] = undefined;
      }
    }
  };
  SHORTHAND_FIELDS.set(dtoClass, fields);
  return dtoClass;
}

/** Resolve one `dto.<slot>` entry — a class, a `{ fields }` shorthand, or unset — to a `DtoClass | null`. */
export function resolveDtoSlot<Entity>(entry: DtoClass | FieldsShorthand<Entity> | undefined): DtoClass | null {
  if (entry === undefined) {
    return null;
  }
  if (typeof entry === "function") {
    return entry;
  }
  return dtoClassFromFields(entry.fields as readonly string[]);
}
