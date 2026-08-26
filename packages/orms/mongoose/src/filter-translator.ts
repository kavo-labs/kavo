import type { Filter, FilterCondition, FilterExpression, FilterScalar } from "@kavo/core";
import { assertNever } from "@kavo/core";
import { assertQueryablePath } from "./relation-paths.js";

/** A MongoDB query document, built structurally — no driver type required. */
export type MongoWhere = Record<string, unknown>;

export interface FilterTranslatorOptions {
  /**
   * Relation (`ref`) property names of the entity being queried. Dotted
   * paths rooted at one of these are refused rather than silently matching
   * nothing — see {@link assertQueryablePath}.
   */
  readonly relationNames: ReadonlySet<string>;
}

/**
 * A predicate that matches no document, used for the degenerate empty-group
 * cases below. `$nor: [{}]` reads as "not (anything)"; it is spelled this
 * way rather than with a sentinel field so it stays correct for any schema.
 */
const MATCHES_NOTHING: MongoWhere = { $nor: [{}] };

/**
 * Filter AST → MongoDB query document.
 *
 * Two properties of this translation are load-bearing:
 *
 * 1. **Every comparison is wrapped in an explicit operator** (`{ $eq: v }`,
 *    never the bare `{ field: v }` shorthand). If a value ever arrived as
 *    an object, the shorthand would splice it in as *operators* — the
 *    classic NoSQL injection shape, where `{ "$gt": "" }` turns an equality
 *    check into "match everything". Core coerces filter values to scalars
 *    upstream, so this is defence in depth at the boundary rather than the
 *    only guard, but it is the boundary's job to be safe on its own terms.
 *
 * 2. **`LIKE`/`ILIKE` regex-escape the caller's pattern** before wildcards
 *    are applied, so a pattern is never able to smuggle in regex syntax.
 *    See {@link likeToRegExpSource}.
 *
 * Unlike `@kavo/typeorm`'s translator this needs no query-builder state (no
 * join aliases, no parameter numbering); unlike `@kavo/prisma`'s it cannot
 * nest a relation path, because MongoDB has no join outside an aggregation
 * pipeline.
 */
export function translateFilter<Entity>(filter: Filter<Entity>, options: FilterTranslatorOptions): MongoWhere {
  const root = filter.root;
  if (root === null) {
    return {};
  }
  return translateExpression(root, options);
}

function translateExpression(expression: FilterExpression, options: FilterTranslatorOptions): MongoWhere {
  if (expression.kind === "condition") {
    return translateCondition(expression, options);
  }

  const children = expression.children.map((child) => translateExpression(child, options));

  if (expression.operator === "NOT") {
    // `NOT` is variadic and means `NOT(AND(children))` (doc 05 §1). `$nor`
    // is MongoDB's negation, but `$nor: [a, b]` is `NOT(a OR b)` — so more
    // than one child is conjoined *first* and the conjunction negated,
    // rather than handed to `$nor` as siblings. Core's wire parser only
    // ever builds the unary shape; this guards a hand-built AST.
    if (children.length === 0) {
      return MATCHES_NOTHING;
    }
    return { $nor: [children.length === 1 ? children[0]! : { $and: children }] };
  }

  // MongoDB rejects an empty `$and`/`$or` outright, so the identity for
  // each connective is spelled explicitly. The parser enforces arity, so
  // this only guards hand-built ASTs passed programmatically.
  if (children.length === 0) {
    return expression.operator === "OR" ? MATCHES_NOTHING : {};
  }
  return expression.operator === "OR" ? { $or: children } : { $and: children };
}

