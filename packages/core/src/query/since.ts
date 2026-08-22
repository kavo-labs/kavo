import type { FieldMetadata } from "../metadata/entity-metadata.js";
import { ConfigurationException } from "../errors/exceptions.js";
import { encodeCompositeId } from "../metadata/composite-id.js";

/**
 * Since (seek-by-timestamp) pagination, in one module (ADR-0022).
 *
 * The wire token is a **plain, human-readable** compound value —
 * `"<since.field value>|<id>"` — never opaque, unlike {@link
 * "./cursor.js".encodeCursor}'s base64+JSON blob. It still carries an id,
 * the same tiebreaker cursor pagination's row-wise comparison needs, so
 * `QueryNormalizer.resolveSince` decodes both halves and composes the
 * *exact same* {@link "./cursor.js".keysetExpression} cursor pagination
 * uses — reusing the row-wise `(a > va) OR (a = va AND id > vid)`
 * comparison rather than inventing a new one. An inclusive single-column
 * `since.field >= value` bound (no id) was tried first and rejected: for a
 * tied group larger than `limit`, it never advances (ADR-0022).
 */

/**
 * Read the next poll's `since` boundary off one row — the `meta.nextSince`
 * payload, the since-pagination mirror of {@link "./cursor.js".cursorValuesOf}.
 *
 * Reads the **entity**, before serialization and field selection, the same
 * reason `cursorValuesOf` does: `meta` never passes through the serializer,
 * so both `since.field` and `idField` must be readable off the row
 * regardless of the response DTO (bootstrap already requires `since.field`
 * on `selectable`, and `idField` is always selectable, ADR-0022).
 */
export function sinceValueOf<Entity>(
  entity: Entity,
  sinceField: FieldMetadata,
  idField: FieldMetadata | readonly FieldMetadata[],
  entityName: string,
): string {
  const value = encodeScalar(entity, sinceField, entityName);
  const idFields = Array.isArray(idField) ? idField : [idField as FieldMetadata];
  // A composite key (issue #263) encodes its id half the same way a route
  // id does — `encodeCompositeId`'s `~`-delimited, `~~`-escaped join — so
  // `resolveSince`'s `lastIndexOf("|")` split still finds exactly one
  // boundary between the since value and the (possibly composite) id.
  const id =
    idFields.length === 1
      ? encodeScalar(entity, idFields[0]!, entityName)
      : encodeCompositeId(idFields.map((field) => encodeScalar(entity, field, entityName)));
  return `${value}|${id}`;
}

/**
 * One column's value, stringified for the wire token. `null`/`undefined`
 * become the literal text `"null"` — the same convention `coerceScalar`
 * already reads back on decode — rather than throwing: an absent or
 * genuinely `null` boundary column is `QueryNormalizer`'s problem to reject
 * on *replay* (a loud 400 naming the column, mirroring cursor pagination's
 * null-sort-key half-guard, ADR-0021 §4), not the encoder's to refuse
 * outright. A `Date` round-trips through `toISOString()`; a `string` or
 * `number` id is stringified as-is.
 */
function encodeScalar(entity: unknown, field: FieldMetadata, entityName: string): string {
  const value = (entity as Record<string, unknown>)[field.name];
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") return String(value);
  throw new ConfigurationException(
    entityName,
    "pagination.since.field",
    `cannot compute 'meta.nextSince' for '${field.name}': the column is declared '${field.kind}' but its runtime ` +
      `value is a ${describeRuntimeType(value)}. 'since'/'idField' values must be a string, number, or Date at ` +
      `runtime — bigint and decimal columns are not supported, the same limitation cursor pagination documents ` +
      `for its 'idField' tiebreaker (ADR-0021).`,
  );
}

function describeRuntimeType(value: unknown): string {
  const type = typeof value;
  if (type !== "object") return type;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name === undefined || name === "" ? "object" : `${name} object`;
}
