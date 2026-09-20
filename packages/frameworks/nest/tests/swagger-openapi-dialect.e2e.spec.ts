import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Kavo, KavoModule, registerKavoSchemas } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";

/**
 * `registerKavoSchemas`'s new dialect-upgrade pass (`openapi-dialect.ts`)
 * only runs when `document.openapi` declares 3.1 or 3.2 — these pin the
 * full pipeline end to end, through a real `@Kavo`-decorated controller and
 * a real `DocumentBuilder.setOpenAPIVersion` call, rather than only the
 * pure-function unit tests in `openapi-dialect.spec.ts`.
 */

const apps: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createDocument(openapiVersion?: string): Promise<Record<string, unknown>> {
  @Kavo(Todo, {})
  @Controller("todos")
  class TodosController {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) }),
      KavoModule.forFeature([TodosController]),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  apps.push(app);
  await app.init();

  const builder = new DocumentBuilder().setTitle("t").setVersion("0");
  if (openapiVersion !== undefined) {
    builder.setOpenAPIVersion(openapiVersion);
  }
  const document = registerKavoSchemas(SwaggerModule.createDocument(app, builder.build()));
  return document as unknown as Record<string, unknown>;
}

function schemaNamed(document: Record<string, unknown>, name: string): Record<string, unknown> {
  const schemas = (document.components as { schemas?: Record<string, unknown> }).schemas ?? {};
  return schemas[name] as Record<string, unknown>;
}

describe("registerKavoSchemas — OpenAPI 3.1/3.2 dialect upgrade", () => {
  it("leaves nullable: true untouched when no openapi version is set (today's 3.0 default)", async () => {
    const document = await createDocument();
    const item = schemaNamed(document, "TodoItem") as { properties: Record<string, Record<string, unknown>> };

    expect(item.properties.deletedAt).toMatchObject({ type: "string", format: "date-time", nullable: true });
  });

  it("leaves nullable: true untouched under an explicit 3.0.0", async () => {
    const document = await createDocument("3.0.0");
    const item = schemaNamed(document, "TodoItem") as { properties: Record<string, Record<string, unknown>> };

    expect(item.properties.deletedAt).toMatchObject({ type: "string", format: "date-time", nullable: true });
  });

  it("upgrades nullable: true to a type union under 3.1.0", async () => {
    const document = await createDocument("3.1.0");
    const item = schemaNamed(document, "TodoItem") as { properties: Record<string, Record<string, unknown>> };

    expect(item.properties.deletedAt).toEqual({ type: ["string", "null"], format: "date-time" });
  });

  it("upgrades nullable: true to a type union under 3.2.0 identically to 3.1.0", async () => {
    const document = await createDocument("3.2.0");
    const item = schemaNamed(document, "TodoItem") as { properties: Record<string, Record<string, unknown>> };

    expect(item.properties.deletedAt).toEqual({ type: ["string", "null"], format: "date-time" });
  });

  it("upgrades the shared KavoProblemDetails schema's example fields to examples arrays under 3.1.0", async () => {
    const document = await createDocument("3.1.0");
    const problemDetails = schemaNamed(document, "KavoProblemDetails") as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(problemDetails.properties.type).toMatchObject({ examples: ["https://kavo.dev/errors/kavo-not-found"] });
    expect(problemDetails.properties.type!.example).toBeUndefined();
    expect(problemDetails.properties.code).toMatchObject({ examples: ["KAVO_NOT_FOUND"] });
  });

  it("leaves KavoProblemDetails's example fields as-is under 3.0.0", async () => {
    const document = await createDocument("3.0.0");
    const problemDetails = schemaNamed(document, "KavoProblemDetails") as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(problemDetails.properties.type).toMatchObject({ example: "https://kavo.dev/errors/kavo-not-found" });
  });
});
