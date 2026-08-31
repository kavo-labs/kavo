import type { IncludeTree } from "./include-tree.js";
import type { ResolvedEntityConfig } from "../config/resolved-entity-config.js";

/** What one request asks to include, straight off the query grammar. */
export interface IncludeRequest {
  /** Dot-paths from `include=posts.comments,profile`. */
  readonly paths: readonly string[];
  /** Per-path sparse fieldsets from `select[posts]=id,title`. */
  readonly fields: Readonly<Record<string, readonly string[]>>;
}

/**
 * Turns parsed `include=` dot-paths into a validated {@link IncludeTree}:
 * every edge is checked against the relation registry (unknown
 * or non-includable → `QueryValidationException`, never silently dropped),
 * depth and node-count limits are enforced, per-node sparse fieldsets are
 * attached, and `auto` strategies are resolved. Depth is the cycle guard —
 * the same entity type may repeat on a path; resolution is bounded by
 * depth, never by visited-type tracking.
 *
 * The relation registry is not a parameter: the root's is
 * `config.relations`, and every level below reads the *target* entity's
 * own config, so a relation can never widen what its target exposes.
 */
export interface IncludeResolver<Entity = unknown> {
  resolve(request: IncludeRequest, config: ResolvedEntityConfig<Entity>): IncludeTree;
}
