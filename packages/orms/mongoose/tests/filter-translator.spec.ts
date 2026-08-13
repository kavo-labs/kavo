import { describe, expect, it } from "vitest";
import type { Filter, FilterExpression } from "@kavo/core";
import { QueryValidationException } from "@kavo/core";
import { likeToRegExpSource, translateFilter } from "@kavo/mongoose";

/** The tail anchor `likeToRegExpSource` emits — see its doc comment. */
const END = "(?![\\s\\S])";

const NO_RELATIONS = { relationNames: new Set<string>() };
const WITH_RELATIONS = { relationNames: new Set(["author"]) };

function translate(root: FilterExpression | null, options = NO_RELATIONS) {
  return translateFilter({ root } as Filter, options);
}

function condition(field: string, operator: string, value: unknown): FilterExpression {
  return { kind: "condition", field, operator, value } as FilterExpression;
}

describe("translateFilter — comparison operators", () => {
  it("maps every AST operator onto its MongoDB operator", () => {
    expect(translate(condition("name", "EQ", "Ada"))).toEqual({ name: { $eq: "Ada" } });
    expect(translate(condition("name", "NE", "Ada"))).toEqual({ name: { $ne: "Ada" } });
    expect(translate(condition("age", "GT", 30))).toEqual({ age: { $gt: 30 } });
    expect(translate(condition("age", "GTE", 30))).toEqual({ age: { $gte: 30 } });
    expect(translate(condition("age", "LT", 30))).toEqual({ age: { $lt: 30 } });
    expect(translate(condition("age", "LTE", 30))).toEqual({ age: { $lte: 30 } });
    expect(translate(condition("status", "IN", ["a", "b"]))).toEqual({ status: { $in: ["a", "b"] } });
    expect(translate(condition("status", "NOT_IN", ["a"]))).toEqual({ status: { $nin: ["a"] } });
    expect(translate(condition("age", "BETWEEN", [18, 65]))).toEqual({ age: { $gte: 18, $lte: 65 } });
    expect(translate(condition("bio", "IS_NULL", true))).toEqual({ bio: { $eq: null } });
    expect(translate(condition("bio", "IS_NOT_NULL", true))).toEqual({ bio: { $ne: null } });
  });

  it("matches everything when the filter has no root", () => {
    expect(translate(null)).toEqual({});
  });

  it("wraps equality in an explicit $eq so a value can never become an operator", () => {
    // The bare `{ field: value }` shorthand would splice an object value in
    // as query operators — the classic NoSQL injection shape, where
    // `{ $gt: "" }` silently turns "equals" into "matches everything".
    const injected = translate(condition("password", "EQ", { $gt: "" }));
    expect(injected).toEqual({ password: { $eq: { $gt: "" } } });
    expect(Object.keys(injected["password"] as object)).toEqual(["$eq"]);
  });
});

