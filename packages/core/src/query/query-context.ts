import type { FilterExpression, Filter } from "./filter.js";
import type { FieldSelection, FieldSelectionInput } from "./field-selection.js";
import type { Pagination } from "./pagination.js";
import type { Sort } from "./sort.js";
import type { IncludeTree } from "../relations/include-tree.js";
import type { IncludePath } from "../types/include-path.js";

/**
 * Lenient, caller-facing query input — what a `query` DTO parses into and
 * what programmatic callers pass to `findMany`/`findOne`. Everything is
 * optional; nothing is validated yet.
 *
 * Deliberately split from {@link NormalizedQueryContext}: input is for
 * humans (sparse, forgiving), the normalized form is for the engine and
 * adapters (complete, validated, one canonical shape). The normalization
 * pipeline is the only path between them.
 */
export interface QueryContext<Entity = unknown> {
  readonly filter?: FilterExpression<Entity> | null;
  readonly sort?: readonly Sort<Entity>[];
  readonly limit?: number;
  /** Ignored under `pagination.strategy: "cursor"`, which pages by `cursor`. */
  readonly offset?: number;
  /**
   * Opaque page token from a previous list response's `meta.nextCursor`.
   * Only meaningful under `pagination.strategy: "cursor"`; supplying it
   * under any other strategy is rejected rather than ignored, so a caller
   * that thinks it is paging by keyset is told it is not.
   */
  readonly cursor?: string | null;
  /**
   * The previous poll's boundary value, from a previous list response's
   * `meta.nextSince` — a plain value (an ISO date, a UUIDv7 string, …), never
   * opaque. Only meaningful under `pagination.strategy: "since"` (ADR-0022);
   * supplying it under any other strategy is rejected rather than ignored,
   * for the same reason `cursor` is.
   */
  readonly since?: string | null;
  /** Sparse fieldsets; a bare array is sugar for root-only selection. */
  readonly select?: FieldSelectionInput<Entity>;
  /**
   * Relation include paths (`['profile', 'posts.comments']`).
   *
   * Spell-checked against the entity's relation graph. With the default
   * `Entity = unknown` this degrades to `readonly string[]`, so untyped
   * callers are unaffected.
   */
  readonly include?: readonly IncludePath<Entity>[];
  /** Include soft-deleted rows. */
  readonly withDeleted?: boolean;
  /** Only soft-deleted rows. Mutually exclusive with `withDeleted`. */
  readonly onlyDeleted?: boolean;
}

/**
 * The post-normalization query: validated against the entity's allowlists,
 * coerced, limit-enforced, and complete. Lives on `KavoContext.query` for
 * read operations; adapters consume it without re-validating.
 */
export interface NormalizedQueryContext<Entity = unknown> {
  readonly filter: Filter<Entity>;
  readonly sort: readonly Sort<Entity>[];
  /**
   * A union (ADR-0021, extended by ADR-0022): narrow with `isCursorPagination`
   * or `isSincePagination` before reading `offset`, which a keyset page
   * deliberately does not carry.
   */
  readonly pagination: Pagination<Entity>;
  readonly select: FieldSelection<Entity>;
  /** Validated include tree; empty object when nothing is included. */
  readonly include: IncludeTree;
  readonly withDeleted: boolean;
  /** Restrict the read to only soft-deleted rows. Mutually exclusive with `withDeleted`. */
  readonly onlyDeleted: boolean;
  /**
   * Whether the adapter should compute `ListResultDto.total`. `false`
   * skips the count query entirely and the envelope reports `total: null`.
   */
  readonly count: boolean;
}
