import { describe, expect, it } from "vitest";
import type { KavoSchema, SchemaParseResult } from "@kavo/core";
import { DefaultSchemaResolver, SchemaValidationException, createKavo } from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "../support/user-fixture.js";

/**
 * ADR-0055: `schema` wires a `KavoSchema` into the engine's deserialization
 * (input) and response-mapping (output) stages, alongside `dto` — landed
 * additively per issue #466 (see `schema/entity-schema.ts`'s module doc for
 * why `dto` itself isn't removed yet).
 */

interface CreateUserInput {
  readonly name: string;
  readonly email: string;
}

/** A minimal hand-rolled `KavoSchema`: rejects a missing `name`, otherwise passes the value through. */
function requireNameSchema<Output>(): KavoSchema<Output> {
  return {
    safeParse(input: unknown): SchemaParseResult<Output> {
      const record = input as Record<string, unknown> | null;
      if (record === null || typeof record !== "object" || typeof record.name !== "string" || record.name === "") {
        return {
          success: false,
          error: { issues: [{ path: ["name"], message: "name is required" }] },
        };
      }
      return { success: true, data: { ...record, name: `${record.name} (validated)` } as Output };
    },
  };
}

/** Strips `email` off the response — proves `schema.output` narrows/shapes independently of `dto`. */
function dropEmailSchema<Output>(): KavoSchema<Output> {
  return {
    safeParse(input: unknown): SchemaParseResult<Output> {
      const { email: _email, ...rest } = input as Record<string, unknown>;
      return { success: true, data: rest as Output };
    },
  };
}

function makeCrud(config: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1]) {
  const adapter = new InMemoryUserAdapter();
  const crud = createKavo().createCrud(User, config as never, { adapter, metadata: userMetadata });
  return { crud, adapter };
}

const ADA = { name: "Ada", email: "ada@example.com", age: 36, status: "active" as const };

