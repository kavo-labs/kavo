import { describe, expect, it } from "vitest";
import {
  isFieldsShorthand,
  resolveSchemaClassSlot,
  schemaClassFromFields,
  shorthandFieldsOf,
} from "../../src/schema/schema-fields-shorthand.js";
import { schemaShapeKeys } from "../../src/schema/schema-shape.js";

describe("schema fields shorthand", () => {
  it("isFieldsShorthand recognizes { fields: [...] }", () => {
    expect(isFieldsShorthand({ fields: ["id", "name"] })).toBe(true);
    expect(isFieldsShorthand({})).toBe(false);
    expect(isFieldsShorthand(null)).toBe(false);
  });

  it("schemaClassFromFields synthesizes a class whose shape matches the field list", () => {
    const cls = schemaClassFromFields(["id", "name"]);
    expect(schemaShapeKeys(cls)).toEqual(["id", "name"]);
    expect(shorthandFieldsOf(cls)).toEqual(["id", "name"]);
  });

  it("shorthandFieldsOf returns null for a hand-written class", () => {
    class Hand {
      id = 0;
    }
    expect(shorthandFieldsOf(Hand)).toBeNull();
  });

  it("resolveSchemaClassSlot passes a class through unchanged", () => {
    class Hand {
      id = 0;
    }
    expect(resolveSchemaClassSlot(Hand)).toBe(Hand);
  });

  it("resolveSchemaClassSlot synthesizes a class from a { fields } shorthand", () => {
    const resolved = resolveSchemaClassSlot({ fields: ["id"] });
    expect(schemaShapeKeys(resolved)).toEqual(["id"]);
  });

  it("resolveSchemaClassSlot returns null for undefined", () => {
    expect(resolveSchemaClassSlot(undefined)).toBeNull();
  });
});
