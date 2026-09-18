import { describe, expect, it } from "vitest";
import { schemaShapeKeys } from "../../src/schema/schema-shape.js";

describe("schemaShapeKeys", () => {
  it("returns null for a null schema", () => {
    expect(schemaShapeKeys(null)).toBeNull();
  });

  it("returns the own enumerable keys of a fresh instance", () => {
    class ItemDto {
      id = 0;
      name = "";
    }
    expect(schemaShapeKeys(ItemDto)).toEqual(["id", "name"]);
  });

  it("returns null for a class with no initialized fields", () => {
    class Empty {}
    expect(schemaShapeKeys(Empty)).toBeNull();
  });

  it("returns null and does not throw for a class whose constructor throws", () => {
    class Throws {
      constructor() {
        throw new Error("boom");
      }
    }
    expect(schemaShapeKeys(Throws)).toBeNull();
  });
});
