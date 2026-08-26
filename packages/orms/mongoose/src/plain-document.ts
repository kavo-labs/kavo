/**
 * Normalizing MongoDB documents into the plain, wire-safe shape core and
 * its serializer expect.
 *
 * The one real impedance mismatch between MongoDB and `@kavo/core` is the
 * primary key: core's `EntityId` is `string | number` (deliberately —
 * ADR-0011), while MongoDB's `_id` is a 12-byte `ObjectId`. Rather than
 * widen core for one ORM, this adapter converts at its own boundary:
 * **every `ObjectId` leaving the adapter becomes its hex string.** See
 * `docs/internals/adr/0018-mongoose-models-are-entity-identities.md`.
 *
 * The reverse direction needs no code at all. Mongoose casts query and
 * write values against the schema on the way in, so a hex string handed to
 * `{ _id: id }` becomes an `ObjectId` without this package ever
 * constructing one — which is also why `@kavo/mongoose` never has to
 * import `bson`. A string that is *not* a valid `ObjectId` surfaces as a
 * Mongoose `CastError`, mapped in `error-mapping.ts`.
 */

/**
 * Structural `ObjectId` test. `toHexString` is the stable identifying
 * member across BSON versions — the `_bsontype` tag is not, having been
 * spelled `"ObjectID"` in bson 1.x and `"ObjectId"` since 4.x.
 */
export function isObjectIdLike(value: unknown): value is { toHexString(): string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  );
}

/**
 * Recursively convert a lean document (or a hydrated one, via `toObject`)
 * into plain data with `ObjectId`s rendered as hex strings.
 *
 * The walk has to be recursive rather than a top-level `_id` fix-up:
 * populated relations arrive as nested documents carrying their own
 * `ObjectId` `_id`s, and a to-many `ref` array arrives as an array of them.
 * `Date` is passed through untouched — core's coercion layer understands
 * dates, and recursing into one would shred it.
 */
export function toPlainDocument(value: unknown): unknown {
  if (isObjectIdLike(value)) {
    return value.toHexString();
  }
  // `BigInt` and `Decimal128` paths are described to core as `kind:
  // "number"`, so they have to *leave* as numbers. Neither does on its own:
  // a hydrated document's `toObject()` yields a real `bigint`, which
  // `JSON.stringify` refuses outright (a 500 on every write to such an
  // entity), and `Decimal128` stays a BSON object that serializes as
  // `{"$numberDecimal":"1.50"}`. Converting both here also makes `create`
  // agree with reads, since a `lean` read already hands back a plain number
  // for a `BigInt` path.
  //
  // Caveat, documented in the package README: this is JS-number precision,
  // so a `Decimal128` beyond ~15 significant digits rounds. The alternative
  // — surfacing them as strings — would break filtering, because MongoDB
  // compares numerically across its numeric BSON types but not against a
  // string.
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (isDecimalLike(value)) {
    return Number(String(value));
  }
  if (Array.isArray(value)) {
    return value.map(toPlainDocument);
  }
  // Anything else exotic (Buffer, …) is left alone: this adapter's
  // contract is the id and numeric conversion, not a BSON-wide codec.
  if (!isPlainObject(value)) {
    return value;
  }

  const plain: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    plain[key] = toPlainDocument(nested);
  }
  return plain;
}

/**
 * Convert whatever a write returned into a plain document. `create` has no
 * `lean` mode, so it hands back a hydrated Mongoose document — `toObject()`
 * is the documented way down to data. Reads already pass `lean: true` and
 * land in the second branch.
 *
 * The options matter as much as the call. By default `toObject()` applies
 * `schema.options.toObject`, and the common idiom
 * `schema.set('toObject', { virtuals: true, transform: (_, ret) => { ret.id
 * = ret._id; delete ret._id; } })` would then strip `_id` from the created
 * document — so `POST` would answer without the id of the resource it just
 * made, while every `lean` `GET` still returned `_id`. Opting out keeps the
 * write path shaped exactly like the read path, which is the only way the
 * entity's metadata can describe both.
 */
const RAW_DOCUMENT_OPTIONS = Object.freeze({
  virtuals: false,
  getters: false,
  transform: false,
  depopulate: true,
  flattenMaps: true,
});

export function toPlainResult(value: unknown): Record<string, unknown> {
  const source =
    typeof value === "object" && value !== null && typeof (value as { toObject?: unknown }).toObject === "function"
      ? (value as { toObject(options: object): unknown }).toObject(RAW_DOCUMENT_OPTIONS)
      : value;
  return toPlainDocument(source) as Record<string, unknown>;
}

/**
 * Structural `Decimal128` test. Unlike {@link isObjectIdLike} this one has
 * to read `_bsontype`, since `toString` alone would match almost anything;
 * the tag has been spelled `"Decimal128"` consistently since bson 4.
 *
 * Deliberately returns `boolean` rather than a type predicate: every object
 * structurally satisfies `{ toString(): string }`, so narrowing on one
 * would collapse the *else* branch to `never` and take the array and
 * plain-object cases below with it.
 */
function isDecimalLike(value: object): boolean {
  return (value as { _bsontype?: unknown })._bsontype === "Decimal128";
}

/**
 * Plain-object test that tolerates `Object.create(null)` (which lean
 * documents can be) while rejecting class instances such as `ObjectId`
 * subclasses or `Buffer`.
 */
function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
