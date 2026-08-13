import { describe, expect, it } from "vitest";
import { QueryValidationException, type Filter, type FilterExpression } from "@kavo/core";
import { translateFilter, type FilterTranslatorOptions, type PrismaRelationGraph } from "@kavo/prisma";

/**
 * A synthetic relation graph, so the translator is exercised on its own
 * terms rather than against whatever `prisma/schema.prisma` happens to
 * declare: `Book.author` is to-one, `Author.books` is to-many, and
 * `Author.city` gives a second to-one hop for the multi-segment cases.
 * `adapter.spec.ts` covers the same shapes against a real Prisma engine.
 */
const relations: PrismaRelationGraph = new Map([
  ["Book", new Map([["author", { cardinality: "one", target: "Author" } as const]])],
  [
    "Author",
    new Map([
      ["books", { cardinality: "many", target: "Book" } as const],
      ["city", { cardinality: "one", target: "City" } as const],
    ]),
  ],
  ["City", new Map()],
]);

/** The connector setting only reaches `ILIKE`; everything else is invariant. */
const options: FilterTranslatorOptions = { caseInsensitiveFilters: false, model: "Book", relations };
const insensitive: FilterTranslatorOptions = { ...options, caseInsensitiveFilters: true };
/** Rooted at the other side of the to-one/to-many pair. */
const fromAuthor: FilterTranslatorOptions = { ...options, model: "Author" };

function condition(field: string, operator: string, value: unknown): FilterExpression {
  return { kind: "condition", field, operator, value } as FilterExpression;
}

function group(operator: "AND" | "OR" | "NOT", children: FilterExpression[]): FilterExpression {
  return { kind: "group", operator, children } as FilterExpression;
}

function translate(root: FilterExpression | null, opts = options): unknown {
  return translateFilter({ root } as Filter, opts);
}

describe("translateFilter — shape", () => {
  it("returns undefined for an empty filter, so no `where` is sent at all", () => {
    expect(translate(null)).toBeUndefined();
  });
});

describe("translateFilter — operators", () => {
  it.each([
    ["EQ", "Ada", { name: { equals: "Ada" } }],
    ["NE", "Ada", { name: { not: "Ada" } }],
    ["GT", 30, { name: { gt: 30 } }],
    ["GTE", 30, { name: { gte: 30 } }],
    ["LT", 30, { name: { lt: 30 } }],
    ["LTE", 30, { name: { lte: 30 } }],
    ["IN", ["a", "b"], { name: { in: ["a", "b"] } }],
    ["NOT_IN", ["a", "b"], { name: { notIn: ["a", "b"] } }],
    ["BETWEEN", [1, 9], { name: { gte: 1, lte: 9 } }],
    ["IS_NULL", true, { name: { equals: null } }],
    ["IS_NOT_NULL", true, { name: { not: null } }],
  ])("maps %s onto its Prisma filter", (operator, value, expected) => {
    expect(translate(condition("name", operator, value))).toEqual(expected);
  });

  it("throws rather than dropping an operator outside the AST enum", () => {
    // Prisma ignores unknown keys in a `where`, so a dropped predicate would
    // silently widen the result set instead of erroring.
    expect(() => translate(condition("name", "SOUNDS_LIKE", "x"))).toThrowError(/filter operator/);
  });
});

/**
 * Prisma has no raw pattern operator — only
 * `contains`/`startsWith`/`endsWith`/`equals` — so a leading and/or trailing
 * `%` picks which one is emitted. Collapsing everything to `contains` would
 * turn `A%` ("starts with A") into "has an A somewhere", which is a wider
 * result set than the caller asked for.
 */
describe("translateFilter — LIKE wildcard positions", () => {
  it.each([
    ["%john%", { contains: "john" }],
    ["A%", { startsWith: "A" }],
    ["%son", { endsWith: "son" }],
    ["john", { equals: "john" }],
    // `%` on its own is "any non-null value", the same set SQL `LIKE '%'` has.
    ["%", { contains: "" }],
    // Repeated wildcards are the same pattern spelled differently.
    ["A%%", { startsWith: "A" }],
    // An empty pattern is `LIKE ''` — only the empty string, not everything.
    ["", { equals: "" }],
  ])("reads the pattern %s by where its wildcards sit", (pattern, expected) => {
    expect(translate(condition("name", "LIKE", pattern))).toEqual({ name: expected });
  });
});

