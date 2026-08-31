import { describe, expect, it } from "vitest";
import { WireQuery } from "@kavo/core";
import { flattenQuery } from "@kavo/nest";

/**
 * Each row is one query written the two ways a query parser can
 * deliver it: `nested` is the qs-"extended" (Express 4) parse, `flat` is
 * the "simple" (Express 5) parse, which is also the form the grammar is
 * specified against.
 */
const equivalents: readonly {
  readonly name: string;
  readonly nested: Record<string, unknown>;
  readonly flat: Record<string, unknown>;
}[] = [
  {
    name: "a single filter condition",
    nested: { filter: { age: { gte: "18" } } },
    flat: { "filter[age][gte]": "18" },
  },
  {
    name: "several filter conditions that AND together",
    nested: { filter: { age: { gte: "18" }, status: { in: "active,pending" }, name: { like: "%john%" } } },
    flat: {
      "filter[age][gte]": "18",
      "filter[status][in]": "active,pending",
      "filter[name][like]": "%john%",
    },
  },
  {
    name: "the repeated-key form of a multi-value operator",
    nested: { filter: { status: { in: ["active", "pending"] } } },
    flat: { "filter[status][in][]": ["active", "pending"] },
  },
  {
    name: "a relation-path filter",
    nested: { filter: { "profile.city": { eq: "Helsinki" } } },
    flat: { "filter[profile.city][eq]": "Helsinki" },
  },
  {
    name: "sort",
    nested: { sort: "-createdAt,name" },
    flat: { sort: "-createdAt,name" },
  },
  {
    name: "offset pagination",
    nested: { limit: "20", offset: "20" },
    flat: { limit: "20", offset: "20" },
  },
  {
    name: "page pagination",
    nested: { page: { number: "3", size: "10" } },
    flat: { "page[number]": "3", "page[size]": "10" },
  },
  {
    name: "the root fieldset",
    nested: { select: "id,name,email" },
    flat: { select: "id,name,email" },
  },
  {
    name: "a per-relation fieldset",
    nested: { select: { posts: "id,title" } },
    flat: { "select[posts]": "id,title" },
  },
  {
    name: "include and withDeleted",
    nested: { include: "profile,posts.comments", withDeleted: "false" },
    flat: { include: "profile,posts.comments", withDeleted: "false" },
  },
];

describe("flattenQuery — parser-agnostic flat bracket keys", () => {
  it.each(equivalents)("flattens $name to the specified flat form", ({ nested, flat }) => {
    expect(flattenQuery(nested)).toEqual(flat);
  });

  it.each(equivalents)("reaches the identical map from either parser for $name", ({ nested, flat }) => {
    expect(flattenQuery(nested)).toEqual(flattenQuery(flat));
  });

  it.each(equivalents)("leaves the already-flat form of $name untouched", ({ flat }) => {
    expect(flattenQuery(flat)).toEqual(flat);
  });

  it("is idempotent, so a second pass cannot re-bracket a flattened key", () => {
    for (const { nested } of equivalents) {
      const once = flattenQuery(nested);
      expect(flattenQuery(once)).toEqual(once);
    }
  });

  it("does not mutate the query it was handed", () => {
    const nested = { filter: { age: { gte: "18" } } };
    flattenQuery(nested);
    expect(nested).toEqual({ filter: { age: { gte: "18" } } });
  });
});

describe("flattenQuery — arrays and the [] suffix rule", () => {
  it("appends [] to a bracketed key whose value is an array", () => {
    expect(flattenQuery({ "filter[status][in]": ["active", "pending"] })).toEqual({
      "filter[status][in][]": ["active", "pending"],
    });
  });

  it("keeps a key that already ends in [] exactly as it arrived", () => {
    expect(flattenQuery({ "filter[status][in][]": ["a", "b"] })).toEqual({ "filter[status][in][]": ["a", "b"] });
  });

  it("leaves a top-level key unbracketed even when its value is an array", () => {
    // `?limit=1&limit=2` must stay `limit`, not become `limit[]`: the
    // normalizer's job is to reject it as a bad value, and renaming the
    // param would make the 400 name a field the client never sent.
    expect(flattenQuery({ limit: ["1", "2"] })).toEqual({ limit: ["1", "2"] });
  });

  it("keeps array values as arrays rather than joining them", () => {
    const flat = flattenQuery({ filter: { status: { in: ["active", "pending"] } } });
    expect(flat["filter[status][in][]"]).toEqual(["active", "pending"]);
  });

  it("keeps an empty array under the bracketed key", () => {
    expect(flattenQuery({ "filter[status][in]": [] })).toEqual({ "filter[status][in][]": [] });
  });
});

describe("flattenQuery — nesting depth and empty values", () => {
  it("flattens an arbitrarily deep nested group into one bracket key", () => {
    expect(flattenQuery({ filter: { or: { 0: { role: { eq: "admin" } }, 1: { status: { eq: "banned" } } } } })).toEqual(
      {
        "filter[or][0][role][eq]": "admin",
        "filter[or][1][status][eq]": "banned",
      },
    );
  });

  it("emits nothing for an empty nested object, at any depth", () => {
    expect(flattenQuery({})).toEqual({});
    expect(flattenQuery({ filter: {} })).toEqual({});
    expect(flattenQuery({ filter: { age: {} } })).toEqual({});
  });

  it("preserves an empty-string value instead of dropping the param", () => {
    expect(flattenQuery({ filter: { name: { eq: "" } }, sort: "" })).toEqual({ "filter[name][eq]": "", sort: "" });
  });

  it("preserves a null value as a leaf rather than descending into it", () => {
    expect(flattenQuery({ limit: null, filter: { name: { eq: null } } })).toEqual({
      limit: null,
      "filter[name][eq]": null,
    });
  });

  it("passes non-string leaves through unchanged", () => {
    expect(flattenQuery({ limit: 20, filter: { done: { eq: true } } })).toEqual({
      limit: 20,
      "filter[done][eq]": true,
    });
  });
});

describe("flattenQuery — idempotent against an already-wrapped WireQuery (issue #25)", () => {
  it("returns a WireQuery's own params unchanged instead of flattening them one level too deep", () => {
    const params = { "filter[status][eq]": "active", fields: "id,title" };
    const wired = new WireQuery(params);

    // A stale @Override written before issue #25 that still manually wraps
    // its (now already-wired) query param must not have its filter/select
    // silently mangled into `params[filter[status][eq]]` etc.
    expect(flattenQuery(wired as unknown as Record<string, unknown>)).toEqual(params);
  });

  it("does not mutate or alias the WireQuery's params object", () => {
    const params = { select: "id,title" };
    const wired = new WireQuery(params);
    const flattened = flattenQuery(wired as unknown as Record<string, unknown>);
    expect(flattened).not.toBe(params);
    expect(flattened).toEqual(params);
  });
});
