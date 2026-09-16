import type { FieldMetadata } from "@kavo/core";
import type { JsonSchema } from "./json-schema.js";

/**
 * The base OpenAPI fragment for one column's own value type, ignoring
 * nullability — ported from `@kavo/nest`'s `swagger.ts` `fieldKindSchema`
 * so the two bindings describe the same wire kind identically.
 */
export function fieldKindSchema(field: FieldMetadata): JsonSchema {
  switch (field.kind) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "enum":
      return { type: "string", ...(field.enumValues !== undefined ? { enum: [...field.enumValues] } : {}) };
    case "json":
      return { type: "object" };
  }
}

/** Map one ORM-independent column description to its OpenAPI fragment. */
export function fieldSchema(field: FieldMetadata): JsonSchema {
  const base = fieldKindSchema(field);
  return field.nullable ? { ...base, nullable: true } : base;
}

/**
 * The per-field operator map `<Entity>Filter` values one filterable field
 * by — ported from `@kavo/nest`'s `filterOperatorsSchema` (ADR-0042,
 * docs/internals/architecture/05-query-grammar.md): the same operators for
 * every kind, plus `like`/`ilike` only for a string-kind field.
 */
export function filterOperatorsSchema(field: FieldMetadata): JsonSchema {
  const value = fieldKindSchema(field);
  const properties: Record<string, JsonSchema> = {
    eq: value,
    ne: value,
    gt: value,
    gte: value,
    lt: value,
    lte: value,
    in: { type: "array", items: value },
    notIn: { type: "array", items: value },
    between: { type: "array", items: value, minItems: 2, maxItems: 2 },
    isNull: { type: "boolean" },
    isNotNull: { type: "boolean" },
  };
  if (field.kind === "string") {
    properties.like = value;
    properties.ilike = value;
  }
  return { type: "object", properties };
}

/**
 * The request-body fragment for a write-side relation property (ADR-0014):
 * a `{ id }` reference object for a to-one, an array of them for a
 * to-many, either one nullable so `null` disassociates. Ported from
 * `@kavo/nest`'s `associationBodySchema`.
 */
export function associationBodySchema(cardinality: "one" | "many", idSchema: JsonSchema = {}): JsonSchema {
  const reference: JsonSchema = {
    type: "object",
    properties: { id: idSchema },
    required: ["id"],
    description: "Associate by id (ADR-0014); pass `null` to disassociate.",
  };
  return cardinality === "many"
    ? { type: "array", nullable: true, items: reference }
    : { ...reference, nullable: true };
}
