import type { Filter, FilterCondition, FilterExpression, FilterScalar } from "@kavo/core";
import { assertNever, QueryValidationException } from "@kavo/core";
import type { PrismaRelationEdge, PrismaRelationGraph } from "./metadata.js";

/** A Prisma `where` input, built structurally — no generated type is required to build one. */
export type PrismaWhere = Record<string, unknown>;

export interface FilterTranslatorOptions {
  /**
   * Whether the target connector supports Prisma's `mode: "insensitive"`
   * string filter — Postgres and MongoDB do; MySQL, SQLite, and SQL Server
   * reject the argument outright. There is no reliable way to detect this
   * from the DMMF at runtime, so it is an explicit, caller-declared setting
   * (see `PrismaInfrastructureOptions.caseInsensitiveFilters`) rather than a
   * guess. On an unsupported connector, `ILIKE` degrades to the same
   * translation as `LIKE` — on SQLite in particular this is not a loss of
   * behavior, since SQLite's own `LIKE` is already ASCII case-insensitive.
   */
  readonly caseInsensitiveFilters: boolean;
  /** The model a relation path starts walking from — the entity being queried. */
  readonly model: string;
  /** The whole datamodel's relation edges, so a path's cardinality is knowable. */
  readonly relations: PrismaRelationGraph;
}

/**
 * A predicate that matches no row: the empty disjunction, which is `false`
 * by definition. Spelled this way rather than against the primary key
 * (`@kavo/mikroorm`'s `{ id: { $in: [] } }`) because it needs no metadata,
 * and unlike an empty `NOT` Prisma does honor it.
 */
const MATCHES_NOTHING: PrismaWhere = { OR: [] };

/**
 * Filter AST → Prisma `where` object.
 *
 * Unlike `@kavo/typeorm`'s translator, this needs no query-builder state
 * (no join aliases, no parameter numbering): Prisma's `where` already
 * nests relation paths natively (`{ author: { name: { equals: "Ada" } } }`),
 * so a relation-path field (`author.name`) nests the same translation one
 * level deeper instead of adding a join. A *to-many* segment takes a `some`
 * wrapper on the way down — see {@link nest}.
 */
export function translateFilter<Entity>(
  filter: Filter<Entity>,
  options: FilterTranslatorOptions,
): PrismaWhere | undefined {
  const root = filter.root;
  if (root === null) {
    return undefined;
  }
  return translateExpression(root, options);
}

function translateExpression(expression: FilterExpression, options: FilterTranslatorOptions): PrismaWhere {
  if (expression.kind === "condition") {
    return translateCondition(expression, options);
  }
  if (expression.operator === "NOT") {
    // `NOT` is variadic and means `NOT(AND(children))` (doc 05 §1), so no
    // child past the first is dropped (#115).
    //
    // The empty case cannot be spelled that way, though: Prisma drops a
    // `NOT` whose operand carries no condition, so `{ NOT: { AND: [] } }`
    // matches *every* row rather than none — the same silent widening #111
    // fixed in `@kavo/typeorm`, verified against a real engine in
    // `adapter.spec.ts`. `MATCHES_NOTHING` is the contradiction Prisma does
    // honor.
    if (expression.children.length === 0) {
      return MATCHES_NOTHING;
    }
    return { NOT: conjunction(expression.children, options) };
  }
  const key = expression.operator === "OR" ? "OR" : "AND";
  return { [key]: expression.children.map((child) => translateExpression(child, options)) };
}

/**
 * `AND` over `children`, as the thing `NOT` negates. A single child is
 * returned unwrapped so the common unary `NOT` keeps its exact shape.
 */
function conjunction(children: readonly FilterExpression[], options: FilterTranslatorOptions): PrismaWhere {
  if (children.length === 1) {
    return translateExpression(children[0]!, options);
  }
  return { AND: children.map((child) => translateExpression(child, options)) };
}