/**
 * The backslash escape is a **grammar-level** contract (doc 05 §3), not an
 * adapter's option: `@kavo/typeorm` binds a real `ESCAPE` clause and
 * `@kavo/mongoose`'s `likeToRegExpSource("100\\%")` returns `^100%`. Prisma
 * used to leave the backslash in the operand and read only the two ends of
 * the pattern, so `100\%` became `{ startsWith: "100\\" }` — the same wire
 * request returning a different result set here than on the other three
 * adapters, with no error on either side (#114).
 */
describe("translateFilter — the LIKE backslash escape", () => {
  it.each([
    ["100\\%", { equals: "100%" }],
    ["a\\_b", { equals: "a_b" }],
    // Escaped wildcards are literal *text*, so a real leading `%` still
    // decides the filter around them.
    ["%50\\%", { endsWith: "50%" }],
    // A trailing lone backslash escapes nothing and stays literal, matching
    // `@kavo/mongoose`.
    ["a\\", { equals: "a\\" }],
  ])("reads %s as literal text rather than as a wildcard", (pattern, expected) => {
    expect(translate(condition("name", "LIKE", pattern))).toEqual({ name: expected });
  });
});

/**
 * Prisma's four string filters cannot express an interior `%` or the
 * single-character wildcard `_` at all. Those used to fall through to
 * `equals` on the raw pattern — a silently wrong result set. A 400 is the
 * documented answer (doc 14, "Adapter-specific caveats"): the limitation is
 * visible to the caller instead of being absorbed.
 */
describe("translateFilter — patterns Prisma cannot express", () => {
  it.each([
    ["a%b", "an interior wildcard"],
    ["%a%b%", "two interior literals"],
    ["a_c", "the single-character wildcard"],
    ["%j_hn%", "a single-character wildcard inside a contains"],
    ["_", "a bare single-character wildcard"],
  ])("rejects %s (%s) rather than downgrading it to equals", (pattern) => {
    expect(() => translate(condition("name", "LIKE", pattern))).toThrowError(QueryValidationException);
  });

  it("reports the rejection as a field-level 400 naming the field", () => {
    try {
      translate(condition("name", "LIKE", "a%b"));
      expect.unreachable("an inexpressible pattern must raise");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryValidationException);
      expect((error as QueryValidationException).issues[0]).toMatchObject({
        field: "name",
        code: "KAVO_QUERY_UNSUPPORTED_PARAM",
      });
    }
  });

  it("rejects the same patterns under ILIKE, not just LIKE", () => {
    expect(() => translate(condition("name", "ILIKE", "a_c"), insensitive)).toThrowError(QueryValidationException);
  });
});

describe("translateFilter — caseInsensitiveFilters", () => {
  it("adds Prisma's mode: 'insensitive' for ILIKE when the connector supports it (default)", () => {
    expect(translate(condition("name", "ILIKE", "a%"), insensitive)).toEqual({
      name: { startsWith: "a", mode: "insensitive" },
    });
  });

  it("omits mode entirely when the connector doesn't support it (e.g. SQLite)", () => {
    expect(translate(condition("name", "ILIKE", "a%"), options)).toEqual({ name: { startsWith: "a" } });
  });

  it("leaves plain LIKE untouched by the setting either way", () => {
    for (const opts of [insensitive, options]) {
      expect(translate(condition("name", "LIKE", "a%"), opts)).toEqual({ name: { startsWith: "a" } });
    }
  });

  it("carries the mode onto every ILIKE wildcard position, not just the prefix one", () => {
    expect(translate(condition("name", "ILIKE", "%a%"), insensitive)).toEqual({
      name: { contains: "a", mode: "insensitive" },
    });
    expect(translate(condition("name", "ILIKE", "a"), insensitive)).toEqual({
      name: { equals: "a", mode: "insensitive" },
    });
  });
});

