import "reflect-metadata";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { KAVO_API_GUIDE, registerKavoSchemas } from "@kavo/nest";
import { AppModule } from "../src/app.module.js";

/**
 * `src/main.ts` now wraps its `SwaggerModule.createDocument(...)` in
 * `registerKavoSchemas` (issue #310), so the served `/docs-json` carries
 * named `components.schemas` entries instead of anonymous inline objects.
 *
 * This spec rebuilds the same document and asserts it for `Dog` — the one
 * `@Kavo(Dog)` controller with **no `dto` block at all**, so every schema it
 * gets is synthesized from the entity's own TypeORM columns at bind time
 * (issue #264) and then hoisted. It also writes `swagger.json` next to the
 * package, a git-ignored artifact regenerated on every `pnpm test` run.
 */

type Schema = {
  $ref?: string;
  properties?: Record<string, unknown>;
  allOf?: { $ref?: string }[];
  "x-kavo-entity"?: string;
};
type Operation = {
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};
type Document = {
  components?: { schemas?: Record<string, Schema> };
  paths: Record<string, Record<string, Operation> | undefined>;
};

let app: INestApplication;
let document: Document;

const bodySchema = (path: string, verb: string): Schema | undefined =>
  document.paths[path]?.[verb]?.requestBody?.content?.["application/json"]?.schema;
const responseSchema = (path: string, verb: string, status: string): Schema | undefined =>
  document.paths[path]?.[verb]?.responses?.[status]?.content?.["application/json"]?.schema;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  document = registerKavoSchemas(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("Kavo — Pet example").setDescription(KAVO_API_GUIDE).setVersion("0.0.0").build(),
    ),
  ) as unknown as Document;

  writeFileSync(fileURLToPath(new URL("../swagger.json", import.meta.url)), `${JSON.stringify(document, null, 2)}\n`);
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
});

describe("registerKavoSchemas wired into the Pet example (issue #310)", () => {
  const schemas = (): Record<string, Schema> => document.components?.schemas ?? {};

  it("names a full component family for Dog, which declares no dto block", () => {
    for (const name of [
      "DogCreate",
      "DogUpdate",
      "DogPatch",
      "DogItem",
      "DogList",
      "DogListItem",
      "DogListMeta",
      "DogValidationError",
    ]) {
      expect(schemas()[name], name).toBeDefined();
    }
    // The create body is synthesized from Dog's own columns (issue #264),
    // narrowed to `creatable`, and still carries the entity link.
    const create = schemas().DogCreate;
    expect(create?.["x-kavo-entity"]).toBe("Dog");
    expect(Object.keys(create?.properties ?? {})).toEqual(expect.arrayContaining(["breed", "goodBoy", "attributes"]));
  });

  it("$refs the Dog routes at those components instead of inlining them", () => {
    expect(bodySchema("/dogs", "post")).toEqual({ $ref: "#/components/schemas/DogCreate" });
    expect(responseSchema("/dogs", "post", "201")).toEqual({ $ref: "#/components/schemas/DogItem" });
    expect(responseSchema("/dogs", "post", "400")).toEqual({ $ref: "#/components/schemas/DogValidationError" });
    expect(responseSchema("/dogs", "get", "200")).toEqual({ $ref: "#/components/schemas/DogList" });
    expect(schemas().DogList?.properties?.items).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/DogListItem" },
    });
  });

  it("retags Dog's 400 as an allOf over the shared KavoProblemDetails", () => {
    expect(schemas().KavoProblemDetails).toBeDefined();
    expect(schemas().KavoProblemDetailError).toBeDefined();
    expect(schemas().DogValidationError?.allOf).toEqual([{ $ref: "#/components/schemas/KavoProblemDetails" }]);
    expect(responseSchema("/dogs/{id}", "get", "404")).toEqual({ $ref: "#/components/schemas/KavoProblemDetails" });
  });

  it("leaves no inline Kavo DTO schema anywhere in the document", () => {
    const offenders: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [verb, op] of Object.entries(item ?? {})) {
        const candidates: (Schema | undefined)[] = [
          op.requestBody?.content?.["application/json"]?.schema,
          ...Object.values(op.responses ?? {}).map((r) => r.content?.["application/json"]?.schema),
        ];
        for (const schema of candidates) {
          if (schema?.["x-kavo-entity"] !== undefined && schema.$ref === undefined) {
            offenders.push(`${verb.toUpperCase()} ${path}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
