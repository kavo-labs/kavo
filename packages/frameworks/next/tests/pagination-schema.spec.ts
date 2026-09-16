import { describe, expect, it } from "vitest";
import { paginationSlotSchema } from "../src/openapi/pagination-schema.js";

describe("paginationSlotSchema", () => {
  it("documents the unpaginated shape for 'none'", () => {
    expect(paginationSlotSchema("none")).toMatchObject({
      type: "object",
      properties: { limit: { type: "integer" }, offset: { type: "integer" } },
      description: expect.stringContaining("disabled"),
    });
  });

  it("documents 1-based page[number]/page[size] for 'page'", () => {
    const schema = paginationSlotSchema("page") as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("page[number]");
    expect(schema.properties).toHaveProperty("page[size]");
  });

  it("documents limit/cursor for 'cursor'", () => {
    const schema = paginationSlotSchema("cursor") as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("limit");
    expect(schema.properties).toHaveProperty("cursor");
  });

  it("documents limit/since for 'since'", () => {
    const schema = paginationSlotSchema("since") as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("limit");
    expect(schema.properties).toHaveProperty("since");
  });

  it("falls back to limit/offset for 'offset' and any unrecognized strategy name", () => {
    const offset = paginationSlotSchema("offset") as { properties: Record<string, unknown> };
    expect(offset.properties).toHaveProperty("limit");
    expect(offset.properties).toHaveProperty("offset");

    const unknown = paginationSlotSchema("some-custom-strategy") as { properties: Record<string, unknown> };
    expect(unknown.properties).toHaveProperty("limit");
    expect(unknown.properties).toHaveProperty("offset");
  });
});
