/**
 * The standard operation ids. Every operation names its cardinality
 * explicitly — all of them are `<verb>One` here, because the optional
 * batch (`*Many`) surface the spec describes is not built: it says to drop
 * it when out of scope, and the single-item CRUD surface is complete
 * without it.
 */
export type StandardOperationId =
  "createOne" | "findOne" | "findMany" | "updateOne" | "patchOne" | "deleteOne" | "restoreOne" | "purgeOne";

/**
 * The standard ids as a runtime array, in the same order declared above —
 * the single source of truth for anything that must iterate every standard
 * operation (policy resolution, `resolve-entity-config.ts`).
 */
export const STANDARD_OPERATION_IDS: readonly StandardOperationId[] = [
  "createOne",
  "findOne",
  "findMany",
  "updateOne",
  "patchOne",
  "deleteOne",
  "restoreOne",
  "purgeOne",
] as const;

/**
 * The bare-verb name each standard operation folds into for a **class-based
 * policy** (ADR-0032's deferred Level 3 — `policy: PostPolicy`, not built
 * yet): the DTO-slot convention's own verbs (`CLAUDE.md` Conventions —
 * `create`, `update`, `patch`, `query`, `item`, `list`) plus `delete`,
 * `restore`, and `purge`, which have no DTO slot of their own but need a
 * method name regardless. `findOne`/`findMany` map to `item`/`list`
 * respectively — the response shape each one serves — not to a shared
 * `find`, since unlike `createOne`/`createMany` they share no DTO slot.
 *
 * Unused today: nothing reads this until Level 3 lands. Reserved here,
 * next to the ids it's keyed by, so the mapping is decided once rather
 * than re-derived (and possibly re-litigated) when that issue starts.
 */
export const STANDARD_OPERATION_VERB: Readonly<Record<StandardOperationId, string>> = {
  createOne: "create",
  findOne: "item",
  findMany: "list",
  updateOne: "update",
  patchOne: "patch",
  deleteOne: "delete",
  restoreOne: "restore",
  purgeOne: "purge",
};

/**
 * Any operation id — standard or custom. The `string & {}`
 * branch keeps literal-union completions for the standard ids while
 * admitting arbitrary custom names.
 */
export type OperationId = StandardOperationId | (string & {});

/** Read/write classification, used for lifecycle branching. */
export type OperationKind = "read" | "write";

/** Whether an operation targets one entity or a batch. */
export type OperationCardinality = "one" | "many";
