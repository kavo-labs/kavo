import { describe, expect, it } from "vitest";
import type { FieldMetadata } from "@kavo/core";
import { fieldKindSchema, fieldSchema } from "../src/openapi/field-schema.js";

function field(overrides: Partial<FieldMetadata>): FieldMetadata {
  return { name: "x", kind: "string", nullable: false, generated: false, ...overrides };
}

describe("fieldKindSchema", () => {
  it("documents an enum field with its allowed values", () => {
    expect(fieldKindSchema(field({ kind: "enum", enumValues: ["a", "b"] }))).toEqual({
      type: "string",
      enum: ["a", "b"],
    });
  });

  it("omits enum when no enumValues are declared", () => {
    expect(fieldKindSchema(field({ kind: "enum" }))).toEqual({ type: "string" });
  });

  it("documents a json field as an untyped object", () => {
    expect(fieldKindSchema(field({ kind: "json" }))).toEqual({ type: "object" });
  });
});

describe("fieldSchema", () => {
  it("adds nullable: true only when the field is nullable", () => {
    expect(fieldSchema(field({ nullable: true }))).toMatchObject({ nullable: true });
    expect(fieldSchema(field({ nullable: false }))).not.toHaveProperty("nullable");
  });
});
