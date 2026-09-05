import { afterEach, describe, expect, it } from "vitest";
import type { FilterCondition, FilterGroup } from "@kavo/core";
import { DefaultFilterParser, resolveEntityConfig } from "@kavo/core";
import { userMetadata } from "./support/user-fixture.js";
import { postMetadata } from "./support/blog-fixture.js";
import { issuesOf } from "./support/query-issues.js";

const config = resolveEntityConfig(userMetadata, undefined, undefined);
const parser = new DefaultFilterParser(userMetadata);

function parse(params: Record<string, unknown>) {
  return parser.parse(params, config);
}

/**
 * The operator table in `docs/internals/architecture/05-query-grammar.md` §1
 * is the single source of truth for the wire-token ⇄ AST-enum mapping, and
 * `OPERATOR_TOKENS` is proven *total* over `FilterOperator` at build time.
 * Totality is not reachability, though: a token can be spelled wrong and
 * still typecheck, so every row is exercised here through `parse()` — one
 * case per row, in the doc's order.
 */
describe("DefaultFilterParser — the operator table", () => {
  it.each([
    ["eq", "status", "active", "EQ", "active"],
    ["ne", "status", "banned", "NE", "banned"],
    ["gt", "age", "18", "GT", 18],
    ["gte", "age", "18", "GTE", 18],
    ["lt", "age", "65", "LT", 65],
    ["lte", "age", "65", "LTE", 65],
    ["in", "status", "active,pending", "IN", ["active", "pending"]],
    ["notIn", "status", "banned,pending", "NOT_IN", ["banned", "pending"]],
    ["like", "name", "%john%", "LIKE", "%john%"],
    ["ilike", "name", "%john%", "ILIKE", "%john%"],
    ["between", "age", "18,65", "BETWEEN", [18, 65]],
    ["isNull", "name", "true", "IS_NULL", true],
    ["isNotNull", "name", "true", "IS_NOT_NULL", true],
  ])("maps the wire token '%s' onto its AST operator", (token, field, raw, operator, value) => {
    expect(parse({ [`filter[${field}][${token}]`]: raw }).root).toEqual({
      kind: "condition",
      field,
      operator,
      value,
    });
  });
});

/**
 * `isNull` / `isNotNull` are boolean-valued, and `false` flips to the
 * complementary operator rather than dropping the condition — so both
 * spellings mean what they read as (doc 05 §3). All four combinations, since
 * only asserting the `isNull` half would let the `isNotNull` flip regress.
 */
describe("DefaultFilterParser — isNull / isNotNull symmetry", () => {
  it.each([
    ["isNull", "true", "IS_NULL"],
    ["isNull", "false", "IS_NOT_NULL"],
    ["isNotNull", "true", "IS_NOT_NULL"],
    ["isNotNull", "false", "IS_NULL"],
  ])("reads %s=%s as %s", (token, flag, operator) => {
    expect(parse({ [`filter[name][${token}]`]: flag }).root).toEqual({
      kind: "condition",
      field: "name",
      operator,
      value: true,
    });
  });

  it("rejects a non-boolean value on either spelling", () => {
    for (const token of ["isNull", "isNotNull"]) {
      const issues = issuesOf(() => parse({ [`filter[name][${token}]`]: "yes" }));
      expect(issues[0]).toMatchObject({ field: "name", code: "KAVO_QUERY_INVALID_VALUE" });
    }
  });
});