describe("translateFilter — logical groups", () => {
  it("maps AND, OR, and NOT onto $and, $or, and $nor", () => {
    const children = [condition("a", "EQ", 1), condition("b", "EQ", 2)];
    expect(translate({ kind: "group", operator: "AND", children } as FilterExpression)).toEqual({
      $and: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }],
    });
    expect(translate({ kind: "group", operator: "OR", children } as FilterExpression)).toEqual({
      $or: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }],
    });
    expect(translate({ kind: "group", operator: "NOT", children: [children[0]!] } as FilterExpression)).toEqual({
      $nor: [{ a: { $eq: 1 } }],
    });
  });

  it("nests groups to arbitrary depth", () => {
    const nested = {
      kind: "group",
      operator: "AND",
      children: [
        condition("a", "EQ", 1),
        { kind: "group", operator: "OR", children: [condition("b", "EQ", 2), condition("c", "EQ", 3)] },
      ],
    } as FilterExpression;
    expect(translate(nested)).toEqual({
      $and: [{ a: { $eq: 1 } }, { $or: [{ b: { $eq: 2 } }, { c: { $eq: 3 } }] }],
    });
  });

  it("conjoins a multi-child NOT before negating it, rather than $nor-ing the children", () => {
    // `NOT` means `NOT(AND(children))` (doc 05 §1, #115). `$nor: [a, b]`
    // would be `NOT(a OR b)` — a *narrower* set than asked for, and the
    // mirror of the widening the other two adapters had.
    const children = [condition("a", "EQ", 1), condition("b", "EQ", 2)];
    expect(translate({ kind: "group", operator: "NOT", children } as FilterExpression)).toEqual({
      $nor: [{ $and: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] }],
    });
  });

  it("spells the identity of an empty group rather than emitting one MongoDB rejects", () => {
    // MongoDB errors outright on `{ $and: [] }` / `{ $or: [] }`. The parser
    // enforces arity, so this only guards hand-built ASTs.
    expect(translate({ kind: "group", operator: "AND", children: [] } as FilterExpression)).toEqual({});
    expect(translate({ kind: "group", operator: "OR", children: [] } as FilterExpression)).toEqual({
      $nor: [{}],
    });
    expect(translate({ kind: "group", operator: "NOT", children: [] } as FilterExpression)).toEqual({
      $nor: [{}],
    });
  });
});

describe("translateFilter — LIKE and ILIKE", () => {
  it("translates SQL wildcards and anchors the pattern", () => {
    expect(likeToRegExpSource("%john%")).toBe(`^.*john.*${END}`);
    expect(likeToRegExpSource("A%")).toBe(`^A.*${END}`);
    expect(likeToRegExpSource("%son")).toBe(`^.*son${END}`);
    expect(likeToRegExpSource("john")).toBe(`^john${END}`);
    expect(likeToRegExpSource("j_hn")).toBe(`^j.hn${END}`);
  });

  it("regex-escapes the caller's pattern so only %/_ carry meaning", () => {
    // Every one of these is regex syntax; none of it may survive as syntax.
    expect(likeToRegExpSource(".*")).toBe(`^\\.\\*${END}`);
    expect(likeToRegExpSource("(a|b)")).toBe(`^\\(a\\|b\\)${END}`);
    expect(likeToRegExpSource("a+b?c")).toBe(`^a\\+b\\?c${END}`);
    expect(likeToRegExpSource("[x]{2}")).toBe(`^\\[x\\]\\{2\\}${END}`);
    expect(likeToRegExpSource("^$")).toBe(`^\\^\\$${END}`);
  });

  it("honours the documented backslash escape for a literal % or _", () => {
    // docs/internals/architecture/05-query-grammar.md: `\%` and `\_` are literals.
    expect(likeToRegExpSource("100\\%")).toBe(`^100%${END}`);
    expect(likeToRegExpSource("a\\_b")).toBe(`^a_b${END}`);
    expect(likeToRegExpSource("a\\\\b")).toBe(`^a\\\\b${END}`);
    expect(likeToRegExpSource("trailing\\")).toBe(`^trailing\\\\${END}`);
  });

  it("compiles to a regex that matches literally, not as an expression", () => {
    expect(new RegExp(likeToRegExpSource(".*")).test(".*")).toBe(true);
    expect(new RegExp(likeToRegExpSource(".*")).test("anything")).toBe(false);
    expect(new RegExp(likeToRegExpSource("%.*%")).test("has .* inside")).toBe(true);
    expect(new RegExp(likeToRegExpSource("A%")).test("Ada")).toBe(true);
    expect(new RegExp(likeToRegExpSource("A%")).test("bAda")).toBe(false);
  });

  it("does not match a value with a trailing newline (PCRE $ would)", () => {
    // MongoDB's PCRE engine treats a bare `$` as "end of subject, or just
    // before a final newline", so `like=john` used to also match "john\n".
    expect(new RegExp(likeToRegExpSource("john")).test("john\n")).toBe(false);
    expect(new RegExp(likeToRegExpSource("john")).test("john")).toBe(true);
  });

  it("emits $regex with the case-insensitive option only for ILIKE", () => {
    expect(translate(condition("name", "LIKE", "A%"))).toEqual({
      name: { $regex: `^A.*${END}`, $options: "s" },
    });
    expect(translate(condition("name", "ILIKE", "A%"))).toEqual({
      name: { $regex: `^A.*${END}`, $options: "is" },
    });
  });
});

