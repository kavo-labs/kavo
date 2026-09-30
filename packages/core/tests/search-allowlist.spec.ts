import { describe, expect, it } from "vitest";
import { QueryNormalizer, resolveEntityConfig } from "@kavo/core";
import { userMetadata } from "./support/user-fixture.js";
import { issuesOf } from "./support/query-issues.js";

/**
 * A search term is an ILIKE substring match, so a searchable column is one a
 * client can probe character by character. An unconfigured `search.fields`
 * therefore defaults to the string columns the client could already filter
 * with `ilike` and read back — never one hidden from `filter.fields` or
 * `select.fields`. An explicit `search.fields` list stays the entity's call.
 */
const normalizer = new QueryNormalizer(userMetadata);

function searchable(config: object): readonly string[] {
  const resolved = resolveEntityConfig(userMetadata, config as never, undefined);
  return resolved.search === false ? [] : (resolved.search.fields as readonly string[]);
}

describe("search.fields default — never wider than filter and select", () => {
  it("leaves out a string column hidden from filter.fields", () => {
    expect(searchable({ search: {}, filter: { fields: ["name", "age"] } })).toEqual(["name"]);
  });

  it("leaves out a string column hidden from select.fields", () => {
    expect(searchable({ search: {}, select: { fields: ["id", "name"] } })).toEqual(["name"]);
  });

  it("leaves out a column filter.fields' operator map does not open to ilike", () => {
    expect(searchable({ search: {}, filter: { fields: { name: ["eq"], email: ["ilike", "eq"] } } })).toEqual(["email"]);
  });

  it("applies the same narrowing to the { exclude } form", () => {
    expect(searchable({ search: { fields: { exclude: ["name"] } }, filter: { fields: ["name"] } })).toEqual([]);
  });

  it("keeps an explicit search.fields list as given", () => {
    expect(searchable({ search: { fields: ["email"] }, filter: { fields: ["name"] } })).toEqual(["email"]);
  });

  it("rejects search[fields] naming a column the narrowed default left out", () => {
    const config = resolveEntityConfig(
      userMetadata,
      { search: {}, filter: { fields: ["name"] }, select: { fields: ["id", "name"] } } as never,
      undefined,
    );
    const issues = issuesOf(() =>
      normalizer.normalizeWire({ "search[query]": "a", "search[fields]": "email" }, config),
    );
    expect(issues[0]).toMatchObject({ field: "email", code: "KAVO_QUERY_INVALID_FIELD" });
  });

  it("still searches every string column when nothing is narrowed", () => {
    expect(searchable({ search: {} })).toEqual(["name", "email"]);
  });
});