describe("EntityConfig.schema (ADR-0055)", () => {
  it("schema.input.create validates the deserialized body and reshapes it via safeParse's data", async () => {
    const { crud } = makeCrud({ schema: { input: { create: requireNameSchema<CreateUserInput>() } } });
    const created = await crud.createOne(ADA as never);
    expect(created).toMatchObject({ name: "Ada (validated)" });
  });

  it("raises SchemaValidationException with a QueryIssueDto per SchemaIssue on failure", async () => {
    const { crud } = makeCrud({ schema: { input: { create: requireNameSchema<CreateUserInput>() } } });
    await expect(crud.createOne({ ...ADA, name: "" } as never)).rejects.toMatchObject({
      code: "KAVO_SCHEMA_INVALID",
      issues: [{ field: "name", detail: "name is required" }],
    });
    await expect(crud.createOne({ ...ADA, name: "" } as never)).rejects.toBeInstanceOf(SchemaValidationException);
  });

  it("names a root-level SchemaIssue (empty path) '(root)' rather than an empty field", async () => {
    const rootFailingSchema: KavoSchema<CreateUserInput> = {
      safeParse: () => ({ success: false, error: { issues: [{ path: [], message: "body must be an object" }] } }),
    };
    const { crud } = makeCrud({ schema: { input: { create: rootFailingSchema } } });
    await expect(crud.createOne(ADA as never)).rejects.toMatchObject({
      issues: [{ field: "(root)", detail: "body must be an object" }],
    });
  });

  it("schema.output.item narrows/shapes the response independently of dto", async () => {
    const { crud } = makeCrud({ schema: { output: { item: dropEmailSchema<Partial<User>>() } } });
    const created = await crud.createOne(ADA as never);
    expect(created).not.toHaveProperty("email");
    expect(created).toMatchObject({ name: "Ada" });
  });

  it("schema.output.list falls back to schema.output.item when unset (the same fallback dto.list has)", async () => {
    const { crud } = makeCrud({ schema: { output: { item: dropEmailSchema<Partial<User>>() } } });
    await crud.createOne(ADA as never);
    const list = await crud.findMany();
    expect(list.items.length).toBeGreaterThan(0);
    for (const item of list.items) {
      expect(item).not.toHaveProperty("email");
    }
  });

  it("schema.input.patch falls back to schema.input.update when unset", async () => {
    const { crud } = makeCrud({ schema: { input: { update: requireNameSchema<Partial<CreateUserInput>>() } } });
    const created = await crud.createOne(ADA as never);
    const patched = await crud.patchOne(created.id, { name: "Grace" } as never);
    expect(patched).toMatchObject({ name: "Grace (validated)" });
  });

  it("an unconfigured slot runs no validation and no narrowing — behavior is unchanged from no schema at all", async () => {
    const { crud } = makeCrud({ schema: { input: { create: requireNameSchema<CreateUserInput>() } } });
    const updated = await crud.updateOne((await crud.createOne(ADA as never)).id, ADA as never);
    expect(updated).toMatchObject({ name: "Ada" });
  });

  it("operations.<id>.schema overrides the entity's root schema for just that operation", async () => {
    const { crud } = makeCrud({
      schema: { input: { create: requireNameSchema<CreateUserInput>() } },
      operations: {
        createOne: { schema: { input: dropEmailSchema<Partial<User>>() } },
      },
    });
    // The per-operation override replaces the root `create` schema outright
    // — `requireNameSchema`'s "(validated)" suffix never runs, and `email`
    // is stripped from the *input* the override validates, so the stored
    // (and returned) row never got one.
    const created = await crud.createOne(ADA as never);
    expect(created.email).toBe("");
    expect(created.name).toBe("Ada");
  });

  it("a schema.output safeParse failure falls back to the already-projected value rather than throwing", async () => {
    const throwingSchema: KavoSchema<unknown> = {
      safeParse: () => ({ success: false, error: { issues: [{ path: [], message: "never used to reject" }] } }),
    };
    const { crud } = makeCrud({ schema: { output: { item: throwingSchema } } });
    const created = await crud.createOne(ADA as never);
    expect(created).toMatchObject({ name: "Ada" });
  });

  it("schema.input as a single KavoSchema applies it to create, update, and patch alike", async () => {
    const { crud } = makeCrud({ schema: { input: requireNameSchema<CreateUserInput>() } });
    const created = await crud.createOne(ADA as never);
    expect(created).toMatchObject({ name: "Ada (validated)" });

    const updated = await crud.updateOne(created.id, { ...ADA, name: "Grace" } as never);
    expect(updated).toMatchObject({ name: "Grace (validated)" });

    const patched = await crud.patchOne(created.id, { name: "Hedy" } as never);
    expect(patched).toMatchObject({ name: "Hedy (validated)" });
  });

  it("schema.output as a single KavoSchema applies it to item and list alike", async () => {
    const { crud } = makeCrud({ schema: { output: dropEmailSchema<Partial<User>>() } });
    const created = await crud.createOne(ADA as never);
    expect(created).not.toHaveProperty("email");
    const list = await crud.findMany();
    for (const item of list.items) {
      expect(item).not.toHaveProperty("email");
    }
  });

  it("a top-level schema as a single KavoSchema applies to input (create/update/patch) and output (item/list) at once", async () => {
    const { crud } = makeCrud({ schema: requireNameSchema<CreateUserInput>() });
    const created = await crud.createOne(ADA as never);
    // Both `schema.input.create` and `schema.output.item` are the same
    // schema instance here — the input side stamps the stored value once,
    // the output side stamps the response a second time.
    expect(created).toMatchObject({ name: "Ada (validated) (validated)" });
  });
});

describe("DefaultSchemaResolver with a SchemaClass slot", () => {
  it("resolves a class-shaped schema.input.create unchanged", () => {
    class CreateUserSchema {
      name = "";
    }
    const resolver = new DefaultSchemaResolver<{ name: string }>({ input: { create: CreateUserSchema } });
    // `resolveInput` is still typed `KavoSchema<unknown> | null` (Task 9
    // widens it once `kavo-engine.ts` branches on kind) — cast to assert
    // the class-shaped value the constructor actually stored.
    expect(resolver.resolveInput("create", "createOne") as unknown).toBe(CreateUserSchema);
  });

  it("does not confuse a class-shaped shorthand with the { input, output } map", () => {
    class WholeEntitySchema {
      name = "";
    }
    const resolver = new DefaultSchemaResolver<{ name: string }>(WholeEntitySchema);
    expect(resolver.resolveInput("create", "createOne") as unknown).toBe(WholeEntitySchema);
    expect(resolver.resolveOutput("item", "findOne") as unknown).toBe(WholeEntitySchema);
  });
});
