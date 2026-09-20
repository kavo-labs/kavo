import { describe, expect, it } from "vitest";
import { targetsJsonSchemaDialect, upgradeToJsonSchemaDialect } from "../src/openapi-dialect.js";

describe("targetsJsonSchemaDialect", () => {
  it("is false for a 3.0.x document", () => {
    expect(targetsJsonSchemaDialect("3.0.0")).toBe(false);
  });

  it("is true for a 3.1.x document", () => {
    expect(targetsJsonSchemaDialect("3.1.0")).toBe(true);
  });

  it("is true for a 3.2.x document", () => {
    expect(targetsJsonSchemaDialect("3.2.0")).toBe(true);
  });

  it("is false for an absent or non-string openapi field", () => {
    expect(targetsJsonSchemaDialect(undefined)).toBe(false);
    expect(targetsJsonSchemaDialect(null)).toBe(false);
    expect(targetsJsonSchemaDialect(3.1)).toBe(false);
  });

  it("is false for a malformed version string", () => {
    expect(targetsJsonSchemaDialect("not-a-version")).toBe(false);
  });
});

describe("upgradeToJsonSchemaDialect", () => {
  it("converts a typed nullable schema into a type union, dropping nullable", () => {
    const schemas: Record<string, unknown> = {
      TodoItem: {
        type: "object",
        properties: {
          deletedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
    };

    upgradeToJsonSchemaDialect(schemas);

    const deletedAt = (schemas.TodoItem as { properties: { deletedAt: Record<string, unknown> } }).properties.deletedAt;
    expect(deletedAt).toEqual({ type: ["string", "null"], format: "date-time" });
  });

  it("appends null to an existing type array instead of overwriting it", () => {
    const schemas: Record<string, unknown> = {
      Widget: { type: ["string", "number"], nullable: true },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Widget).toEqual({ type: ["string", "number", "null"] });
  });

  it("does not duplicate null if the type array already includes it", () => {
    const schemas: Record<string, unknown> = {
      Widget: { type: ["string", "null"], nullable: true },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Widget).toEqual({ type: ["string", "null"] });
  });

  it("wraps an untyped nullable schema in anyOf instead of guessing a type", () => {
    const schemas: Record<string, unknown> = {
      Widget: { enum: ["a", "b"], nullable: true },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Widget).toEqual({ anyOf: [{ enum: ["a", "b"] }, { type: "null" }] });
  });

  it("appends null to an existing enum when converting a nullable enum schema", () => {
    const schemas: Record<string, unknown> = {
      Priority: { type: "string", enum: ["low", "high"], nullable: true },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Priority).toEqual({ type: ["string", "null"], enum: ["low", "high", null] });
  });

  it("does not duplicate null in an enum that already includes it", () => {
    const schemas: Record<string, unknown> = {
      Priority: { type: "string", enum: ["low", "high", null], nullable: true },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Priority).toEqual({ type: ["string", "null"], enum: ["low", "high", null] });
  });

  it("converts a schema-level example into an examples array", () => {
    const schemas: Record<string, unknown> = {
      Code: { type: "string", example: "KAVO_NOT_FOUND" },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Code).toEqual({ type: "string", examples: ["KAVO_NOT_FOUND"] });
  });

  it("recurses into properties, items, and allOf to upgrade nested schemas", () => {
    const schemas: Record<string, unknown> = {
      Todo: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string", nullable: true } },
        },
        allOf: [{ type: "object", properties: { note: { type: "string", example: "hi" } } }],
      },
    };

    upgradeToJsonSchemaDialect(schemas);

    const todo = schemas.Todo as {
      properties: { tags: { items: Record<string, unknown> } };
      allOf: [{ properties: { note: Record<string, unknown> } }];
    };
    expect(todo.properties.tags.items).toEqual({ type: ["string", "null"] });
    expect(todo.allOf[0].properties.note).toEqual({ type: "string", examples: ["hi"] });
  });

  it("leaves a schema with neither nullable nor example untouched", () => {
    const schemas: Record<string, unknown> = {
      Plain: { type: "string" },
    };

    upgradeToJsonSchemaDialect(schemas);

    expect(schemas.Plain).toEqual({ type: "string" });
  });
});
