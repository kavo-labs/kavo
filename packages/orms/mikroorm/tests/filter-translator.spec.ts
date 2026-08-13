import { describe, expect, it } from "vitest";
import type { Filter, FilterExpression } from "@kavo/core";
import type { FilterTranslatorOptions } from "@kavo/mikroorm";
import { translateFilter } from "@kavo/mikroorm";

const options: FilterTranslatorOptions = { idField: "id", caseInsensitiveFilters: false };
const insensitive: FilterTranslatorOptions = { idField: "id", caseInsensitiveFilters: true };

/** The translator takes a `Filter`, which is just a root expression holder. */
function filterOf(root: FilterExpression | null): Filter {
  return { root } as Filter;
}

function translate(root: FilterExpression | null, opts = options): unknown {
  return translateFilter(filterOf(root), opts);
}

function condition(field: string, operator: string, value: unknown): FilterExpression {
  return { kind: "condition", field, operator, value } as unknown as FilterExpression;
}

describe("translateFilter — shape", () => {
  it("returns undefined for an empty filter, so no `where` is sent at all", () => {
    expect(translate(null)).toBeUndefined();
  });

  it("wraps every comparison in an explicit operator, never the bare shorthand", () => {
    // Defence in depth: `{ field: value }` would splice an object value in as
    // *operators*, which is the injection shape this spelling forecloses.
    expect(translate(condition("name", "EQ", "Ada"))).toEqual({ name: { $eq: "Ada" } });
    expect(translate(condition("name", "EQ", { $ne: "" }))).toEqual({ name: { $eq: { $ne: "" } } });
  });
});

describe("translateFilter — operators", () => {
  it.each([
    ["EQ", "Ada", { name: { $eq: "Ada" } }],
    ["NE", "Ada", { name: { $ne: "Ada" } }],
    ["GT", 30, { name: { $gt: 30 } }],
    ["GTE", 30, { name: { $gte: 30 } }],
    ["LT", 30, { name: { $lt: 30 } }],
    ["LTE", 30, { name: { $lte: 30 } }],
    ["IN", ["a", "b"], { name: { $in: ["a", "b"] } }],
    ["NOT_IN", ["a", "b"], { name: { $nin: ["a", "b"] } }],
    ["LIKE", "A%", { name: { $like: "A%" } }],
    ["BETWEEN", [1, 9], { name: { $gte: 1, $lte: 9 } }],
    ["IS_NULL", true, { name: { $eq: null } }],
    ["IS_NOT_NULL", true, { name: { $ne: null } }],
  ])("maps %s to its MikroORM operator", (operator, value, expected) => {
    expect(translate(condition("name", operator, value))).toEqual(expected);
  });

  it("degrades ILIKE to $like unless the driver is declared to support $ilike", () => {
    expect(translate(condition("name", "ILIKE", "a%"))).toEqual({ name: { $like: "a%" } });
    expect(translate(condition("name", "ILIKE", "a%"), insensitive)).toEqual({ name: { $ilike: "a%" } });
  });

  it("throws rather than dropping an operator outside the AST enum", () => {
    // A dropped predicate would silently widen the result set; the union is
    // proven total at build time and guarded at run time.
    expect(() => translate(condition("name", "SOUNDS_LIKE", "x"))).toThrowError(/filter operator/);
  });
});

describe("translateFilter — relation paths", () => {
  it("nests a dotted path into MikroORM's native relation shape", () => {
    expect(translate(condition("author.name", "EQ", "Ada"))).toEqual({ author: { name: { $eq: "Ada" } } });
  });

  it("nests a multi-segment path all the way down", () => {
    expect(translate(condition("author.city.name", "EQ", "Paris"))).toEqual({
      author: { city: { name: { $eq: "Paris" } } },
    });
  });
});

