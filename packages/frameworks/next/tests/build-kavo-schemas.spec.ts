import { describe, expect, it } from "vitest";
import { buildKavoSchemas } from "@kavo/next";
import { buildTodoCrud } from "./support/todo-crud.js";

describe("buildKavoSchemas", () => {
  it("includes the two shared problem-details components", () => {
    const { service } = buildTodoCrud();
    const { schemas } = buildKavoSchemas({ todos: service });
    expect(schemas.KavoProblemDetails).toMatchObject({ type: "object" });
    expect(schemas.KavoProblemDetailError).toMatchObject({ type: "object" });
  });

  it("names every entity component after the entity's own name, not the map key", () => {
    const { service } = buildTodoCrud();
    const { schemas } = buildKavoSchemas({ todos: service });
    expect(schemas).toHaveProperty("TodoItem");
    expect(schemas).toHaveProperty("TodoListItem");
    expect(schemas).toHaveProperty("TodoList");
    expect(schemas).toHaveProperty("TodoListMeta");
    expect(schemas).toHaveProperty("TodoPagination");
    expect(schemas).toHaveProperty("TodoInclude");
    expect(schemas).toHaveProperty("TodoSort");
    expect(schemas).toHaveProperty("TodoFilter");
    expect(schemas).toHaveProperty("TodoQuery");
    expect(schemas).toHaveProperty("TodoCreate");
    expect(schemas).toHaveProperty("TodoUpdate");
    expect(schemas).toHaveProperty("TodoPatch");
    expect(schemas).toHaveProperty("TodoValidationError");
    expect(schemas).not.toHaveProperty("TodosItem");
  });

  it("describes every entity field on TodoItem, with the right JSON type", () => {
    const { service } = buildTodoCrud();
    const { schemas } = buildKavoSchemas({ todos: service });
    const item = schemas.TodoItem as { properties: Record<string, { type?: string }> };
    expect(item.properties.id).toMatchObject({ type: "number" });
    expect(item.properties.title).toMatchObject({ type: "string" });
    expect(item.properties.done).toMatchObject({ type: "boolean" });
    expect(item.properties.deletedAt).toMatchObject({ type: "string", format: "date-time", nullable: true });
  });

  it("TodoList wraps TodoListItem and carries the envelope's fixed fields", () => {
    const { service } = buildTodoCrud();
    const { schemas } = buildKavoSchemas({ todos: service });
    const list = schemas.TodoList as { properties: Record<string, unknown>; required: string[] };
    expect(list.required).toEqual(["items", "limit", "offset", "total"]);
    expect(list.properties.items).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/TodoListItem" },
    });
    expect(list.properties.meta).toEqual({ $ref: "#/components/schemas/TodoListMeta" });
  });

  it("TodoFilter documents the configured filterable fields with their operator map", () => {
    const { service } = buildTodoCrud();
    const { schemas } = buildKavoSchemas({ todos: service });
    const filter = schemas.TodoFilter as { properties: Record<string, { properties?: Record<string, unknown> }> };
    expect(filter.properties.priority?.properties).toHaveProperty("gte");
    expect(filter.properties.priority?.properties).toHaveProperty("in");
    // title is a string-kind field, so it additionally gets like/ilike.
    expect(filter.properties.title?.properties).toHaveProperty("like");
    expect(filter.properties.title?.properties).toHaveProperty("ilike");
    expect(filter.properties.priority?.properties).not.toHaveProperty("like");
  });

  it("TodoCreate excludes the generated id field and marks non-nullable fields required", () => {
    const { service } = buildTodoCrud();
    const { schemas } = buildKavoSchemas({ todos: service });
    const create = schemas.TodoCreate as { properties: Record<string, unknown>; required: string[] };
    expect(create.properties).not.toHaveProperty("id");
    expect(create.required).toContain("title");
    expect(create.required).not.toContain("deletedAt");
  });

  it("TodoPatch has the same fields as TodoCreate but requires none of them", () => {
    const { service } = buildTodoCrud();
    const { schemas } = buildKavoSchemas({ todos: service });
    const create = schemas.TodoCreate as { properties: Record<string, unknown> };
    const patch = schemas.TodoPatch as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(patch.properties)).toEqual(Object.keys(create.properties));
    expect(patch.required).toBeUndefined();
  });

  it("TodoValidationError is an allOf over the shared KavoProblemDetails component", () => {
    const { service } = buildTodoCrud();
    const { schemas } = buildKavoSchemas({ todos: service });
    expect(schemas.TodoValidationError).toMatchObject({
      allOf: [{ $ref: "#/components/schemas/KavoProblemDetails" }],
    });
  });
});
