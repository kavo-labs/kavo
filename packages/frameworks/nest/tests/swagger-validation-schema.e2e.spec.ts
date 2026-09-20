import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNegative,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { z } from "zod";
import { Kavo, KavoModule, registerKavoSchemas } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";

/**
 * Issue: the OpenAPI schema `schemaFromDto` (`swagger.ts`) synthesizes from a
 * DTO's runtime field initializers carried no element type for array fields
 * (`items: {}` unconditionally) and no validation keywords at all — a
 * `class-validator`-decorated DTO's `@MinLength`/`@IsEnum`/`@Matches`/etc.
 * never reached the documented schema. These pin both fixes: a non-empty
 * sample array documents its element type, and class-validator decorators
 * translate into the matching OpenAPI keywords (including `each: true`
 * decorators narrowing `items` instead of the array property itself).
 */
enum Priority {
  LOW = "low",
  HIGH = "high",
}

class CreateTodoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[a-z]+$/)
  title = "";

  @IsEnum(Priority)
  priority: Priority = Priority.LOW;

  @IsInt()
  @Min(0)
  @Max(10)
  weight = 0;

  @IsIn(["a", "b"])
  category = "a";

  @IsEmail()
  ownerEmail = "";

  @IsArray()
  @IsString({ each: true })
  tags: string[] = [];

  labels: string[] = ["seed"];

  @IsOptional()
  @IsString()
  note = "";
}

const apps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createDocument(controllers: readonly unknown[]): Promise<Record<string, unknown>> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) }),
      KavoModule.forFeature(controllers as never),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  apps.push(app);
  await app.init();
  const document = registerKavoSchemas(
    SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build()),
  );
  return document as unknown as Record<string, unknown>;
}

function schemaNamed(
  document: Record<string, unknown>,
  name: string,
): { properties: Record<string, Record<string, unknown>>; required?: string[] } {
  const schemas = (document.components as { schemas?: Record<string, unknown> }).schemas ?? {};
  return schemas[name] as { properties: Record<string, Record<string, unknown>>; required?: string[] };
}

class WidgetDto {
  @IsNumber()
  score = 0;

  @IsUrl()
  homepage = "";

  @IsUUID()
  externalId = "";

  @IsDateString()
  publishedAt = "";

  @Length(2, 5)
  code = "";

  @IsNegative()
  offset = -1;

  @IsBoolean()
  active = false;

  @IsPositive()
  rank = 1;
}

