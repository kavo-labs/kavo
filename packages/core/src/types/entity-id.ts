/**
 * Identifier types Kavo accepts for entity primary keys.
 *
 * A single-column key is a bare `string`/`number`, unchanged. A
 * composite-key entity (`EntityMetadata.compositeIdFields`, `@kavo/typeorm`
 * only as of v6.1) still travels as one opaque `string` — its columns
 * joined by `encodeCompositeId`/split by `decodeCompositeId` — so this
 * type itself never widens; only the adapter that declared
 * `compositeIdFields` knows how to read what's inside the string.
 */
export type EntityId = string | number;
