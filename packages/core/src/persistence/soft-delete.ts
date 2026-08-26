import type { KavoSettings } from "../config/settings.js";
import type { EntityMetadata } from "../metadata/entity-metadata.js";
import { ConfigurationException } from "../errors/exceptions.js";

/**
 * How a delete is carried out for one entity:
 * - `hard` — the row is removed (the default when nothing is soft-deletable);
 * - `soft` — the delete-marker field is stamped and the row stays.
 */
export type DeleteStrategy = "hard" | "soft";

/**
 * The shape an entity opts into to become soft-deletable: one nullable
 * delete-marker field. The field name is `deletedAt` by convention and
 * configurable (`softDelete.field`) at any scope, so this interface is the
 * *documented default*, not a hard requirement — what actually decides the
 * strategy is {@link resolveSoftDelete}, which reads the resolved settings
 * against the entity's metadata.
 *
 * ```ts
 * @Entity()
 * class Owner implements SoftDeletable {
 *   @DeleteDateColumn() deletedAt!: Date | null;
 * }
 * ```
 */
export interface SoftDeletable {
  deletedAt: Date | null;
}

/**
 * The bootstrap-resolved delete strategy for one scope (entity, operation,
 * or per-call). `field` is the delete-marker column when `strategy` is
 * `soft`, and `null` when it is `hard` — that pairing is what lets adapters
 * branch on one object instead of re-deriving the decision.
 */
export type ResolvedSoftDelete =
  { readonly strategy: "hard"; readonly field: null } | { readonly strategy: "soft"; readonly field: string };

/** The zero-cost answer for everything that isn't soft-deletable. */
export const HARD_DELETE: ResolvedSoftDelete = Object.freeze({
  strategy: "hard" as const,
  field: null,
});

/**
 * Resolve the delete strategy for one settings scope:
 *
 * - `softDelete: false` or `softDelete.strategy: "hard"` → always hard;
 * - `softDelete.strategy: "soft"` → soft, and a missing marker field is a
 *   bootstrap error rather than a surprise at request time;
 * - `softDelete.strategy: "auto"` (the default) → soft when the entity
 *   actually carries a marker field, hard otherwise.
 *
 * The marker field is the configured name when the entity has such a
 * column, else the one the ORM declares (`@DeleteDateColumn` in
 * `@kavo/typeorm`, surfaced as `EntityMetadata.softDeleteField`).
 * Explicit configuration therefore wins over ORM detection, and an entity
 * with neither costs nothing.
 */
export function resolveSoftDelete<Entity>(
  metadata: EntityMetadata<Entity>,
  settings: KavoSettings,
  scope: string = metadata.name,
): ResolvedSoftDelete {
  const softDelete = settings.softDelete;
  if (softDelete === false || softDelete.strategy === "hard") {
    return HARD_DELETE;
  }

  const configured = softDelete.field;
  const hasConfiguredColumn = metadata.fields.some((field) => field.name === configured);
  const field = hasConfiguredColumn ? configured : (metadata.softDeleteField ?? null);

  if (field === null) {
    if (softDelete.strategy === "soft") {
      throw new ConfigurationException(
        scope,
        "softDelete.strategy",
        `'soft' requires a delete-marker field, but entity '${metadata.name}' has no ` +
          `'${configured}' column and the ORM declares no delete column`,
      );
    }
    return HARD_DELETE;
  }
  return Object.freeze({ strategy: "soft" as const, field });
}
