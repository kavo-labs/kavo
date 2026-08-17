import { describe, expect, it } from "vitest";
import type { FilterExpression } from "@kavo/core";
import { DefaultFilterParser, evaluateFilter, resolveEntityConfig } from "@kavo/core";
import { userMetadata } from "./support/user-fixture.js";

const config = resolveEntityConfig(userMetadata, undefined, undefined);
const parser = new DefaultFilterParser(userMetadata);

/** Parses the same wire grammar REST uses, so evaluator tests exercise the real AST, not a hand-built stand-in. */
function filterOf(params: Record<string, unknown>): FilterExpression<unknown> | null {
  return parser.parse(params, config).root;
}

describe("evaluateFilter — root: null", () => {
  it("matches everything when there is no filter", () => {
    expect(evaluateFilter(null, { status: "active" })).toBe(true);
    expect(evaluateFilter(null, {})).toBe(true);
  });
});

describe("evaluateFilter — the operator table, against a matching and a non-matching item", () => {
  it.each([
    ["filter[status][eq]=active", { status: "active" }, { status: "banned" }],
    ["filter[status][ne]=banned", { status: "active" }, { status: "banned" }],
    ["filter[age][gt]=18", { age: 19 }, { age: 18 }],
    ["filter[age][gte]=18", { age: 18 }, { age: 17 }],
    ["filter[age][lt]=65", { age: 64 }, { age: 65 }],
    ["filter[age][lte]=65", { age: 65 }, { age: 66 }],
    ["filter[status][in]=active,pending", { status: "pending" }, { status: "banned" }],
    ["filter[status][notIn]=active,pending", { status: "banned" }, { status: "active" }],
    ["filter[age][between]=18,65", { age: 40 }, { age: 66 }],
    ["filter[name][isNull]=true", { name: null }, { name: "Ada" }],
    ["filter[name][isNotNull]=true", { name: "Ada" }, { name: null }],
  ])("'%s' matches the matching item and rejects the non-matching one", (query, matching, nonMatching) => {
    const [key, value] = query.split("=") as [string, string];
    const expression = filterOf({ [key]: value });
    expect(evaluateFilter(expression, matching)).toBe(true);
    expect(evaluateFilter(expression, nonMatching)).toBe(false);
  });
});

describe("evaluateFilter — SQL-like null semantics", () => {
  it.each(["eq", "ne", "gt", "gte", "lt", "lte", "in", "notIn"])(
    "'%s' never matches a null/absent item value, including NE",
    (token) => {
      const raw = token === "in" || token === "notIn" ? "a,b" : "a";
      const expression = filterOf({ [`filter[name][${token}]`]: raw });
      expect(evaluateFilter(expression, { name: null })).toBe(false);
      expect(evaluateFilter(expression, {})).toBe(false);
    },
  );

  it("BETWEEN never matches a null/absent item value", () => {
    const expression = filterOf({ "filter[age][between]": "18,65" });
    expect(evaluateFilter(expression, { age: null })).toBe(false);
    expect(evaluateFilter(expression, {})).toBe(false);
  });

  it("LIKE/ILIKE never match a null/absent item value", () => {
    expect(evaluateFilter(filterOf({ "filter[name][like]": "%an%" }), { name: null })).toBe(false);
    expect(evaluateFilter(filterOf({ "filter[name][ilike]": "%AN%" }), {})).toBe(false);
  });

  it("IS_NULL is the only operator that matches a null item value", () => {
    const expression = filterOf({ "filter[name][isNull]": "true" });
    expect(evaluateFilter(expression, { name: null })).toBe(true);
    expect(evaluateFilter(expression, {})).toBe(true);
    expect(evaluateFilter(expression, { name: "Ada" })).toBe(false);
  });
});