describe("translateFilter — groups", () => {
  const left = condition("name", "EQ", "Ada");
  const right = condition("age", "GT", 30);

  it("maps AND and OR groups onto $and / $or", () => {
    expect(translate({ kind: "group", operator: "AND", children: [left, right] } as FilterExpression)).toEqual({
      $and: [{ name: { $eq: "Ada" } }, { age: { $gt: 30 } }],
    });
    expect(translate({ kind: "group", operator: "OR", children: [left, right] } as FilterExpression)).toEqual({
      $or: [{ name: { $eq: "Ada" } }, { age: { $gt: 30 } }],
    });
  });

  it("maps a NOT group onto $not over its single child", () => {
    expect(translate({ kind: "group", operator: "NOT", children: [left] } as FilterExpression)).toEqual({
      $not: { name: { $eq: "Ada" } },
    });
  });

  it("conjoins a multi-child NOT rather than dropping every child past the first", () => {
    // `NOT` means `NOT(AND(children))` (doc 05 §1, #115). Negating only
    // `children[0]` returned rows the caller asked to exclude.
    expect(translate({ kind: "group", operator: "NOT", children: [left, right] } as FilterExpression)).toEqual({
      $not: { $and: [{ name: { $eq: "Ada" } }, { age: { $gt: 30 } }] },
    });
  });

  it("nests groups without losing precedence", () => {
    const nested = {
      kind: "group",
      operator: "AND",
      children: [left, { kind: "group", operator: "OR", children: [right, condition("age", "LT", 10)] }],
    } as unknown as FilterExpression;
    expect(translate(nested)).toEqual({
      $and: [{ name: { $eq: "Ada" } }, { $or: [{ age: { $gt: 30 } }, { age: { $lt: 10 } }] }],
    });
  });

  it("spells the degenerate empty groups as real predicates", () => {
    // MikroORM rejects an empty `$and`/`$or`, and `$not: {}` negates no
    // condition at all — which it renders as match-*everything*, the exact
    // opposite of what an empty OR or NOT means. An empty `$in` on the
    // primary key is the one portable contradiction.
    const empty = (operator: string) =>
      translate({ kind: "group", operator, children: [] } as unknown as FilterExpression);
    expect(empty("OR")).toEqual({ id: { $in: [] } });
    expect(empty("NOT")).toEqual({ id: { $in: [] } });
    expect(empty("AND")).toEqual({});
  });
});

/**
 * `search[query]` (issue #156) is synthesized by `QueryNormalizer` into
 * ordinary `Filter`/`FilterGroup`/`ILIKE` AST nodes — no adapter-level code
 * changed to support it. `%term%` reaches SQL `$like`/`$ilike` verbatim, per
 * the operator table above.
 */
describe("translateFilter — search[...] synthesis (issue #156)", () => {
  it("translates a substring-mode OR group across two searched fields", () => {
    expect(
      translate(
        {
          kind: "group",
          operator: "OR",
          children: [condition("title", "ILIKE", "%dune%"), condition("blurb", "ILIKE", "%dune%")],
        } as FilterExpression,
        insensitive,
      ),
    ).toEqual({
      $or: [{ title: { $ilike: "%dune%" } }, { blurb: { $ilike: "%dune%" } }],
    });
  });

  it("translates a words-mode AND of per-word OR groups", () => {
    const wordGroup = (word: string): FilterExpression =>
      ({
        kind: "group",
        operator: "OR",
        children: [condition("title", "ILIKE", `%${word}%`), condition("blurb", "ILIKE", `%${word}%`)],
      }) as FilterExpression;
    expect(
      translate(
        { kind: "group", operator: "AND", children: [wordGroup("blue"), wordGroup("book")] } as FilterExpression,
        insensitive,
      ),
    ).toEqual({
      $and: [
        { $or: [{ title: { $ilike: "%blue%" } }, { blurb: { $ilike: "%blue%" } }] },
        { $or: [{ title: { $ilike: "%book%" } }, { blurb: { $ilike: "%book%" } }] },
      ],
    });
  });

  it("nests a relation-path field the same way an ordinary relation filter does", () => {
    expect(
      translate(
        {
          kind: "group",
          operator: "OR",
          children: [condition("title", "ILIKE", "%ada%"), condition("author.name", "ILIKE", "%ada%")],
        } as FilterExpression,
        insensitive,
      ),
    ).toEqual({
      $or: [{ title: { $ilike: "%ada%" } }, { author: { name: { $ilike: "%ada%" } } }],
    });
  });

  it("narrows to a single search[fields] entry as a single condition, no OR wrapper", () => {
    expect(translate(condition("title", "ILIKE", "%dune%"), insensitive)).toEqual({ title: { $ilike: "%dune%" } });
  });
});