describe("registerKavoSchemas — class-validator DTOs", () => {
  it("translates the remaining scalar/format/length keyword decorators", async () => {
    @Kavo(Todo, { schema: { input: { create: WidgetDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const { properties } = schemaNamed(document, "TodoCreate");

    expect(properties.score).toMatchObject({ type: "number" });
    expect(properties.homepage).toMatchObject({ type: "string", format: "uri" });
    expect(properties.externalId).toMatchObject({ type: "string", format: "uuid" });
    expect(properties.publishedAt).toMatchObject({ type: "string", format: "date-time" });
    expect(properties.code).toMatchObject({ minLength: 2, maxLength: 5 });
    expect(properties.offset).toMatchObject({ exclusiveMaximum: 0 });
    expect(properties.active).toMatchObject({ type: "boolean" });
    expect(properties.rank).toMatchObject({ exclusiveMinimum: 0 });
  });

  it("translates string/number/enum/pattern constraints into OpenAPI keywords", async () => {
    @Kavo(Todo, { schema: { input: { create: CreateTodoDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const { properties } = schemaNamed(document, "TodoCreate");

    expect(properties.title).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 80,
      pattern: "^[a-z]+$",
    });
    expect(properties.priority).toMatchObject({ enum: ["low", "high"] });
    expect(properties.weight).toMatchObject({ type: "integer", minimum: 0, maximum: 10 });
    expect(properties.category).toMatchObject({ enum: ["a", "b"] });
    expect(properties.ownerEmail).toMatchObject({ type: "string", format: "email" });
  });

  it("narrows `items` for an each:true decorator instead of the array property", async () => {
    @Kavo(Todo, { schema: { input: { create: CreateTodoDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const { properties } = schemaNamed(document, "TodoCreate");

    expect(properties.tags).toMatchObject({ type: "array", items: { type: "string" } });
  });

  it("infers an array field's element type from a non-empty sample initializer", async () => {
    @Kavo(Todo, { schema: { input: { create: CreateTodoDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const { properties } = schemaNamed(document, "TodoCreate");

    expect(properties.labels).toMatchObject({ type: "array", items: { type: "string" } });
  });

  it("leaves items as the open `{}` schema for an empty array with no narrowing decorator", async () => {
    class PlainListDto {
      values: string[] = [];
    }

    @Kavo(Todo, { schema: { input: { create: PlainListDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const { properties } = schemaNamed(document, "TodoCreate");

    expect(properties.values).toEqual({ type: "array", items: {} });
  });

  it("requires every class-validator-decorated property except one marked @IsOptional", async () => {
    @Kavo(Todo, { schema: { input: { create: CreateTodoDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const schema = schemaNamed(document, "TodoCreate");

    expect(schema.required).toEqual(
      expect.arrayContaining(["title", "priority", "weight", "category", "ownerEmail", "tags"]),
    );
    expect(schema.required).not.toContain("note");
    // `labels` carries no class-validator decorator at all — undecorated,
    // so it gives no required/optional signal either way.
    expect(schema.required).not.toContain("labels");
  });
});

class AddressDto {
  @IsString()
  @MinLength(1)
  street = "";

  @IsString()
  city = "";
}

class CreateOwnerDto {
  @IsString()
  name = "";

  @ValidateNested()
  @Type(() => AddressDto)
  address: AddressDto = new AddressDto();

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddressDto)
  previousAddresses: AddressDto[] = [];
}

class SelfNestedDto {
  @IsString()
  label = "";

  @IsOptional()
  @ValidateNested()
  @Type(() => SelfNestedDto)
  parent: SelfNestedDto = undefined as unknown as SelfNestedDto;
}

describe("registerKavoSchemas — nested @ValidateNested()/@Type() relations", () => {
  it("expands a single nested DTO's own fields and constraints instead of a bare object schema", async () => {
    @Kavo(Todo, { schema: { input: { create: CreateOwnerDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const { properties } = schemaNamed(document, "TodoCreate");

    expect(properties.address).toMatchObject({
      type: "object",
      properties: {
        street: { type: "string", minLength: 1 },
        city: { type: "string" },
      },
      required: ["street", "city"],
    });
  });

  it("expands an each:true nested DTO array into items, not a bare items: {} schema", async () => {
    @Kavo(Todo, { schema: { input: { create: CreateOwnerDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const { properties } = schemaNamed(document, "TodoCreate");

    expect(properties.previousAddresses).toMatchObject({
      type: "array",
      items: { type: "object", properties: { street: { type: "string" }, city: { type: "string" } } },
    });
  });

  it("stops expanding a self-referential nested DTO instead of recursing forever", async () => {
    @Kavo(Todo, { schema: { input: { create: SelfNestedDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const { properties } = schemaNamed(document, "TodoCreate");

    expect(properties.label).toMatchObject({ type: "string" });
    // One level expands normally (`parent.properties.label`); the second
    // repeat of the same class is where the cycle is cut — a bare object
    // schema, not another level of `parent.properties.parent.properties...`.
    const parent = properties.parent as { properties: Record<string, Record<string, unknown>> };
    expect(parent.properties.label).toMatchObject({ type: "string" });
    expect(parent.properties.parent).toMatchObject({ type: "object" });
    expect((parent.properties.parent as { properties?: unknown }).properties).toBeUndefined();
  });
});

/**
 * ADR-0055 / issue #467: a `schema.input.<slot>` validator that implements
 * `toJSONSchema()` is the OpenAPI source of truth outright (`schemaDocFor`)
 * — it never goes through `schemaFromDto`'s runtime-initializer inference
 * at all, so a real Zod schema's own array/validation-keyword fidelity
 * carries straight through with no translation code of Kavo's own. This
 * pins that the existing seam actually delivers that for a real Zod
 * schema, not just the hand-built `toJSONSchema` mocks elsewhere.
 */
describe("registerKavoSchemas — a real Zod schema.input.create", () => {
  it("documents Zod's own array items and validation keywords verbatim", async () => {
    const createTodoZodSchema = z.object({
      title: z.string().min(1).max(80),
      tags: z.array(z.string().min(2)),
      priority: z.enum(["low", "high"]),
    });

    @Kavo(Todo, { schema: { input: { create: createTodoZodSchema } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const schema = schemaNamed(document, "TodoCreate");

    expect(schema.properties.title).toMatchObject({ type: "string", minLength: 1, maxLength: 80 });
    expect(schema.properties.tags).toMatchObject({ type: "array", items: { type: "string", minLength: 2 } });
    expect(schema.properties.priority).toMatchObject({ type: "string", enum: ["low", "high"] });
    expect(schema.required).toEqual(expect.arrayContaining(["title", "tags", "priority"]));
  });

  it("expands a nested z.object() and an array of them with no extra Kavo code — Zod walks its own tree", async () => {
    const addressZodSchema = z.object({ street: z.string().min(1), city: z.string() });
    const createOwnerZodSchema = z.object({
      name: z.string(),
      address: addressZodSchema,
      previousAddresses: z.array(addressZodSchema),
    });

    @Kavo(Todo, { schema: { input: { create: createOwnerZodSchema } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const schema = schemaNamed(document, "TodoCreate");

    expect(schema.properties.address).toMatchObject({
      type: "object",
      properties: { street: { type: "string", minLength: 1 }, city: { type: "string" } },
      required: ["street", "city"],
    });
    expect(schema.properties.previousAddresses).toMatchObject({
      type: "array",
      items: {
        type: "object",
        properties: { street: { type: "string", minLength: 1 }, city: { type: "string" } },
        required: ["street", "city"],
      },
    });
  });
});

/**
 * The response side of the same ADR-0055 / issue #467 seam: `successBodyFor`
 * reads `schema.output.<slot>` through the identical `schemaDocFor` used for
 * `schema.input.<slot>` above, so a real Zod validator's own constraints
 * should carry straight through to the success response too, not just the
 * request body.
 */
describe("registerKavoSchemas — a real Zod schema.output.item/list", () => {
  it("documents a single-row response's own validation keywords verbatim", async () => {
    const todoItemZodSchema = z.object({
      title: z.string().min(1).max(80),
      priority: z.enum(["low", "high"]),
    });

    @Kavo(Todo, { schema: { output: { item: todoItemZodSchema } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const item = schemaNamed(document, "TodoItem");

    expect(item.properties.title).toMatchObject({ type: "string", minLength: 1, maxLength: 80 });
    expect(item.properties.priority).toMatchObject({ type: "string", enum: ["low", "high"] });
    expect(item.required).toEqual(expect.arrayContaining(["title", "priority"]));
  });

  it("documents a list response's element validation keywords verbatim, inside the envelope", async () => {
    const todoListZodSchema = z.object({
      title: z.string().min(1).max(80),
      tags: z.array(z.string().min(2)),
    });

    @Kavo(Todo, { schema: { output: { list: todoListZodSchema } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const element = schemaNamed(document, "TodoListItem");

    expect(element.properties.title).toMatchObject({ type: "string", minLength: 1, maxLength: 80 });
    expect(element.properties.tags).toMatchObject({ type: "array", items: { type: "string", minLength: 2 } });
    expect(element.required).toEqual(expect.arrayContaining(["title", "tags"]));
  });
});

/**
 * `successBodyFor` resolves a hand-registered `schema.output.item` class
 * through the same `schemaFromDto` that documents request bodies
 * (`bodyDtoFor`) — a plain class, not a `toJSONSchema`-opted validator or the
 * `{ fields }` shorthand — so a class-validator-decorated response DTO's
 * array fields (plain `each: true` and `@ValidateNested({ each: true })`)
 * should translate identically on the response side, not just on requests.
 */
class TodoOutputDto {
  @IsString()
  title = "";

  @IsArray()
  @IsString({ each: true })
  tags: string[] = [];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddressDto)
  addresses: AddressDto[] = [];
}

describe("registerKavoSchemas — class-validator array fields on schema.output.item", () => {
  it("narrows a plain each:true array field on the response the same way it does on the request", async () => {
    @Kavo(Todo, { schema: { output: { item: TodoOutputDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const item = schemaNamed(document, "TodoItem");

    expect(item.properties.tags).toMatchObject({ type: "array", items: { type: "string" } });
  });

  it("expands a @ValidateNested({ each: true }) array field on the response into its nested DTO's own shape", async () => {
    @Kavo(Todo, { schema: { output: { item: TodoOutputDto } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const item = schemaNamed(document, "TodoItem");

    expect(item.properties.addresses).toMatchObject({
      type: "array",
      items: {
        type: "object",
        properties: { street: { type: "string", minLength: 1 }, city: { type: "string" } },
      },
    });
  });
});

describe("registerKavoSchemas — a `schema.input` field-array shorthand", () => {
  it("types createOne's body from ORM metadata, narrowed to exactly the bare-array field list", async () => {
    // The mirror of the `schema.output` shorthand test above (that test's
    // own doc comment: "the same way `bodyDtoFor` already does for the
    // equivalent `schema.input.create`/`update` shorthand") — pinned here in
    // its own right rather than only implied by that comment.
    @Kavo(Todo, { schema: { input: { create: ["title", "priority"] } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const schema = schemaNamed(document, "TodoCreate");

    expect(schema.properties.title).toMatchObject({ type: "string" });
    expect(schema.properties.priority).toMatchObject({ type: "number" });
    // Narrowed to exactly the shorthand's own field list — `done` is on
    // `Todo`'s own metadata and part of `creatable` by default, but
    // deliberately left off this shorthand, and must stay off the body.
    expect(schema.properties.done).toBeUndefined();
  });

  it("types updateOne's body the same way from the { fields } object spelling", async () => {
    @Kavo(Todo, { schema: { input: { update: { fields: ["title", "done"] } } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const schema = schemaNamed(document, "TodoUpdate");

    expect(schema.properties.title).toMatchObject({ type: "string" });
    expect(schema.properties.done).toMatchObject({ type: "boolean" });
    expect(schema.properties.priority).toBeUndefined();
  });
});

/**
 * A real Zod array field on a single-row response (`schema.output.item`),
 * as distinct from the list-envelope element case above — `successBodyFor`
 * takes a different branch for cardinality `"one"` than for `"many"`, so an
 * array-typed property needs its own pin on the non-list path too.
 */
describe("registerKavoSchemas — a real Zod array field on schema.output.item", () => {
  it("documents the array's own item type and validation keywords on a single-row response", async () => {
    const todoItemZodSchema = z.object({
      title: z.string(),
      tags: z.array(z.string().min(2).max(10)),
    });

    @Kavo(Todo, { schema: { output: { item: todoItemZodSchema } } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const item = schemaNamed(document, "TodoItem");

    expect(item.properties.tags).toMatchObject({
      type: "array",
      items: { type: "string", minLength: 2, maxLength: 10 },
    });
    expect(item.required).toEqual(expect.arrayContaining(["title", "tags"]));
  });
});

describe("registerKavoSchemas — a `schema.output` field-array shorthand", () => {
  it("types item/list properties from ORM metadata instead of documenting every field as `{}`", async () => {
    // The shorthand synthesizes a real `SchemaClass` (issue #386) whose
    // fields carry no runtime type of their own — every field is
    // `undefined` on a fresh instance — so `applyResponseSchemaDocs` must
    // treat it like "no registered output schema" and fall back to
    // `metadata.fields`, the same way `bodyDtoFor` already does for the
    // equivalent `schema.input.create`/`update` shorthand. Before that
    // fix, `title`/`priority`/`done` below all documented as `{}`.
    @Kavo(Todo, { schema: { output: ["id", "title", "priority", "done"] } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const item = schemaNamed(document, "TodoItem");

    expect(item.properties.title).toMatchObject({ type: "string" });
    expect(item.properties.priority).toMatchObject({ type: "number" });
    expect(item.properties.done).toMatchObject({ type: "boolean" });
    // Narrowed to exactly the shorthand's own field list — `deletedAt`
    // (on `Todo`'s own metadata, and part of `selectable` by default) is
    // deliberately left off the `output` shorthand and must stay off the
    // documented shape too.
    expect(item.properties.deletedAt).toBeUndefined();

    const list = schemaNamed(document, "TodoListItem");
    expect(list.properties.title).toMatchObject({ type: "string" });
    expect(list.properties.deletedAt).toBeUndefined();
  });

  it("still bails out for a hand-registered output class, leaving its own runtime-shape inference alone", async () => {
    class TodoItemDto {
      id = 0;
      title = "";
    }

    @Kavo(Todo, { schema: { output: TodoItemDto } })
    @Controller("todos")
    class TodosController {}

    const document = await createDocument([TodosController]);
    const item = schemaNamed(document, "TodoItem");

    // A real class's own runtime shape is authoritative — `done`/`priority`
    // (present on `Todo`'s metadata but not on `TodoItemDto`) must not
    // reappear via the metadata-driven fallback this class opted out of.
    expect(Object.keys(item.properties)).toEqual(["id", "title"]);
  });
});