/**
 * Nest `condition.field` (`"author.name"`) into Prisma's native
 * relation-path shape.
 *
 * Cardinality decides the shape, which is why the translator needs the
 * relation graph at all. Prisma accepts a bare nested object only on a
 * to-one relation; on a list it requires `some`/`every`/`none` and rejects
 * the bare form with `Unknown argument`. `some` is the right one: doc 05 §3
 * defines a relation-path filter as restricting *root* rows — "a user with
 * at least one post titled x" — which is exactly what `@kavo/typeorm` gets
 * from a `LEFT JOIN` plus a `WHERE` on the joined column.
 */
function nest(field: string, leaf: Record<string, unknown>, options: FilterTranslatorOptions): PrismaWhere {
  const segments = field.split(".");
  if (segments.length === 1) {
    return { [field]: leaf };
  }

  // Walk the path first, so an unresolvable segment raises a Kavo 400
  // instead of building a `where` Prisma will reject at runtime.
  const edges: PrismaRelationEdge[] = [];
  let model = options.model;
  for (const segment of segments.slice(0, -1)) {
    const edge = options.relations.get(model)?.get(segment);
    if (edge === undefined) {
      throw unknownRelationSegment(field, segment, model);
    }
    edges.push(edge);
    model = edge.target;
  }

  // Then build outwards from the leaf, wrapping each to-many hop in `some`.
  let nested: Record<string, unknown> = { [segments[segments.length - 1]!]: leaf };
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const inner = edges[index]!.cardinality === "many" ? { some: nested } : nested;
    nested = { [segments[index]!]: inner };
  }
  return nested;
}

function unknownRelationSegment(field: string, segment: string, model: string): QueryValidationException {
  return QueryValidationException.single({
    field,
    code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    detail:
      `Query parameter '${field}' is not supported: '${segment}' is not a relation on Prisma model ` +
      `'${model}', so @kavo/prisma cannot tell whether to nest it as a to-one or a to-many filter. ` +
      `Remove '${field}' from the allowlist, or correct the path.`,
  });
}

function translateCondition(condition: FilterCondition, options: FilterTranslatorOptions): PrismaWhere {
  const field = condition.field as string;
  const value = condition.value;

  switch (condition.operator) {
    case "EQ":
      return nest(field, { equals: value as FilterScalar }, options);
    case "NE":
      return nest(field, { not: value as FilterScalar }, options);
    case "GT":
      return nest(field, { gt: value }, options);
    case "GTE":
      return nest(field, { gte: value }, options);
    case "LT":
      return nest(field, { lt: value }, options);
    case "LTE":
      return nest(field, { lte: value }, options);
    case "IN":
      return nest(field, { in: value as readonly FilterScalar[] }, options);
    case "NOT_IN":
      return nest(field, { notIn: value as readonly FilterScalar[] }, options);
    case "LIKE":
      return nest(field, likeToPrismaStringFilter(value as string, field), options);
    case "ILIKE":
      return nest(
        field,
        {
          ...likeToPrismaStringFilter(value as string, field),
          ...(options.caseInsensitiveFilters && { mode: "insensitive" }),
        },
        options,
      );
    case "BETWEEN": {
      const [low, high] = value as readonly FilterScalar[];
      return nest(field, { gte: low, lte: high }, options);
    }
    case "IS_NULL":
      return nest(field, { equals: null }, options);
    case "IS_NOT_NULL":
      return nest(field, { not: null }, options);
    default:
      // Every AST operator must translate to a predicate — proven total
      // here at build time, same guarantee as `@kavo/typeorm`'s translator.
      return assertNever(condition.operator, "filter operator");
  }
}

/** One piece of a `LIKE` pattern: literal text, `%` (any run), or `_` (exactly one). */
type LikeToken =
  { readonly kind: "literal"; readonly text: string } | { readonly kind: "any" } | { readonly kind: "one" };

