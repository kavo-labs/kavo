import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNegative,
  IsNumber,
  IsOptional,
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
