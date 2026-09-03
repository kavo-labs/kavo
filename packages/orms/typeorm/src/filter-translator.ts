import type { Filter, FilterBuilder, FilterCondition, FilterExpression, FilterScalar } from "@kavo/core";
import { assertNever, ConfigurationException } from "@kavo/core";
import { Brackets, NotBrackets, type WhereExpressionBuilder } from "typeorm";
import type { SelectQueryBuilder, ObjectLiteral } from "typeorm";

/**
 * A `field`/`sort.field` segment is interpolated **raw** into SQL (join
 * property paths and, worse, the `where(\`...\`)`/`addOrderBy(...)` text
 * itself — identifiers can't be bound as parameters). Upstream, every field
 * reaching here has already cleared the `filterable`/`sortable` allowlist,
 * but that allowlist is a bootstrap-configured array of strings a caller
 * could mistype or, deliberately, poison — there is no quoting or charset
 * check between it and the SQL text otherwise. This is the last line of
 * defense (issue #367 finding 1): every segment must look like an
 * identifier — letters, digits, underscore, not leading with a digit —
 * before it is allowed anywhere near the query builder.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Filter AST → TypeORM `QueryBuilder` translation.
 *
 * Groups become `Brackets`/`NotBrackets`, so precedence is explicit
 * parentheses, never operator-order luck. Parameters are numbered
 * globally per query — no collisions between conditions on the same
 * field.
 *
 * Relation-path conditions (`profile.city`) add a **non-selecting** left
 * join per path segment: they restrict root rows, they never load the
 * relation — loading is what `include=` does. Join aliases are
 * deterministic (`root__profile`), so repeated paths reuse one join, and
 * an include join registered under the same alias is reused rather than
 * duplicated.
 */
export class FilterTranslator<Entity extends ObjectLiteral> implements FilterBuilder<Entity> {
  private parameterIndex = 0;
  private readonly joins = new Set<string>();

  constructor(
    private readonly qb: SelectQueryBuilder<Entity>,
    private readonly rootAlias: string,
  ) {}

  /**
   * Record a join someone else already added under this alias scheme, so
   * `columnRef` reuses it instead of adding a duplicate. Include joins
   * select their relation; filters only restrict, so the
   * selecting join must win and this is how it is claimed.
   */
  registerJoin(alias: string): void {
    this.joins.add(alias);
  }

  apply(filter: Filter<Entity>): void {
    const root = filter.root;
    if (root === null) {
      return;
    }
    this.qb.andWhere(this.toBrackets(root));
  }

  /** Resolve `field` to a `alias.column` reference, adding joins as needed. */
  columnRef(field: string): string {
    const segments = field.split(".");
    for (const segment of segments) {
      if (!IDENTIFIER.test(segment)) {
        throw new ConfigurationException(
          this.rootAlias,
          "field",
          `'${field}' is not a valid column/relation identifier — '${segment}' contains characters an ` +
            `allowlist entry must never carry through to raw SQL.`,
        );
      }
    }
    if (segments.length === 1) {
      return `${this.rootAlias}.${field}`;
    }
    let alias = this.rootAlias;
    for (const segment of segments.slice(0, -1)) {
      const joinAlias = `${alias}__${segment}`;
      if (!this.joins.has(joinAlias)) {
        this.qb.leftJoin(`${alias}.${segment}`, joinAlias);
        this.joins.add(joinAlias);
      }
      alias = joinAlias;
    }
    return `${alias}.${segments[segments.length - 1]}`;
  }

  private toBrackets(expression: FilterExpression<Entity>): Brackets {
    if (expression.kind === "condition") {
      return new Brackets((where) => this.applyCondition(where, expression));
    }
    const children = expression.children;

    if (expression.operator === "NOT") {
      // `NOT` is variadic and means `NOT(AND(children))` (doc 05 §1), so no
      // child past the first is dropped. The empty case falls out of the
      // same rule rather than needing one: the empty conjunction is `true`,
      // and `NOT(true)` matches nothing.
      const negated = this.conjunction(children);
      return new NotBrackets((where) => {
        where.where(negated);
      });
    }

    if (children.length === 0) {
      // The identity of the connective, spelled as a *real* predicate.
      // Emitting nothing would drop the `Brackets` entirely — TypeORM
      // discards one whose callback added no condition — which silently
      // widened an empty `OR` from "matches nothing" to every row (#111).
      return new Brackets((where) => {
        where.where(expression.operator === "OR" ? "1 = 0" : "1 = 1");
      });
    }

    const connect = expression.operator === "OR" ? "orWhere" : "andWhere";
    return new Brackets((where) => {
      for (const child of children) {
        where[connect](this.toBrackets(child));
      }
    });
  }

