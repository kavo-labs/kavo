import type { RelationDescriptor } from "./relation-descriptor.js";
import type { ResolvedSoftDelete } from "../persistence/soft-delete.js";

/** One validated node of an include tree. */
export interface IncludeNode {
  readonly relation: RelationDescriptor;
  /**
   * The wire path addressing this node (`posts.comments`) — the key
   * `select[…]` uses, and a stable handle for adapter join aliases.
   */
  readonly path: string;
  /**
   * Sparse fieldset for this node (`select[posts]=id,title`), validated
   * against the target entity's selectable allowlist; `null` = all fields
   * the target's resolved DTO allows. Keys needed for stitching are always
   * fetched internally and stripped at serialization if not selected.
   */
  readonly fields: readonly string[] | null;
  /**
   * The resolved load strategy — never `auto`. Core answers the heuristic
   * (to-one → `join`, to-many → `batch`), so adapters translate a decision
   * rather than re-make it. `key` reaches here only on an owning-side
   * to-one edge whose config asked for it; `fields` is then always
   * `[idField]` and `children` is always empty.
   */
  readonly strategy: "join" | "batch" | "key";
  /**
   * The target entity's primary-key property (its `EntityMetadata.idField`),
   * set only when `strategy` is `"key"`. The adapter materializes the
   * relation as `{ [idField]: value }` (or `null`) from the parent's own
   * FK column, touching no join.
   */
  readonly idField?: string;
  /**
   * The *target* entity's delete strategy: soft-deleted related rows are
   * excluded from includes. Root-level `withDeleted` applies to the root
   * only — a per-include `withDeleted` is deliberately out of scope in v6.
   */
  readonly softDelete: ResolvedSoftDelete;
  readonly children: IncludeTree;
}

/**
 * A validated relation-inclusion tree, keyed by relation name. Produced by
 * `IncludeResolver` from parsed `include=` paths; overlapping paths merge
 * (`posts` + `posts.comments` → one `posts` node with a `comments` child).
 * Adapters consume it without re-validating. Empty object = no includes.
 */
export type IncludeTree = Readonly<Record<string, IncludeNode>>;
