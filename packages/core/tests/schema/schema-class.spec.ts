import { describe, expect, it } from "vitest";
import { isSchemaClass } from "../../src/schema/schema-class.js";

describe("isSchemaClass", () => {
  it("is true for a plain class", () => {
    class UserDto {
      id = 0;
    }
    expect(isSchemaClass(UserDto)).toBe(true);
  });

  it("is false for a KavoSchema-shaped validator", () => {
    const validator = { safeParse: () => ({ success: true, data: {} }) };
    expect(isSchemaClass(validator)).toBe(false);
  });

  it("is false for null and primitives", () => {
    expect(isSchemaClass(null)).toBe(false);
    expect(isSchemaClass(42)).toBe(false);
  });
});