  /**
   * `AND` over `children`, as the thing `NOT` negates. A single child is
   * returned unwrapped so the common unary `NOT` keeps its exact SQL, and
   * the empty conjunction is the tautology `1 = 1`.
   */
  private conjunction(children: readonly FilterExpression<Entity>[]): Brackets {
    if (children.length === 1) {
      return this.toBrackets(children[0]!);
    }
    return new Brackets((where) => {
      if (children.length === 0) {
        where.where("1 = 1");
        return;
      }
      for (const child of children) {
        where.andWhere(this.toBrackets(child));
      }
    });
  }

  private applyCondition(where: WhereExpressionBuilder, condition: FilterCondition<Entity>): void {
    const column = this.columnRef(condition.field as string);
    const parameter = `p${this.parameterIndex++}`;
    const value = condition.value;

    switch (condition.operator) {
      case "EQ":
        if (value === null) {
          where.where(`${column} IS NULL`);
        } else {
          where.where(`${column} = :${parameter}`, { [parameter]: value });
        }
        return;
      case "NE":
        if (value === null) {
          where.where(`${column} IS NOT NULL`);
        } else {
          where.where(`${column} != :${parameter}`, { [parameter]: value });
        }
        return;
      case "GT":
        where.where(`${column} > :${parameter}`, { [parameter]: value });
        return;
      case "GTE":
        where.where(`${column} >= :${parameter}`, { [parameter]: value });
        return;
      case "LT":
        where.where(`${column} < :${parameter}`, { [parameter]: value });
        return;
      case "LTE":
        where.where(`${column} <= :${parameter}`, { [parameter]: value });
        return;
      case "IN":
      case "NOT_IN": {
        const values = value as readonly FilterScalar[];
        if (values.length === 0) {
          // SQL `IN ()` is invalid; the empty set matches nothing (IN) /
          // everything (NOT IN).
          where.where(condition.operator === "IN" ? "1 = 0" : "1 = 1");
          return;
        }
        const keyword = condition.operator === "IN" ? "IN" : "NOT IN";
        where.where(`${column} ${keyword} (:...${parameter})`, {
          [parameter]: values as FilterScalar[],
        });
        return;
      }
      case "LIKE":
        // `\` is the documented literal-escape for `%`/`_`. Bound as a
        // parameter rather than inlined as a `'\'` string literal: MySQL's
        // default `sql_mode` treats backslash as its own in-string escape
        // character, so a literal `'\'` there is an unterminated string
        // (syntax error), while Postgres takes it literally. A bound
        // parameter sidesteps each driver's own string-literal escaping.
        where.where(`${column} LIKE :${parameter} ESCAPE :${parameter}Escape`, {
          [parameter]: value,
          [`${parameter}Escape`]: "\\",
        });
        return;
      case "ILIKE":
        // Portable case-insensitive match. Postgres has native ILIKE, but
        // LOWER() LIKE LOWER() behaves identically across every TypeORM
        // driver; one spelling beats a per-driver fork.
        where.where(`LOWER(${column}) LIKE LOWER(:${parameter}) ESCAPE :${parameter}Escape`, {
          [parameter]: value,
          [`${parameter}Escape`]: "\\",
        });
        return;
      case "BETWEEN": {
        const [low, high] = value as readonly FilterScalar[];
        where.where(`${column} BETWEEN :${parameter}_lo AND :${parameter}_hi`, {
          [`${parameter}_lo`]: low,
          [`${parameter}_hi`]: high,
        });
        return;
      }
      case "IS_NULL":
        where.where(`${column} IS NULL`);
        return;
      case "IS_NOT_NULL":
        where.where(`${column} IS NOT NULL`);
        return;
      default:
        // Every AST operator must translate to a predicate. Falling through
        // silently would drop the condition and widen the result set, so the
        // union is proven total here at build time.
        assertNever(condition.operator, "filter operator");
    }
  }
}
