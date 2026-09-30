import { describe, expect, it } from "vitest";
import { QueryNormalizer, resolveEntityConfig } from "@kavo/core";
import { userMetadata } from "./support/user-fixture.js";
import { issuesOf } from "./support/query-issues.js";

/**
 * A programmatic filter (GraphQL's `JSON` scalar, an MCP tool argument,
 * application code) arrives already structured, but it is not trusted for
 * that: it meets every rule the wire grammar enforces while parsing, and a
 * malformed node is the client's 400, never an adapter-side 500 or a
 * parameter of the wrong shape.
 */
const normalizer = new QueryNormalizer(userMetadata);
const config = resolveEntityConfig(userMetadata, undefined, undefined);
const restricted = resolveEntityConfig(
  userMetadata,
  { filter: { fields: { email: ["eq"], name: ["eq", "like"] } } } as never,
  undefined,
);

function issuesFor(filter: unknown, resolved = config) {
  return issuesOf(() => normalizer.normalizeInput({ filter: filter as never }, resolved));
}

describe("QueryNormalizer — programmatic filter validation", () => {
  it("enforces filter.fields' per-field operator map, so a structured filter cannot LIKE an eq-only field", () => {
    expect(
      issuesFor({ kind: "condition", field: "email", operator: "LIKE", value: "a%" }, restricted)[0],
    ).toMatchObject({
      field: "email",
      code: "KAVO_QUERY_INVALID_OPERATOR",
    });
    expect(issuesFor({ kind: "condition", field: "email", operator: "GT", value: "m" }, restricted)[0]).toMatchObject({
      field: "email",
      code: "KAVO_QUERY_INVALID_OPERATOR",
    });
    expect(() =>
      normalizer.normalizeInput(
        { filter: { kind: "condition", field: "name", operator: "LIKE", value: "a%" } },
        restricted,
      ),
    ).not.toThrow();
  });

  it.each(["DROP", "constructor", "__proto__", "eq", 7])("rejects the operator %s", (operator) => {
    expect(issuesFor({ kind: "condition", field: "name", operator, value: "x" })[0]).toMatchObject({
      code: "KAVO_QUERY_INVALID_OPERATOR",
    });
  });

  it.each([
    ["an object for EQ", "EQ", { $ne: null }],
    ["an array for EQ", "EQ", ["a"]],
    ["a scalar for IN", "IN", "a"],
    ["objects inside IN", "IN", [{ a: 1 }]],
    ["one bound for BETWEEN", "BETWEEN", ["a"]],
    ["a non-string LIKE pattern", "LIKE", 5],
    ["a non-finite number", "EQ", Number.POSITIVE_INFINITY],
  ])("rejects %s", (_label, operator, value) => {
    expect(issuesFor({ kind: "condition", field: "name", operator, value })[0]).toMatchObject({
      field: "name",
      code: "KAVO_QUERY_INVALID_VALUE",
    });
  });

  it.each([
    ["a string", "x"],
    ["an unknown kind", { kind: "weird", field: "name" }],
    ["a group without children", { kind: "group", operator: "AND" }],
    ["a group with an unknown connective", { kind: "group", operator: "XOR", children: [] }],
    ["a condition without a field", { kind: "condition", operator: "EQ", value: 1 }],
  ])("rejects %s as a filter node with a 400, not a TypeError", (_label, filter) => {
    expect(issuesFor(filter)[0]).toMatchObject({ code: expect.stringMatching(/^KAVO_QUERY_INVALID/) });
  });

  it("checks nested nodes too", () => {
    const filter = {
      kind: "group",
      operator: "AND",
      children: [
        {
          kind: "group",
          operator: "OR",
          children: [{ kind: "condition", field: "email", operator: "LIKE", value: "%" }],
        },
      ],
    };
    expect(issuesFor(filter, restricted)[0]).toMatchObject({ field: "email", code: "KAVO_QUERY_INVALID_OPERATOR" });
  });

  it("still accepts every well-formed shape", () => {
    const filter = {
      kind: "group",
      operator: "AND",
      children: [
        { kind: "condition", field: "name", operator: "EQ", value: "a" },
        { kind: "condition", field: "name", operator: "IN", value: ["a", "b"] },
        { kind: "condition", field: "name", operator: "IS_NULL", value: null },
        {
          kind: "group",
          operator: "NOT",
          children: [{ kind: "condition", field: "name", operator: "ILIKE", value: "a%" }],
        },
      ],
    };
    expect(() => normalizer.normalizeInput({ filter: filter as never }, config)).not.toThrow();
  });
});