describe("translateFilter — logical groups", () => {
  const left = condition("name", "EQ", "Ada");
  const right = condition("age", "GT", 30);

  it("maps AND and OR onto Prisma's own combinators", () => {
    expect(translate(group("AND", [left, right]))).toEqual({
      AND: [{ name: { equals: "Ada" } }, { age: { gt: 30 } }],
    });
    expect(translate(group("OR", [left, right]))).toEqual({
      OR: [{ name: { equals: "Ada" } }, { age: { gt: 30 } }],
    });
  });

  it("maps a NOT group onto NOT over its single child", () => {
    expect(translate(group("NOT", [left]))).toEqual({ NOT: { name: { equals: "Ada" } } });
  });

  it("conjoins a multi-child NOT rather than dropping every child past the first", () => {
    // `NOT` means `NOT(AND(children))` (doc 05 §1, #115). Reading
    // `children[0]` and discarding the rest returned rows the caller asked
    // to exclude.
    expect(translate(group("NOT", [left, right]))).toEqual({
      NOT: { AND: [{ name: { equals: "Ada" } }, { age: { gt: 30 } }] },
    });
  });

  it("nests groups without losing precedence", () => {
    const nested = group("AND", [left, group("OR", [right, condition("age", "LT", 10)])]);
    expect(translate(nested)).toEqual({
      AND: [{ name: { equals: "Ada" } }, { OR: [{ age: { gt: 30 } }, { age: { lt: 10 } }] }],
    });
  });

  /**
   * The degenerate zero-child groups, unreachable from the wire but
   * buildable by a programmatic caller. All four adapters agree on the
   * answers, stated once in doc 05 §3: `AND []` matches every row, `OR []`
   * none, and `NOT []` — being `NOT(AND [])` — none either. `adapter.spec.ts`
   * confirms these against a real Prisma engine, which is what #111 asked
   * for; this pins the shape they are spelled as.
   */
  it("spells the degenerate empty groups from the identity of each connective", () => {
    expect(translate(group("AND", []))).toEqual({ AND: [] });
    expect(translate(group("OR", []))).toEqual({ OR: [] });
    // Not `{ NOT: { AND: [] } }`: Prisma drops a `NOT` whose operand carries
    // no condition, so that spelling matches every row. The empty
    // disjunction is the contradiction it does honor.
    expect(translate(group("NOT", []))).toEqual({ OR: [] });
  });
});

/**
 * Prisma's `where` nests relation paths natively, so unlike `@kavo/typeorm`
 * this translator adds no join — a dotted field simply nests the same leaf
 * one level deeper. **Cardinality decides the shape**: Prisma accepts a bare
 * nested object only on a to-one relation and requires `some`/`every`/`none`
 * on a list, rejecting the bare form with `Unknown argument` — which is why
 * a to-many path used to be a 500 rather than filtered rows (#116).
 */
describe("translateFilter — relation-path cardinality", () => {
  it("wraps a to-many path in `some`, per the restrict-root-rows semantics", () => {
    // doc 05 §3: a relation-path filter restricts *root* rows — "an author
    // with at least one book titled Dune" — which is exactly `some`, and
    // exactly what `@kavo/typeorm` gets from a LEFT JOIN plus a WHERE.
    expect(translate(condition("books.title", "EQ", "Dune"), fromAuthor)).toEqual({
      books: { some: { title: { equals: "Dune" } } },
    });
  });

  it("leaves a to-one path bare, the shape Prisma wants there", () => {
    expect(translate(condition("author.name", "EQ", "Ada"))).toEqual({
      author: { name: { equals: "Ada" } },
    });
  });

  it("classifies each segment of a mixed multi-segment path independently", () => {
    // `author` is to-one and `books` is to-many, so only the second hop
    // takes a wrapper — a path-wide answer would be wrong at one end.
    expect(translate(condition("author.books.title", "EQ", "Dune"))).toEqual({
      author: { books: { some: { title: { equals: "Dune" } } } },
    });
  });

  it("carries the cardinality onto every operator's leaf, not just equality", () => {
    expect(translate(condition("books.title", "IN", ["Dune", "Emma"]), fromAuthor)).toEqual({
      books: { some: { title: { in: ["Dune", "Emma"] } } },
    });
    expect(translate(condition("books.title", "IS_NULL", true), fromAuthor)).toEqual({
      books: { some: { title: { equals: null } } },
    });
  });

  it("raises a Kavo 400 for a path it cannot classify, rather than a shape Prisma will reject", () => {
    // A raw `PrismaClientValidationError` surfaces as a 500 with a driver
    // message; a segment that is not a relation is a configuration mistake
    // (core's default allowlists hold scalars only) and says so.
    try {
      translate(condition("nonsense.title", "EQ", "x"));
      expect.unreachable("an unclassifiable relation path must raise");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryValidationException);
      expect((error as QueryValidationException).issues[0]).toMatchObject({
        field: "nonsense.title",
        code: "KAVO_QUERY_UNSUPPORTED_PARAM",
      });
    }
  });

  it("raises when a later segment of a multi-segment path is unknown", () => {
    // The walk must not stop at the first hop: `author` resolves, `nope`
    // does not, and the failure has to be the whole path's.
    expect(() => translate(condition("author.nope.title", "EQ", "x"))).toThrowError(QueryValidationException);
  });
});

