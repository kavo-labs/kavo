import { describe, expect, it } from "vitest";
import { ConfigurationException, DefaultSchemaResolver, resolveEntityConfig } from "@kavo/core";
import type { EntityMetadata } from "@kavo/core";
import { User, userMetadata } from "./support/user-fixture.js";

const keysOf = (schema: unknown): string[] => Object.keys(new (schema as new () => Record<string, unknown>)()).sort();

describe("schema — bare field-array shorthand", () => {
  it("schema.input: [...] covers create/update/patch, never query", () => {
    const resolver = new DefaultSchemaResolver<User>({ input: ["email", "name"] });
    for (const slot of ["create", "update", "patch"] as const) {
      expect(keysOf(resolver.resolveInput(slot, "createOne"))).toEqual(["email", "name"]);
    }
    expect(resolver.resolveInput("query", "findMany")).toBeNull();
    expect(resolver.resolveOutput("item", "findOne")).toBeNull();
  });

  it("schema.input.create: [...] sets only create; update/patch stay unset", () => {
    const resolver = new DefaultSchemaResolver<User>({ input: { create: ["email"] } });
    expect(keysOf(resolver.resolveInput("create", "createOne"))).toEqual(["email"]);
    expect(resolver.resolveInput("update", "updateOne")).toBeNull();
    expect(resolver.resolveInput("patch", "patchOne")).toBeNull();
  });

  it("schema.output: [...] covers item and list", () => {
    const resolver = new DefaultSchemaResolver<User>({ output: ["id", "email"] });
    expect(keysOf(resolver.resolveOutput("item", "findOne"))).toEqual(["email", "id"]);
    expect(resolver.resolveOutput("list", "findMany")).toBe(resolver.resolveOutput("item", "findOne"));
  });

  it("schema: [...] applies to input and output", () => {
    const resolver = new DefaultSchemaResolver<User>(["email", "name"]);
    expect(keysOf(resolver.resolveInput("create", "createOne"))).toEqual(["email", "name"]);
    expect(keysOf(resolver.resolveOutput("item", "findOne"))).toEqual(["email", "name"]);
  });

  it("accepts the { fields } object at whole-position level too", () => {
    const resolver = new DefaultSchemaResolver<User>({ input: { fields: ["email"] } });
    expect(keysOf(resolver.resolveInput("update", "updateOne"))).toEqual(["email"]);
  });

  it("an array on update is what patch falls back to", () => {
    const resolver = new DefaultSchemaResolver<User>({ input: { update: ["name"] } });
    expect(keysOf(resolver.resolveInput("patch", "patchOne"))).toEqual(["name"]);
  });

  it("wins over the top-level create.fields fallback, like any class", () => {
    const resolver = new DefaultSchemaResolver<User>(
      { input: { create: ["email"] } },
      { create: { fields: ["name"] } },
    );
    expect(keysOf(resolver.resolveInput("create", "createOne"))).toEqual(["email"]);
  });
});

describe("schema — array shorthand, derived-field guard", () => {
  const metadata: EntityMetadata<User> = {
    ...userMetadata,
    fields: [
      ...userMetadata.fields,
      { name: "fullName", kind: "string", nullable: false, generated: false, derivedExpression: "concat" },
    ],
  };

  it.each([
    ["schema.input", { input: ["fullName"] }],
    ["schema.input.create", { input: { create: ["fullName"] } }],
    ["schema.input.update", { input: { update: ["fullName"] } }],
    ["schema", ["fullName"]],
  ])("rejects an ORM-derived field in %s", (_path, schema) => {
    expect(() => resolveEntityConfig(metadata, { schema: schema as never }, undefined)).toThrow(ConfigurationException);
  });
});
