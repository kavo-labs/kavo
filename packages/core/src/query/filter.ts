import type { FieldPath } from "../types/field-path.js";

/**
 * Comparison operators of the filter AST, in SCREAMING_SNAKE per the naming
 * conventions. Their camelCase wire tokens (`eq`, `notIn`, `isNotNull`, …)
 * belong to the query-string grammar; the AST never sees wire
 * spellings.
 *
 * Modeled as a string-literal union rather than a TypeScript `enum`:
 * `isolatedModules` bans `const enum` outright, a plain `enum` emits a
 * reverse-mapped runtime object that does not tree-shake, and its nominal
 * typing would force every adapter to import a *value* from core just to
 * spell an operator. (Not for lack of runtime code — ADR-0005 is about
 * runtime *dependencies*, and core ships plenty of runtime: `ERROR_CATALOG`,
 * `BUILT_IN_DEFAULTS`, `KavoEngine`, every exception class.)
 *
 * The union is kept honest by `OPERATOR_TOKENS` in `default-filter-parser`
 * (every operator must have a wire token) and by the exhaustive switch in
 * `@kavo/typeorm`'s `FilterTranslator` (every operator must translate).
 */
export type FilterOperator =
  | "EQ"
  | "NE"
  | "GT"
  | "GTE"
  | "LT"
  | "LTE"
  | "IN"
  | "NOT_IN"
  | "LIKE"
  | "ILIKE"
  | "BETWEEN"
  | "IS_NULL"
  | "IS_NOT_NULL";

/**
 * The camelCase wire spelling of each {@link FilterOperator} —
 * `filter[field][op]=` and `filter.fields`'s map form (`EntityConfig`,
 * entity-config.ts) both spell operators this way. Kept honest by
 * `OPERATOR_TOKENS satisfies Record<FilterOperator, FilterOperatorToken>`
 * in `default-filter-parser.ts`.
 */
export type FilterOperatorToken =
  "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn" | "like" | "ilike" | "between" | "isNull" | "isNotNull";

/** Logical connectives for filter groups. */
export type LogicalOperator = "AND" | "OR" | "NOT";

/** A single comparison value after type coercion. */
export type FilterScalar = string | number | boolean | Date | null;

/**
 * Comparison payload. Multi-value operators (`IN`, `NOT_IN`, `BETWEEN`)
 * carry an array; `IS_NULL`/`IS_NOT_NULL` carry `true`.
 */
export type FilterValue = FilterScalar | readonly FilterScalar[];

/** Leaf node of the filter AST: one field/operator/value comparison. */
export interface FilterCondition<Entity = unknown> {
  readonly kind: "condition";
  /** Column or allowlisted relation path (`'status'`, `'profile.city'`). */
  readonly field: FieldPath<Entity>;
  readonly operator: FilterOperator;
  readonly value: FilterValue;
}

/**
 * Branch node of the filter AST. A `NOT` group carries exactly one child;
 * `AND`/`OR` groups carry one or more. The parser enforces the
 * arity; the type stays uniform so the tree is trivially walkable.
 */
export interface FilterGroup<Entity = unknown> {
  readonly kind: "group";
  readonly operator: LogicalOperator;
  readonly children: readonly FilterExpression<Entity>[];
}

/** Any node of the filter AST. */
export type FilterExpression<Entity = unknown> = FilterCondition<Entity> | FilterGroup<Entity>;

/**
 * Root filter container. `root: null` means "match everything" — kept as an
 * explicit wrapper (rather than `FilterExpression | null` inline) so the
 * empty case has one canonical spelling across the engine and adapters.
 */
export interface Filter<Entity = unknown> {
  readonly root: FilterExpression<Entity> | null;
}