/**
 * Split a `LIKE` pattern into tokens, honoring the grammar's backslash
 * escape (doc 05 §3): `\%` and `\_` are literal text, not wildcards.
 *
 * Consecutive `%` collapse into one — `a%%` and `a%` mean the same thing —
 * so the shape check downstream is about structure rather than spelling.
 * A trailing lone backslash escapes nothing and is treated as a literal,
 * matching `@kavo/mongoose`'s `likeToRegExpSource`.
 */
function tokenizeLike(pattern: string): readonly LikeToken[] {
  const tokens: LikeToken[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal !== "") {
      tokens.push({ kind: "literal", text: literal });
      literal = "";
    }
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) {
        literal += "\\";
        break;
      }
      literal += escaped;
      index += 1;
      continue;
    }
    if (character === "%") {
      flush();
      if (tokens[tokens.length - 1]?.kind !== "any") {
        tokens.push({ kind: "any" });
      }
      continue;
    }
    if (character === "_") {
      flush();
      tokens.push({ kind: "one" });
      continue;
    }
    literal += character;
  }
  flush();
  return tokens;
}

/**
 * `LIKE`/`ILIKE` → a Prisma string filter.
 *
 * Prisma's `where` has no raw pattern operator — only
 * `equals`/`startsWith`/`endsWith`/`contains` — so exactly four pattern
 * shapes are expressible, distinguished by where the wildcards sit:
 *
 * | pattern | filter        |
 * | ------- | ------------- |
 * | `john`  | `equals`      |
 * | `A%`    | `startsWith`  |
 * | `%son`  | `endsWith`    |
 * | `%j%`   | `contains`    |
 *
 * Everything else — an interior `%` (`a%b`), or any `_` at all, which
 * Prisma has no single-character wildcard for — is **rejected with a 400**
 * rather than silently downgraded. The rejected forms used to fall through
 * to `equals` on the raw pattern (#114), so the same wire request returned
 * one result set on TypeORM/Mongoose/MikroORM and a different one here,
 * with no error on either side. A 400 makes the limitation visible; see
 * `docs/internals/architecture/14-prisma-adapter.md`.
 *
 * The backslash escape is applied first, so `100\%` is the literal text
 * `100%` (an `equals`), not a `startsWith` on `100\` — matching the
 * `ESCAPE` clause `@kavo/typeorm` binds and the regex `@kavo/mongoose`
 * builds.
 */
function likeToPrismaStringFilter(pattern: string, field: string): Record<string, unknown> {
  const tokens = tokenizeLike(pattern);
  const literals = tokens.filter((token) => token.kind === "literal");
  const text = literals.length === 1 ? (literals[0] as { text: string }).text : "";

  if (!tokens.some((token) => token.kind === "one") && literals.length <= 1) {
    const leading = tokens[0]?.kind === "any";
    const trailing = tokens.length > 1 && tokens[tokens.length - 1]?.kind === "any";
    // `%` alone is one `any` token: leading with no literal, which reads as
    // `contains: ""` — every non-null value, the same set SQL `LIKE '%'` has.
    if (tokens.length === 1 && leading) {
      return { contains: "" };
    }
    if (leading && trailing) {
      return { contains: text };
    }
    if (trailing) {
      return { startsWith: text };
    }
    if (leading) {
      return { endsWith: text };
    }
    return { equals: text };
  }

  throw QueryValidationException.single({
    field,
    code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    detail:
      `Query parameter '${field}' is not supported: @kavo/prisma cannot express the pattern ` +
      `'${pattern}'. Prisma's 'where' has no raw pattern operator, so only a leading and/or ` +
      `trailing '%' is supported ('john', 'A%', '%son', '%j%'); an interior '%' and the ` +
      `single-character wildcard '_' have no equivalent. Escape a literal '%' or '_' with a ` +
      `backslash, or move the pattern to a raw query.`,
  });
}
