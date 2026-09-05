import type { PolicyArgs } from "./kavo-policy.js";
import type { FilterExpression } from "../query/filter.js";
import type { Sort } from "../query/sort.js";
import type { FieldPath } from "../types/field-path.js";
import type { IncludePath } from "../types/include-path.js";

/**
 * The argument `apply` is called with (ADR-0048) — the same object shape
 * `policy` takes (`PolicyArgs`, ADR-0037), minus `entity`. `entity` is
 * dropped deliberately: on a single-row write, `filter.apply`'s result
 * shapes the very id lookup that would produce the row, so it cannot be
 * handed one — unlike `policy`, which always runs after that lookup.
 * `sort`/`select`/`include`'s `apply` never had a row to offer either way
 * (they only run on reads, ahead of the fetch).
 */
export type ApplyArgs<Entity = unknown> = Omit<PolicyArgs<Entity>, "entity">;

/**
 * `filter.apply` (ADR-0048): an unconditional server-side predicate, `AND`ed
 * into the client's own filter — never a replacement for it, and never
 * bypassable by one (`query-normalizer.ts`'s `applyServerFilter`). Returning
 * `undefined` means "no additional constraint this time" — the empty case
 * `apply: () => undefined` is legal without every branch of a conditional
 * having to return something.
 */
export type FilterApply<Entity = unknown> = (
  args: ApplyArgs<Entity>,
) => FilterExpression<Entity> | undefined | Promise<FilterExpression<Entity> | undefined>;

/**
 * `sort.apply` (ADR-0048): forced sort keys, prepended ahead of the
 * client's own `sort` (or `sort.default`) — never a replacement for it.
 */
export type SortApply<Entity = unknown> = (
  args: ApplyArgs<Entity>,
) => readonly Sort<Entity>[] | undefined | Promise<readonly Sort<Entity>[] | undefined>;

/**
 * `select.apply` (ADR-0048): fields force-included in the projection,
 * unioned into the client's own `select=` (or the entity-derived default) —
 * additive only, never a mask. Narrowing the projection per caller is a
 * different feature, deliberately out of scope (ADR-0048's Non-goals).
 */
export type SelectApply<Entity = unknown> = (
  args: ApplyArgs<Entity>,
) => readonly FieldPath<Entity, 1>[] | undefined | Promise<readonly FieldPath<Entity, 1>[] | undefined>;

/**
 * `include.apply` (ADR-0048): relation paths force-included, unioned into
 * the client's own `include=` before `IncludeResolver.resolve` runs — so
 * they are validated the same way any other requested path is.
 */
export type IncludeApply<Entity = unknown> = (
  args: ApplyArgs<Entity>,
) => readonly IncludePath<Entity, 1>[] | undefined | Promise<readonly IncludePath<Entity, 1>[] | undefined>;

/**
 * The four axes' `apply` results, already evaluated for one request
 * (`KavoEngine.resolveReadApply`) — what `QueryNormalizer` composes into the
 * client's own query (ADR-0048). Every key is independently optional: an
 * entity may configure `filter.apply` alone, say, and leave the rest unset.
 */
export interface ResolvedApply<Entity = unknown> {
  readonly filter?: FilterExpression<Entity>;
  readonly sort?: readonly Sort<Entity>[];
  readonly select?: readonly FieldPath<Entity, 1>[];
  readonly include?: readonly IncludePath<Entity, 1>[];
}