describe("evaluateFilter — LIKE/ILIKE", () => {
  it("translates '%' as zero-or-more and anchors the whole value", () => {
    const expression = filterOf({ "filter[name][like]": "A%e" });
    expect(evaluateFilter(expression, { name: "Ada Lovelace" })).toBe(true); // starts 'A', ends 'e'
    expect(evaluateFilter(expression, { name: "Bob" })).toBe(false); // doesn't start with 'A'
    expect(evaluateFilter(expression, { name: "Apple" })).toBe(true);
  });

  it("translates '_' as exactly one character, so length must match", () => {
    const expression = filterOf({ "filter[name][like]": "A_a" });
    expect(evaluateFilter(expression, { name: "Ada" })).toBe(true);
    expect(evaluateFilter(expression, { name: "Alaska" })).toBe(false); // right shape, wrong length — anchored
  });

  it("ILIKE is case-insensitive, LIKE is case-sensitive", () => {
    const like = filterOf({ "filter[name][like]": "%ada%" });
    const ilike = filterOf({ "filter[name][ilike]": "%ada%" });
    expect(evaluateFilter(like, { name: "Ada Lovelace" })).toBe(false);
    expect(evaluateFilter(ilike, { name: "Ada Lovelace" })).toBe(true);
  });

  it("escapes regex metacharacters in the literal portion of the pattern", () => {
    // A naive '%'/'_' -> regex translation with no escaping would treat
    // '(', ')', '+' as regex syntax here rather than literal characters.
    const expression = filterOf({ "filter[name][like]": "a+b(c)%" });
    expect(evaluateFilter(expression, { name: "a+b(c)ANYTHING" })).toBe(true);
    expect(evaluateFilter(expression, { name: "aXbXcXANYTHING" })).toBe(false);
  });

  it("honors a backslash-escaped literal '%'", () => {
    const expression = filterOf({ "filter[name][like]": "100\\%" });
    expect(evaluateFilter(expression, { name: "100%" })).toBe(true);
    expect(evaluateFilter(expression, { name: "100x" })).toBe(false);
  });
});

describe("evaluateFilter — dates", () => {
  it("compares a Date item value against the coerced Date filter value", () => {
    const expression = filterOf({ "filter[createdAt][gte]": "2026-01-01" });
    expect(evaluateFilter(expression, { createdAt: new Date("2026-06-01") })).toBe(true);
    expect(evaluateFilter(expression, { createdAt: new Date("2025-01-01") })).toBe(false);
  });

  it("parses an ISO string item value to compare against a Date filter value", () => {
    // Not every item source hands the evaluator a real `Date` instance —
    // an ORM adapter or a hand-built RealtimeTransport fixture might not.
    const expression = filterOf({ "filter[createdAt][lt]": "2026-06-01" });
    expect(evaluateFilter(expression, { createdAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
    expect(evaluateFilter(expression, { createdAt: "2026-12-01T00:00:00.000Z" })).toBe(false);
  });
});

describe("evaluateFilter — non-orderable item values", () => {
  it("an ordered comparison against a boolean or object item value is false, never a crash", () => {
    const expression = filterOf({ "filter[age][gt]": "5" });
    for (const item of [{ age: true }, { age: {} }, { age: [] }]) {
      expect(evaluateFilter(expression, item)).toBe(false);
    }
  });

  it("an ordered comparison against a boolean filter value is false too", () => {
    const expression = { kind: "condition", field: "age", operator: "GT", value: true } as never;
    expect(evaluateFilter(expression, { age: 5 })).toBe(false);
  });
});

describe("evaluateFilter — logical operators", () => {
  it("AND requires every child to match", () => {
    const expression = filterOf({ "filter[status][eq]": "active", "filter[age][gte]": "18" });
    expect(evaluateFilter(expression, { status: "active", age: 20 })).toBe(true);
    expect(evaluateFilter(expression, { status: "active", age: 10 })).toBe(false);
  });

  it("OR requires at least one child to match", () => {
    const expression = filterOf({
      "filter[or][0][status][eq]": "active",
      "filter[or][1][status][eq]": "pending",
    });
    expect(evaluateFilter(expression, { status: "pending" })).toBe(true);
    expect(evaluateFilter(expression, { status: "banned" })).toBe(false);
  });

  it("NOT negates AND(children), including the wire parser's unary case", () => {
    const expression = filterOf({ "filter[not][status][eq]": "banned" });
    expect(evaluateFilter(expression, { status: "active" })).toBe(true);
    expect(evaluateFilter(expression, { status: "banned" })).toBe(false);
  });

  it("nests AND and OR together", () => {
    // status = 'active' AND (age >= 65 OR age < 18) — within the default
    // maxFilterDepth (3); NOT-nesting is covered on its own above.
    const expression = filterOf({
      "filter[status][eq]": "active",
      "filter[or][0][age][gte]": "65",
      "filter[or][1][age][lt]": "18",
    });
    expect(evaluateFilter(expression, { status: "active", age: 70 })).toBe(true);
    expect(evaluateFilter(expression, { status: "active", age: 10 })).toBe(true);
    expect(evaluateFilter(expression, { status: "active", age: 40 })).toBe(false);
    expect(evaluateFilter(expression, { status: "banned", age: 70 })).toBe(false);
  });
});