describe("DefaultFilterParser — bracket grammar", () => {
  // The single-comparison case is the `gte` row of the operator table above;
  // repeating it here would mean two tests to update for one contract.

  it("ANDs multiple filter params implicitly", () => {
    const filter = parse({
      "filter[age][gte]": "18",
      "filter[status][eq]": "active",
    });
    const root = filter.root as FilterGroup;
    expect(root.operator).toBe("AND");
    expect(root.children).toHaveLength(2);
  });

  it("parses the spec's reference example (or-group, in, like)", () => {
    const filter = parse({
      "filter[age][gte]": "18",
      "filter[status][in]": "active,pending",
      "filter[name][like]": "%john%",
      "filter[or][0][name][eq]": "admin",
      "filter[or][1][status][eq]": "banned",
    });
    const root = filter.root as FilterGroup;
    expect(root.operator).toBe("AND");
    const or = root.children.find((child): child is FilterGroup => child.kind === "group" && child.operator === "OR");
    expect(or?.children).toHaveLength(2);
    const inCondition = root.children.find(
      (child): child is FilterCondition => child.kind === "condition" && child.operator === "IN",
    );
    expect(inCondition?.value).toEqual(["active", "pending"]);
  });

  it("builds NOT groups with a single child", () => {
    const filter = parse({ "filter[not][status][eq]": "banned" });
    const root = filter.root as FilterGroup;
    expect(root.operator).toBe("NOT");
    expect(root.children).toHaveLength(1);
  });

  it("coerces a raw wire value against the column's metadata", () => {
    const date = parse({ "filter[createdAt][gte]": "2026-01-01" }).root as FilterCondition;
    expect(date.value).toBeInstanceOf(Date);
  });

  it("builds an explicit top-level AND group, bracket and JSON alike", () => {
    // Implicit AND (two `filter[...]` params) and `or`/`not` are covered
    // above; the explicit `and` token is its own branch of `convertLogical`
    // and would otherwise never be exercised.
    const bracket = parse({
      "filter[and][0][name][eq]": "admin",
      "filter[and][1][age][gte]": "18",
    });
    const root = bracket.root as FilterGroup;
    expect(root.operator).toBe("AND");
    expect(root.children).toEqual([
      { kind: "condition", field: "name", operator: "EQ", value: "admin" },
      { kind: "condition", field: "age", operator: "GTE", value: 18 },
    ]);

    const json = parse({
      filter: JSON.stringify({ and: [{ name: { eq: "admin" } }, { age: { gte: 18 } }] }),
    });
    expect(json).toEqual(bracket);
  });
});

