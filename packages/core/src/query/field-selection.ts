import type { FieldPath } from "../types/field-path.js";

/**
 * Sparse-fieldset selection (`select=id,name` / `select[posts]=id,title`).
 *
 * Selection is applied *after* DTO mapping (DTO mapping → field
 * selection), so it can only narrow what the resolved DTO already exposes.
 */
export interface FieldSelection<Entity = unknown> {
  /**
   * Fields of the root resource; `null` means "everything the resolved DTO
   * allows" (no `select` param sent). Depth 1: root selection addresses own
   * columns — relation shapes are selected via {@link relations}.
   */
  readonly root: readonly FieldPath<Entity, 1>[] | null;
  /**
   * Per-included-relation fieldsets, keyed by relation path as it appeared
   * on the wire (`select[posts]=…`). Validated against the *target*
   * entity's selectable allowlist.
   */
  readonly relations: Readonly<Record<string, readonly string[]>>;
}

/**
 * The three caller-facing spellings of a fieldset, all collapsing to one
 * {@link FieldSelection} in `QueryNormalizer.normalizeInput`:
 *
 * - `['id', 'name']` — root-only sugar, mirroring `?select=id,name`.
 * - `{ root: [...], relations: { posts: [...] } }` — the structured form.
 * - `{ posts: ['id', 'title'] }` — relation-keyed, mirroring `?select[posts]=`.
 *
 * The normalized form is deliberately *not* widened: adapters and the engine
 * still see exactly one shape. Only the input is forgiving.
 *
 * `root` and `relations` are therefore reserved keys — a relation genuinely
 * named `root` or `relations` must use the structured form, which is the
 * price of the sugar reading the way the wire format does.
 *
 * The third member excludes `root`/`relations` (`& { root?: never;
 * relations?: never }`) so it cannot structurally satisfy the second: without
 * that, a relation-keyed record is a subtype of `Partial<FieldSelection>`
 * with every property optional, which swallows the structured form and
 * silences its excess-property checking — `{ root: ['nope'] }` would
 * typecheck with no complaint about the misspelled field. `normalizeInput`'s
 * runtime discrimination keys off exactly these two names, so this keeps the
 * type and the runtime agreeing on what "structured" means.
 */
export type FieldSelectionInput<Entity = unknown> =
  | readonly FieldPath<Entity, 1>[]
  | Partial<FieldSelection<Entity>>
  | (Readonly<Record<string, readonly string[]>> & { root?: never; relations?: never });