describe("translateFilter — relation paths", () => {
  it("refuses a dotted path rooted at a relation instead of silently matching nothing", () => {
    let thrown: unknown;
    try {
      translate(condition("author.name", "EQ", "Ada"), WITH_RELATIONS);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(QueryValidationException);
    expect((thrown as QueryValidationException).code).toBe("KAVO_QUERY_INVALID");
    expect((thrown as QueryValidationException).issues[0]).toMatchObject({
      field: "author.name",
      code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    });
  });

  it("passes an embedded-document path straight through — MongoDB resolves it natively", () => {
    expect(translate(condition("address.city", "EQ", "Paris"), WITH_RELATIONS)).toEqual({
      "address.city": { $eq: "Paris" },
    });
  });

  it("leaves an undotted field named like a relation alone", () => {
    expect(translate(condition("author", "EQ", "abc"), WITH_RELATIONS)).toEqual({ author: { $eq: "abc" } });
  });
});

/**
 * `search[query]` (issue #156) is synthesized by `QueryNormalizer` into
 * ordinary `Filter`/`FilterGroup`/`ILIKE` AST nodes — no adapter-level code
 * changed to support it. `%term%` translates to the unanchored `$regex`
 * `likeToRegExpSource` already produces for an interior wildcard.
 */
describe("translateFilter — search[...] synthesis (issue #156)", () => {
  it("translates a substring-mode OR group across two searched fields to unanchored $regex", () => {
    expect(
      translate({
        kind: "group",
        operator: "OR",
        children: [condition("title", "ILIKE", "%dune%"), condition("blurb", "ILIKE", "%dune%")],
      } as FilterExpression),
    ).toEqual({
      $or: [
        { title: { $regex: `^.*dune.*${END}`, $options: "is" } },
        { blurb: { $regex: `^.*dune.*${END}`, $options: "is" } },
      ],
    });
  });

  it("translates a words-mode AND of per-word OR groups", () => {
    const wordGroup = (word: string): FilterExpression => ({
      kind: "group",
      operator: "OR",
      children: [condition("title", "ILIKE", `%${word}%`), condition("blurb", "ILIKE", `%${word}%`)],
    });
    expect(
      translate({
        kind: "group",
        operator: "AND",
        children: [wordGroup("blue"), wordGroup("book")],
      } as FilterExpression),
    ).toEqual({
      $and: [
        {
          $or: [
            { title: { $regex: `^.*blue.*${END}`, $options: "is" } },
            { blurb: { $regex: `^.*blue.*${END}`, $options: "is" } },
          ],
        },
        {
          $or: [
            { title: { $regex: `^.*book.*${END}`, $options: "is" } },
            { blurb: { $regex: `^.*book.*${END}`, $options: "is" } },
          ],
        },
      ],
    });
  });

  it("passes an embedded-document relation-path field through the same way an ordinary filter does", () => {
    expect(translate(condition("address.city", "ILIKE", "%paris%"), WITH_RELATIONS)).toEqual({
      "address.city": { $regex: `^.*paris.*${END}`, $options: "is" },
    });
  });

  it("narrows to a single search[fields] entry as a single condition, no OR wrapper", () => {
    expect(translate(condition("title", "ILIKE", "%dune%"))).toEqual({
      title: { $regex: `^.*dune.*${END}`, $options: "is" },
    });
  });
});