describe("translateFilter — relation paths", () => {
  it("nests a dotted path into Prisma's relation shape", () => {
    expect(translate(condition("author.name", "EQ", "Ada"))).toEqual({
      author: { name: { equals: "Ada" } },
    });
  });

  it("nests a multi-segment path all the way down", () => {
    expect(translate(condition("author.city.name", "EQ", "Paris"))).toEqual({
      author: { city: { name: { equals: "Paris" } } },
    });
  });

  it("nests every operator's leaf, not just equality", () => {
    expect(translate(condition("author.age", "GTE", 18))).toEqual({ author: { age: { gte: 18 } } });
    expect(translate(condition("author.name", "IN", ["Ada", "Grace"]))).toEqual({
      author: { name: { in: ["Ada", "Grace"] } },
    });
    expect(translate(condition("author.name", "ILIKE", "a%"), insensitive)).toEqual({
      author: { name: { startsWith: "a", mode: "insensitive" } },
    });
  });

  it("leaves an undotted field at the top level", () => {
    expect(translate(condition("author", "EQ", "abc"))).toEqual({ author: { equals: "abc" } });
  });

  it("nests a relation path the same way inside a logical group", () => {
    expect(translate(group("OR", [condition("author.name", "EQ", "Ada"), condition("title", "EQ", "x")]))).toEqual({
      OR: [{ author: { name: { equals: "Ada" } } }, { title: { equals: "x" } }],
    });
  });
});

/**
 * `search[query]` (issue #156) is synthesized by `QueryNormalizer` into
 * ordinary `Filter`/`FilterGroup`/`ILIKE` AST nodes — no adapter-level code
 * changed to support it. `%term%` translates to Prisma's `contains`, per
 * the wildcard-position table above.
 */
describe("translateFilter — search[...] synthesis (issue #156)", () => {
  it("translates a substring-mode OR group across two searched fields to 'contains'", () => {
    expect(
      translate(group("OR", [condition("title", "ILIKE", "%dune%"), condition("blurb", "ILIKE", "%dune%")])),
    ).toEqual({
      OR: [{ title: { contains: "dune" } }, { blurb: { contains: "dune" } }],
    });
  });

  it("translates a words-mode AND of per-word OR groups", () => {
    expect(
      translate(
        group("AND", [
          group("OR", [condition("title", "ILIKE", "%blue%"), condition("blurb", "ILIKE", "%blue%")]),
          group("OR", [condition("title", "ILIKE", "%book%"), condition("blurb", "ILIKE", "%book%")]),
        ]),
      ),
    ).toEqual({
      AND: [
        { OR: [{ title: { contains: "blue" } }, { blurb: { contains: "blue" } }] },
        { OR: [{ title: { contains: "book" } }, { blurb: { contains: "book" } }] },
      ],
    });
  });

  it("nests a relation-path field the same way an ordinary relation filter does", () => {
    expect(
      translate(group("OR", [condition("title", "ILIKE", "%ada%"), condition("author.name", "ILIKE", "%ada%")])),
    ).toEqual({
      OR: [{ title: { contains: "ada" } }, { author: { name: { contains: "ada" } } }],
    });
  });

  it("narrows to a single search[fields] entry as a single condition, no OR wrapper", () => {
    expect(translate(condition("title", "ILIKE", "%dune%"))).toEqual({ title: { contains: "dune" } });
  });
});
