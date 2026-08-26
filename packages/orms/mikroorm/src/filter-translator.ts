import type { Filter, FilterCondition, FilterExpression, FilterScalar } from "@kavo/core";
import { assertNever } from "@kavo/core";

/**
 * A MikroORM `FilterQuery`, built structurally as a plain object. MikroORM's
 * own `FilterQuery<T>` is entity-generic and deliberately not used here: the
 * translator works from core's AST, which is not tied to a MikroORM entity
 * type, and a plain object is what lets this be unit-tested without a
 * database.
 */
export type MikroWhere = Record<string, unknown>;

export interface FilterTranslatorOptions {
  /**
   * The entity's primary-key property. Used only to spell a contradiction
   * for the degenerate empty-group cases — see {@link matchesNothing}.
   */
  readonly idField: string;
  /**
   * Whether the target driver supports MikroORM's `$ilike` operator.
   * PostgreSQL does; SQLite, MySQL, and MongoDB do not — MikroORM passes
   * `ilike` straight through to SQL, so on those drivers it is a syntax
   * error rather than a degraded match. A MikroORM `Platform` exposes
   * nothing to detect this from, so it is a caller-declared setting (see
   * `MikroOrmInfrastructureOptions.caseInsensitiveFilters`), the same
   * posture `@kavo/prisma` takes for `mode: "insensitive"`.
   *
   * Unlike `@kavo/prisma` this defaults to **`false`**, because the two
   * failure modes are not symmetric: declaring it off on PostgreSQL costs
   * case-insensitivity, while leaving it on anywhere else makes every
   * `ILIKE` query throw. On SQLite the default is not even a loss —
   * SQLite's own `LIKE` is already ASCII case-insensitive.
   */
  readonly caseInsensitiveFilters: boolean;
}

/**
 * A predicate that matches no row.
 *
 * MikroORM rejects an empty `$and`/`$or` outright, and `$not: {}` negates
 * *no condition at all*, which it renders as a match-everything rather than
 * a match-nothing — the opposite of what these cases need. An empty `$in`
 * is the one spelling MikroORM turns into a genuine contradiction on every
 * driver, which is why this is expressed against the primary key rather
 * than with a bare connective.
 */
function matchesNothing(idField: string): MikroWhere {
  return { [idField]: { $in: [] } };
}

/**
 * Filter AST → MikroORM `FilterQuery`.
 *
 * Like `@kavo/prisma`'s translator and unlike `@kavo/typeorm`'s, this needs
 * no query-builder state — no join aliases, no parameter numbering. MikroORM
 * nests relation paths natively (`{ author: { name: { $eq: "Ada" } } }`) and
 * adds the join itself, so a relation-path field nests the same translation
 * one level deeper instead of registering a join.
 *
 * Every comparison is wrapped in an explicit operator (`{ $eq: v }`, never
 * the bare `{ field: v }` shorthand). Core coerces filter values to scalars
 * upstream, so this is defence in depth rather than the only guard — but an
 * object arriving through the shorthand would be spliced in as *operators*,
 * and the boundary's job is to be safe on its own terms.
 */
export function translateFilter<Entity>(
  filter: Filter<Entity>,
  options: FilterTranslatorOptions,
): MikroWhere | undefined {
  const root = filter.root;
  if (root === null) {
    return undefined;
  }
  return translateExpression(root, options);
}

function translateExpression(expression: FilterExpression, options: FilterTranslatorOptions): MikroWhere {
  if (expression.kind === "condition") {
    return translateCondition(expression, options);
  }

  const children = expression.children.map((child) => translateExpression(child, options));

  if (expression.operator === "NOT") {
    // `NOT` is variadic and means `NOT(AND(children))` (doc 05 §1), so more
    // than one child is conjoined first rather than having everything past
    // `children[0]` dropped. Core's wire parser only ever builds the unary
    // shape; this guards a hand-built AST.
    if (children.length === 0) {
      return matchesNothing(options.idField);
    }
    return { $not: children.length === 1 ? children[0]! : { $and: children } };
  }

  // The parser enforces arity, so the empty cases only guard hand-built ASTs
  // passed programmatically — but MikroORM rejects an empty `$and`/`$or`, so
  // the identity for each connective is spelled explicitly.
  if (children.length === 0) {
    return expression.operator === "OR" ? matchesNothing(options.idField) : {};
  }
  return expression.operator === "OR" ? { $or: children } : { $and: children };
}

/** Nest `condition.field` (`"author.name"`) into MikroORM's native relation-path shape. */
function nest(field: string, leaf: Record<string, unknown>): MikroWhere {
  return field.split(".").reduceRight<Record<string, unknown>>((inner, segment) => ({ [segment]: inner }), leaf);
}

function translateCondition(condition: FilterCondition, options: FilterTranslatorOptions): MikroWhere {
  const field = condition.field as string;
  const value = condition.value;

  switch (condition.operator) {
    case "EQ":
      return nest(field, { $eq: value as FilterScalar });
    case "NE":
      // `$ne: null` is MikroORM's `IS NOT NULL`, so a null value needs no
      // separate branch the way the SQL-string translator's does.
      return nest(field, { $ne: value as FilterScalar });
    case "GT":
      return nest(field, { $gt: value });
    case "GTE":
      return nest(field, { $gte: value });
    case "LT":
      return nest(field, { $lt: value });
    case "LTE":
      return nest(field, { $lte: value });
    case "IN":
      // MikroORM renders an empty `$in` as a contradiction rather than
      // emitting invalid `IN ()`, and an empty `$nin` as a tautology — the
      // same answers `@kavo/typeorm` has to spell out by hand because it
      // writes the SQL itself.
      return nest(field, { $in: value as readonly FilterScalar[] });
    case "NOT_IN":
      return nest(field, { $nin: value as readonly FilterScalar[] });
    case "LIKE":
      // The pattern reaches SQL `LIKE` verbatim. MikroORM has no way to
      // attach an `ESCAPE` clause, so the grammar's `\` escape for a literal
      // `%`/`_` is honored only by drivers that default to backslash
      // (PostgreSQL, MySQL) — not by SQLite, which has no default escape
      // character. See doc 17, "Adapter-specific caveats".
      return nest(field, { $like: value as string });
    case "ILIKE":
      return nest(field, options.caseInsensitiveFilters ? { $ilike: value as string } : { $like: value as string });
    case "BETWEEN": {
      const [low, high] = value as readonly FilterScalar[];
      return nest(field, { $gte: low, $lte: high });
    }
    case "IS_NULL":
      return nest(field, { $eq: null });
    case "IS_NOT_NULL":
      return nest(field, { $ne: null });
    default:
      // Every AST operator must translate to a predicate. Falling through
      // silently would drop the condition and widen the result set, so the
      // union is proven total here at build time — the same guarantee the
      // other adapters' translators give.
      return assertNever(condition.operator, "filter operator");
  }
}
