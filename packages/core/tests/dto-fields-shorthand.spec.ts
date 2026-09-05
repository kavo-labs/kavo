import { describe, expect, it } from "vitest";
import { isFieldsShorthand } from "../src/dto/dto-fields-shorthand.js";

describe("isFieldsShorthand", () => {
  it("recognizes a { fields: [...] } shorthand object", () => {
    expect(isFieldsShorthand({ fields: ["name"] })).toBe(true);
  });

  it("rejects a DTO class, null, and a plain object with no array fields", () => {
    expect(isFieldsShorthand(class {})).toBe(false);
    expect(isFieldsShorthand(null)).toBe(false);
    expect(isFieldsShorthand({ fields: "name" })).toBe(false);
    expect(isFieldsShorthand({})).toBe(false);
  });
});
