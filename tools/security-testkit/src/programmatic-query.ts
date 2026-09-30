/**
 * Translates the wire `query` a corpus case sends into the structured query
 * a programmatic surface takes (GraphQL's `JSON` filter and `[String!]` sort,
 * an MCP tool's `filter`/`sort` arguments), so both surfaces face the same
 * attack as REST. Only what those surfaces can express is translated:
 * `filter[field][op]` conditions (ANDed) and `sort`. Anything else —
 * `select`, `search[...]`, an operator token with no AST equivalent — has
 * no programmatic spelling, and the case is skipped for that driver.
 */
const OPERATORS: ReadonlyMap<string, string> = new Map([
  ["eq", "EQ"],
  ["ne", "NE"],
  ["gt", "GT"],
  ["gte", "GTE"],
  ["lt", "LT"],
  ["lte", "LTE"],
  ["in", "IN"],
  ["notIn", "NOT_IN"],
  ["like", "LIKE"],
  ["ilike", "ILIKE"],
  ["isNull", "IS_NULL"],
  ["isNotNull", "IS_NOT_NULL"],
]);

export interface ProgrammaticQuery {
  readonly filter: unknown;
  readonly sort: readonly string[] | undefined;
}

export function toProgrammaticQuery(
  query: Readonly<Record<string, string>> | undefined,
): ProgrammaticQuery | { readonly unsupported: string } {
  const conditions: unknown[] = [];
  let sort: readonly string[] | undefined;
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key === "sort") {
      sort = value.split(",");
      continue;
    }
    const condition = /^filter\[(.+)\]\[([^\]]+)\]$/.exec(key);
    if (condition === null) {
      return { unsupported: `'${key}' has no programmatic spelling` };
    }
    const [, field, token] = condition;
    const operator = OPERATORS.get(token!);
    if (operator === undefined) {
      return { unsupported: `operator token '${token}' has no programmatic spelling` };
    }
    const operand =
      operator === "IN" || operator === "NOT_IN" ? value.split(",") : operator.startsWith("IS_") ? null : value;
    conditions.push({ kind: "condition", field, operator, value: operand });
  }
  const filter =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : { kind: "group", operator: "AND", children: conditions };
  return { filter, sort };
}
