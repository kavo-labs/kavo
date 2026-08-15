import type { ClassRef } from "../types/utility.js";
import type { ArrayMutationStrategy } from "../config/settings.js";

export type RelationCardinality = "one" | "many";

/**
 * How an included relation is loaded:
 * - `join`  — single query with joins; correct default for to-one. Forcing
 *   it onto a to-many edge is also the eager-loading pattern for detail
 *   views (`findOne`/`findOneById`) — see architecture doc 12, section 3.
 * - `batch` — per-level `WHERE parentId IN (…)` queries stitched in
 *   memory; correct default for to-many (avoids row explosion and the
 *   joined-pagination trap).
 * - `auto`  — to-one → `join`, to-many → `batch`.
 */
export type RelationLoadStrategy = "join" | "batch" | "auto";

/**
 * One relation edge of an entity, as registered in its relation registry.
 * Populated from ORM metadata by the adapter, overridable in config.
 */
export interface RelationDescriptor {
  readonly name: string;
  /** Lazy reference to the target entity class (avoids import cycles). */
  readonly target: () => ClassRef;
  readonly cardinality: RelationCardinality;
  /**
   * Whether clients may `include=` this relation. Defaults to `false` —
   * inclusion is an opt-in allowlist, granted by `allowlists.includable`
   * (`EntityConfig`, entity-config.ts, ADR-0028), consistent with the
   * filter/sort/select posture.
   */
  readonly includable: boolean;
  /** Included even when the client doesn't ask. */
  readonly defaultInclude?: boolean;
  /** Overrides the configured `maxIncludeDepth` below this node. */
  readonly maxDepth?: number;
  readonly strategy: RelationLoadStrategy;
  /**
   * The **resolved** array-mutation strategy this relation writes through,
   * or `undefined` if it never opted in — like `includable`, opt-in,
   * granted by `relations.edges.<name>.write` in config. Unlike the raw
   * `boolean | { strategy }` config shape, this is always a concrete
   * strategy by the time a descriptor reaches this field: `write: true`'s
   * "inherit the entity default" and `write: { strategy }`'s explicit
   * override are both resolved down to one value by `DefaultRelationRegistry`,
   * which also rejects (at bootstrap) a relation whose opt-in has no
   * resolvable strategy, and one declared on a to-one relation.
   */
  readonly write?: ArrayMutationStrategy;
}