describe("DefaultFilterParser — BETWEEN bounds", () => {
  it("parses exactly two bounds and rejects any other arity", () => {
    const filter = parse({ "filter[age][between]": "18,65" }).root as FilterCondition;
    expect(filter.value).toEqual([18, 65]);
    for (const raw of ["1,2,3", "18"]) {
      const issues = issuesOf(() => parse({ "filter[age][between]": raw }));
      expect(issues[0]?.code).toBe("KAVO_QUERY_INVALID_VALUE");
    }
  });

  it("coerces date bounds through the same column metadata", () => {
    const filter = parse({
      "filter[createdAt][between]": "2026-01-01,2026-06-01",
    }).root as FilterCondition;
    const [low, high] = filter.value as [Date, Date];
    expect(low.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(high.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("rejects a bound that fails coercion, on either side", () => {
    for (const raw of ["abc,65", "18,abc"]) {
      const issues = issuesOf(() => parse({ "filter[age][between]": raw }));
      expect(issues[0]).toMatchObject({ field: "age", code: "KAVO_QUERY_INVALID_VALUE" });
    }
    const dates = issuesOf(() => parse({ "filter[createdAt][between]": "2026-01-01,not-a-date" }));
    expect(dates[0]).toMatchObject({ field: "createdAt", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("keeps out-of-order bounds in wire order rather than swapping them", () => {
    // The grammar promises two bounds, not a sorted pair. Silently swapping
    // would make `between=65,18` — a range that matches nothing in SQL —
    // quietly return rows the caller never asked for.
    const filter = parse({ "filter[age][between]": "65,18" }).root as FilterCondition;
    expect(filter.value).toEqual([65, 18]);
  });
});

/**
 * `like`/`ilike` are pure passthrough at this layer: no auto-wrapped
 * wildcards, and the documented backslash escape for a literal `%`/`_`
 * survives verbatim so the adapter can emit the matching `ESCAPE` clause
 * (doc 05 §3). Each translator tests what it *does* with the pattern; this
 * pins down that it receives the caller's pattern unaltered.
 */
describe("DefaultFilterParser — LIKE / ILIKE passthrough", () => {
  it.each(["like", "ilike"])("never wraps a '%s' pattern in wildcards", (token) => {
    const filter = parse({ [`filter[name][${token}]`]: "john" }).root as FilterCondition;
    expect(filter.value).toBe("john");
  });

  it.each(["like", "ilike"])("passes the backslash escape for a literal %% or _ through '%s'", (token) => {
    // The wire value is `100\%` / `a\_b`: a backslash the parser must not
    // consume, unescape, or double.
    expect((parse({ [`filter[name][${token}]`]: "100\\%" }).root as FilterCondition).value).toBe("100\\%");
    expect((parse({ [`filter[name][${token}]`]: "a\\_b" }).root as FilterCondition).value).toBe("a\\_b");
    expect((parse({ [`filter[name][${token}]`]: "a\\\\b" }).root as FilterCondition).value).toBe("a\\\\b");
  });
});

describe("DefaultFilterParser — IN / NOT_IN value lists", () => {
  it("accepts both wire spellings for either operator", () => {
    for (const [token, operator] of [
      ["in", "IN"],
      ["notIn", "NOT_IN"],
    ] as const) {
      expect(parse({ [`filter[status][${token}]`]: "active,pending" }).root).toMatchObject({
        operator,
        value: ["active", "pending"],
      });
      expect(parse({ [`filter[status][${token}][]`]: ["active", "pending"] }).root).toMatchObject({
        operator,
        value: ["active", "pending"],
      });
    }
  });

  it("carries an empty value list through as an empty array", () => {
    // No wire spelling produces one — `in=` splits to `[""]` and `in[]=` to
    // `[""]` too — so this shape reaches the parser only from a
    // programmatic caller. It still has to survive: adapters spell the empty
    // set as a contradiction/tautology rather than emitting `IN ()`, so the
    // AST must be able to say "no values" at all.
    for (const [token, operator] of [
      ["in", "IN"],
      ["notIn", "NOT_IN"],
    ] as const) {
      expect(parse({ [`filter[status][${token}][]`]: [] }).root).toEqual({
        kind: "condition",
        field: "status",
        operator,
        value: [],
      });
    }
  });

  it("rejects a bare empty value on a typed column", () => {
    const issues = issuesOf(() => parse({ "filter[age][in]": "" }));
    expect(issues[0]).toMatchObject({ field: "age", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("rejects a bare empty value on a string column too, not just a typed one", () => {
    // The decision recorded in doc 05 §3 (#113). Left to coercion the two
    // column kinds disagreed: string coercion accepts "", so
    // `filter[name][in]=` used to build a live `IN ('')` — a search for the
    // empty string — while `filter[age][in]=` was a 400. A cleared
    // multi-select must not silently become "rows whose value is ''".
    for (const [key, field] of [
      ["filter[name][in]", "name"],
      ["filter[name][notIn]", "name"],
    ] as const) {
      const issues = issuesOf(() => parse({ [key]: "" }));
      expect(issues[0]).toMatchObject({ field, code: "KAVO_QUERY_INVALID_VALUE" });
    }
  });

  it("rejects the bare empty value in the repeated-key spelling as well", () => {
    // `filter[name][in][]=` arrives as `[""]`, the same absent operand in a
    // different spelling — one answer for both.
    const issues = issuesOf(() => parse({ "filter[name][in][]": [""] }));
    expect(issues[0]).toMatchObject({ field: "name", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("still admits an interior empty element, which is a different question", () => {
    // `in=a,,b` is a malformed list rather than an absent one; #113 scoped
    // itself to the bare spelling, so this keeps its per-element coercion
    // behavior rather than being swept up by the new check.
    expect(parse({ "filter[name][in]": "a,,b" }).root).toEqual({
      kind: "condition",
      field: "name",
      operator: "IN",
      value: ["a", "", "b"],
    });
  });
});

describe("DefaultFilterParser — malformed bracket keys", () => {
  it("treats a key that is not a well-formed filter path as no filter at all", () => {
    // `parseBracketKey` returns null for each of these, so nothing is
    // collected — the request carries no filter rather than a half-parsed
    // one. Unit-tested on the key parser; asserted here through `parse()`,
    // where the consequence (a `null` root, not a thrown error) lives.
    for (const key of ["filter[age", "filter[age][gte]x", "filter[a]]", "filter[a]b[c]"]) {
      expect(parse({ [key]: "18" })).toEqual({ root: null });
    }
  });

  it("still parses the well-formed params alongside a malformed one", () => {
    const filter = parse({ "filter[age": "1", "filter[age][gte]": "18" });
    expect(filter.root).toEqual({ kind: "condition", field: "age", operator: "GTE", value: 18 });
  });

  // Both spellings below fail the *shape* check in `convertConditions` — the
  // value is not an operator map — rather than the unknown-token branch in
  // `buildCondition` (covered separately under "security posture"). They
  // share `KAVO_QUERY_INVALID_OPERATOR`, so the `detail` is what tells the
  // two branches apart and is asserted here for that reason.
  it.each([
    ["an empty operator segment", "filter[age][]", ["18"]],
    ["no operator segment at all", "filter[age]", "18"],
  ])("rejects %s as not an operator map", (_label, key, value) => {
    const issues = issuesOf(() => parse({ [key]: value }));
    expect(issues[0]).toMatchObject({ field: "age", code: "KAVO_QUERY_INVALID_OPERATOR" });
    expect(issues[0]?.detail).toContain("filter[age][operator]=value");
  });

  /**
   * Regression: `filter[__proto__][x]=v` used to walk into `Object.prototype`
   * and assign there, because on an ordinary `{}` the key `__proto__` reads
   * back as the prototype rather than `undefined`. One anonymous GET then
   * handed every later request in the process a soft-delete flag, a filter,
   * a pagination limit, or an extra writable body field — the parser's tree
   * is built before any allowlist check, so the segment never had to be
   * filterable to get there.
   */
  describe("reserved prototype keys", () => {
    const reserved = ["__proto__", "constructor", "prototype"];

    afterEach(() => {
      // A leak here would silently arm every later test in the run, so the
      // guard is unconditional rather than part of one assertion.
      for (const key of ["withDeleted", "limit", "polluted"]) {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    });

    it.each(reserved)("does not write through a '%s' segment", (segment) => {
      issuesOf(() => parse({ [`filter[${segment}][withDeleted]`]: "true" }));
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, "withDeleted")).toBe(false);
      expect(({} as Record<string, unknown>)["withDeleted"]).toBeUndefined();
    });

    it.each(reserved)("rejects a '%s' segment as a non-allowlisted field", (segment) => {
      // Fail closed and loudly: it is an unknown field like any other, not a
      // silently dropped key.
      const issues = issuesOf(() => parse({ [`filter[${segment}][eq]`]: "x" }));
      expect(issues[0]).toMatchObject({ field: segment, code: "KAVO_QUERY_INVALID_FIELD" });
    });

    it("does not write through the JSON escape hatch either", () => {
      // Written as a literal, not via `JSON.stringify({ __proto__: … })` —
      // in an object literal that key *sets* the prototype, so stringify
      // would emit `{}` and the test would pass vacuously. `JSON.parse` is
      // the safe direction (it defines an own property), and the own key
      // then meets the allowlist like any other unknown field.
      const issues = issuesOf(() => parse({ filter: String.raw`{"__proto__":{"polluted":{"eq":"x"}}}` }));
      expect(issues[0]).toMatchObject({ field: "__proto__", code: "KAVO_QUERY_INVALID_FIELD" });
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });

    it("keeps a legitimately nested path working", () => {
      // The guard must not cost the ordinary nested case anything.
      const root = parse({
        "filter[or][0][name][eq]": "admin",
        "filter[or][1][age][gte]": "18",
      }).root as FilterGroup;
      expect(root.operator).toBe("OR");
      expect(root.children).toHaveLength(2);
    });
  });

  it("reports a malformed logical group under its bracketed wire key", () => {
    // The one issue shape whose `field` is a bracketed key rather than a
    // bare column name — worth pinning, since a client parses these.
    const notAGroup = issuesOf(() => parse({ "filter[or]": "banned" }));
    expect(notAGroup[0]).toMatchObject({ field: "filter[or]", code: "KAVO_QUERY_INVALID_VALUE" });

    const badBranch = issuesOf(() => parse({ filter: JSON.stringify({ or: ["x"] }) }));
    expect(badBranch[0]).toMatchObject({ field: "filter[or]", code: "KAVO_QUERY_INVALID_VALUE" });
    expect(badBranch[0]?.detail).toContain("branch");
  });
});

/**
 * Relation-path filtering (`filter[author.name][eq]=Ada`) is allowlist-gated
 * like everything else, and its value is *not* coerced: coercion consults
 * the root entity's column metadata only, where a dotted path has no entry
 * (doc 05 §5). Both halves are asserted through the real `parse()` path —
 * `coerceScalar`/`parseBracketKey` are unit-tested in isolation elsewhere,
 * which cannot show that the parser wires them together this way.
 */
describe("DefaultFilterParser — relation paths", () => {
  const relationConfig = resolveEntityConfig(
    postMetadata,
    { filter: { fields: ["title", "author.name"] } },
    undefined,
  );
  const relationParser = new DefaultFilterParser(postMetadata);
  const parseRelation = (params: Record<string, unknown>) => relationParser.parse(params, relationConfig);

  it("keeps the dotted path as one field and leaves the value a string", () => {
    expect(parseRelation({ "filter[author.name][eq]": "Ada" }).root).toEqual({
      kind: "condition",
      field: "author.name",
      operator: "EQ",
      value: "Ada",
    });
  });

  it("passes a numeric-looking relation value through uncoerced", () => {
    // `Post.id` is a number column, but `author.id` is not in this entity's
    // column map — so the string reaches the adapter and the database
    // compares it.
    const relaxed = resolveEntityConfig(postMetadata, { filter: { fields: ["author.id"] } }, undefined);
    expect(relationParser.parse({ "filter[author.id][eq]": "7" }, relaxed).root).toMatchObject({ value: "7" });
  });

  it("rejects a relation path nobody allowlisted, exactly like a scalar column", () => {
    // Allowed default to the entity's own scalar columns, so a relation
    // path is never filterable implicitly.
    const issues = issuesOf(() => parseRelation({ "filter[comments.body][eq]": "x" }));
    expect(issues[0]).toMatchObject({ field: "comments.body", code: "KAVO_QUERY_INVALID_FIELD" });
  });

  it("carries a relation path into a logical group unchanged", () => {
    const root = parseRelation({
      "filter[or][0][author.name][eq]": "Ada",
      "filter[or][1][title][eq]": "First",
    }).root as FilterGroup;
    expect(root.operator).toBe("OR");
    expect(root.children[0]).toMatchObject({ field: "author.name", value: "Ada" });
  });
});

describe("DefaultFilterParser — JSON escape hatch", () => {
  it("produces the identical AST as bracket notation", () => {
    const bracket = parse({
      "filter[or][0][name][eq]": "admin",
      "filter[or][1][status][eq]": "banned",
    });
    const json = parse({
      filter: JSON.stringify({
        or: [{ name: { eq: "admin" } }, { status: { eq: "banned" } }],
      }),
    });
    expect(json).toEqual(bracket);
  });

  it("rejects malformed JSON explicitly", () => {
    const issues = issuesOf(() => parse({ filter: "{nope" }));
    expect(issues[0]?.code).toBe("KAVO_QUERY_INVALID_VALUE");
  });

  it("ANDs the two forms together when a request carries both", () => {
    // Doc 05 §3 promises this explicitly, and it is the only place the two
    // parse paths meet — `collectBracketTree` and `parseJsonFilter` each
    // contribute a root, which `parse` folds into one AND.
    const filter = parse({
      "filter[age][gte]": "18",
      filter: JSON.stringify({ status: { eq: "active" } }),
    });
    expect(filter.root).toEqual({
      kind: "group",
      operator: "AND",
      children: [
        { kind: "condition", field: "age", operator: "GTE", value: 18 },
        { kind: "condition", field: "status", operator: "EQ", value: "active" },
      ],
    });
  });
});

describe("DefaultFilterParser — security posture", () => {
  it("rejects non-allowlisted fields with a 400, never silently drops", () => {
    const issues = issuesOf(() => parse({ "filter[password][eq]": "x" }));
    expect(issues[0]).toMatchObject({
      field: "password",
      code: "KAVO_QUERY_INVALID_FIELD",
    });
  });

  it("rejects unknown operators (exact-case, no aliases)", () => {
    const issues = issuesOf(() => parse({ "filter[age][GTE]": "18" }));
    expect(issues[0]?.code).toBe("KAVO_QUERY_INVALID_OPERATOR");
  });

  it("rejects coercion failures as field-level issues", () => {
    const issues = issuesOf(() => parse({ "filter[age][eq]": "abc" }));
    expect(issues[0]?.code).toBe("KAVO_QUERY_INVALID_VALUE");
    expect(issues[0]?.detail).toContain("abc");
  });

  it("rejects enum values outside the member list", () => {
    const issues = issuesOf(() => parse({ "filter[status][eq]": "vip" }));
    expect(issues[0]?.code).toBe("KAVO_QUERY_INVALID_VALUE");
  });

  it("enforces limits.inValues", () => {
    const many = Array.from({ length: 101 }, (_, i) => String(i)).join(",");
    const issues = issuesOf(() => parse({ "filter[age][in]": many }));
    expect(issues[0]?.code).toBe("KAVO_QUERY_LIMIT_EXCEEDED");
  });

  it("enforces limits.filterDepth", () => {
    const issues = issuesOf(() =>
      parse({
        filter: JSON.stringify({
          or: [{ and: [{ or: [{ not: { name: { eq: "x" } } }] }] }],
        }),
      }),
    );
    expect(issues.some((i) => i.code === "KAVO_QUERY_LIMIT_EXCEEDED")).toBe(true);
  });

  it("enforces limits.filterDepth before recursing deep enough to blow the stack (issue #367 finding 3)", () => {
    // `JSON.parse` builds nesting far past anything the bracket grammar's
    // own key-splitting could reach, and (unlike the bracket form) does it
    // in one call, not one recursive `convertNode` per level — so this is
    // the shape that used to reach `expressionDepth`'s second unbounded
    // recursion before the depth check ever fired. 50,000 levels comfortably
    // exceeds any JS call-stack budget if `convertNode`/`convertLogical`
    // recursed that deep; the fix aborts at `limits.filterDepth` on the way
    // down instead.
    // Built as a string, not a nested object: constructing (or
    // `JSON.stringify`-ing) a 50,000-deep object graph with ordinary
    // recursive helpers would itself blow the stack before the parser ever
    // saw the input — exactly what this test must not depend on.
    const depth = 50_000;
    const raw = '{"and":['.repeat(depth) + '{"name":{"eq":"x"}}' + "]}".repeat(depth);
    const issues = issuesOf(() => parse({ filter: raw }));
    expect(issues.some((i) => i.code === "KAVO_QUERY_LIMIT_EXCEEDED")).toBe(true);
  });

  it("collects every issue into one exception", () => {
    const issues = issuesOf(() =>
      parse({
        "filter[password][eq]": "x",
        "filter[age][eq]": "abc",
      }),
    );
    expect(issues).toHaveLength(2);
  });

  it.each(["like", "ilike"])("restricts '%s' to string columns", (token) => {
    const issues = issuesOf(() => parse({ [`filter[age][${token}]`]: "%1%" }));
    expect(issues[0]).toMatchObject({ field: "age", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it.each(["like", "ilike"])("enforces limits.likePattern on '%s' (issue #367 finding 4)", (token) => {
    const pattern = `%${"a".repeat(201)}%`;
    const issues = issuesOf(() => parse({ [`filter[name][${token}]`]: pattern }));
    expect(issues[0]).toMatchObject({ field: "name", code: "KAVO_QUERY_LIMIT_EXCEEDED" });
  });

  it.each(["like", "ilike"])("accepts a '%s' pattern at exactly limits.likePattern", (token) => {
    const pattern = "a".repeat(200);
    const result = parse({ [`filter[name][${token}]`]: pattern });
    expect(result.root).toMatchObject({ value: pattern });
  });
});

describe("DefaultFilterParser — JSON that parses but is not a filter", () => {
  // The escape hatch already rejects text that is not JSON at all. These
  // are the inputs that survive `JSON.parse` and would otherwise be walked
  // as if they were an object.
  it.each([
    ["an array", "[1,2]"],
    ["a bare number", "5"],
    ["a bare string", '"age"'],
    ["null", "null"],
  ])("rejects %s with a query issue rather than a TypeError", (_label, raw) => {
    const issues = issuesOf(() => parse({ filter: raw }));
    expect(issues[0]).toMatchObject({ field: "filter", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("reads a scalar multi-value operand as a one-element list", () => {
    // Only reachable through the JSON hatch, where values keep their JSON
    // types instead of arriving as comma-joined text.
    const query = parse({ filter: JSON.stringify({ age: { in: 18 } }) });
    expect(query.root).toMatchObject({ operator: "IN", value: [18] });
  });
});

describe("DefaultFilterParser — an IN list is all-or-nothing", () => {
  it("emits no condition at all when one member fails coercion", () => {
    // The alternative would be a silently narrowed list: `age IN (1, 3)`
    // for a client that asked for three values, which reads as a
    // successful query returning wrong rows.
    const issues = issuesOf(() => parse({ "filter[age][in]": "1,abc,3" }));
    expect(issues[0]).toMatchObject({ field: "age", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("accepts the repeated-key spelling when a framework hands over a bare scalar", () => {
    // `?filter[status][in][]=active` is an array of one to some parsers and
    // a plain string to others; both must mean the same thing.
    const query = parse({ "filter[status][in][]": "active" });
    expect(query.root).toMatchObject({ operator: "IN", value: ["active"] });
  });

  it("still accepts the array spelling of the same key", () => {
    const query = parse({ "filter[status][in][]": ["active", "pending"] });
    expect(query.root).toMatchObject({ operator: "IN", value: ["active", "pending"] });
  });
});

describe("DefaultFilterParser — a bare filter[] key contributes nothing", () => {
  it("yields an empty filter rather than throwing on the empty path", () => {
    // An attacker-shaped key on an untrusted-key code path: the contract
    // worth pinning is that it neither crashes nor smuggles a condition in.
    expect(parse({ "filter[]": "18" }).root).toBeNull();
  });
});
