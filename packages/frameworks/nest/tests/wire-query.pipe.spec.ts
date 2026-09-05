import { describe, expect, it } from "vitest";
import { WireQuery } from "@kavo/core";
import { WireQueryPipe } from "../src/wire-query.pipe.js";

describe("WireQueryPipe", () => {
  it("flattens a plain query object into a WireQuery", () => {
    const query = new WireQueryPipe().transform({ filter: { age: { gte: "18" } } });
    expect(query).toBeInstanceOf(WireQuery);
    expect(query.params).toEqual({ "filter[age][gte]": "18" });
  });

  it("defaults a missing value to an empty query — every field absent, not a thrown error", () => {
    const query = new WireQueryPipe().transform(undefined);
    expect(query).toBeInstanceOf(WireQuery);
    expect(query.params).toEqual({});
  });
});