function translateCondition(condition: FilterCondition, options: FilterTranslatorOptions): MongoWhere {
  const field = condition.field as string;
  assertQueryablePath(field, options.relationNames, "filtering");
  const value = condition.value;

  switch (condition.operator) {
    case "EQ":
      return { [field]: { $eq: value as FilterScalar } };
    case "NE":
      return { [field]: { $ne: value as FilterScalar } };
    case "GT":
      return { [field]: { $gt: value } };
    case "GTE":
      return { [field]: { $gte: value } };
    case "LT":
      return { [field]: { $lt: value } };
    case "LTE":
      return { [field]: { $lte: value } };
    case "IN":
      return { [field]: { $in: value as readonly FilterScalar[] } };
    case "NOT_IN":
      return { [field]: { $nin: value as readonly FilterScalar[] } };
    case "LIKE":
      return { [field]: regexMatch(value as string, false) };
    case "ILIKE":
      return { [field]: regexMatch(value as string, true) };
    case "BETWEEN": {
      const [low, high] = value as readonly FilterScalar[];
      return { [field]: { $gte: low, $lte: high } };
    }
    case "IS_NULL":
      // In MongoDB `{ $eq: null }` matches a stored null *and* an absent
      // field. That is the right reading in a document store, where "no
      // value" is ordinarily expressed by omitting the key.
      return { [field]: { $eq: null } };
    case "IS_NOT_NULL":
      return { [field]: { $ne: null } };
    default:
      // Every AST operator must translate to a predicate — proven total
      // here at build time, same guarantee as the other adapters'
      // translators.
      return assertNever(condition.operator, "filter operator");
  }
}

/**
 * `LIKE`/`ILIKE` → a MongoDB `$regex` operator object.
 *
 * `$regex` is given as a *string* source plus `$options` rather than a
 * `RegExp` instance, so a translated filter stays plain, comparable data —
 * which is what lets the translator be unit-tested without a database.
 *
 * The `s` (dotall) flag makes `_` match a newline, matching SQL `LIKE`,
 * where `_` is "any single character" with no line exception.
 */
function regexMatch(pattern: string, caseInsensitive: boolean): Record<string, unknown> {
  return {
    $regex: likeToRegExpSource(pattern),
    $options: caseInsensitive ? "is" : "s",
  };
}

/**
 * SQL `LIKE` pattern → anchored regular-expression source, per the wire
 * grammar in `docs/internals/architecture/05-query-grammar.md`: `%` matches any run
 * of characters, `_` matches exactly one, and `\` escapes either back to a
 * literal (the same `ESCAPE '\'` contract `@kavo/typeorm` hands to SQL).
 *
 * Everything that is not one of those three metacharacters is
 * regex-escaped, so the *only* pattern syntax a caller can reach is the
 * `%`/`_`/`\` the grammar grants them: a value of `.*` matches a literal
 * dot-star, and `(a|b)` matches that literal seven-character string. This
 * is what keeps a filter value from becoming an expression.
 *
 * The result is anchored because SQL `LIKE` matches the whole value —
 * `LIKE 'john'` is an equality test, not a substring search.
 *
 * The tail anchor is `(?![\s\S])`, not `$`. MongoDB evaluates `$regex` with
 * PCRE semantics, where a bare `$` matches at the end of the subject *or*
 * just before a final newline — so `like=john` would also match the stored
 * value `"john\n"`, which SQL `LIKE 'john'` does not. MongoDB exposes no
 * `PCRE_DOLLAR_ENDONLY` flag through `$options`, and `\z` is not valid in a
 * JavaScript `RegExp`, so "no character follows" is spelled as a negative
 * lookahead — which means the same thing in both engines.
 */
export function likeToRegExpSource(pattern: string): string {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) {
        // A trailing lone backslash escapes nothing; treat it as a literal.
        source += "\\\\";
        break;
      }
      source += escapeRegExp(escaped);
      index += 1;
      continue;
    }
    if (character === "%") {
      source += ".*";
      continue;
    }
    if (character === "_") {
      source += ".";
      continue;
    }
    source += escapeRegExp(character);
  }
  return `${source}(?![\\s\\S])`;
}

/** Escape every character with meaning in a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
