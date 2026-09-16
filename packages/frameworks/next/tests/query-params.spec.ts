import { describe, expect, it } from "vitest";
import { parseWireParams } from "@kavo/next";

describe("parseWireParams", () => {
  it("passes bracket-notation keys through unchanged", () => {
    const params = new URLSearchParams("filter[age][gte]=18&sort=-createdAt&limit=10");
    expect(parseWireParams(params)).toEqual({
      "filter[age][gte]": "18",
      sort: "-createdAt",
      limit: "10",
    });
  });

  it("marks a repeated bracketed key as an explicit array", () => {
    const params = new URLSearchParams("filter[status][in][]=a&filter[status][in][]=b");
    expect(parseWireParams(params)).toEqual({
      "filter[status][in][]": ["a", "b"],
    });
  });

  it("appends [] to a repeated bracketed key not already marked as one", () => {
    const params = new URLSearchParams("include[]=list&include[]=tags");
    expect(parseWireParams(params)).toEqual({
      "include[]": ["list", "tags"],
    });
  });

  it("keeps a repeated top-level scalar under its own name, as an array, for the normalizer to reject", () => {
    const params = new URLSearchParams("limit=1&limit=2");
    expect(parseWireParams(params)).toEqual({ limit: ["1", "2"] });
  });

  it("returns a null-prototype object", () => {
    const params = new URLSearchParams("limit=1");
    expect(Object.getPrototypeOf(parseWireParams(params))).toBeNull();
  });
});
