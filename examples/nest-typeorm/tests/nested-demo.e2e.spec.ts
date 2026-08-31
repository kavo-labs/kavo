import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { registerKavoSchemas } from "@kavo/nest";
import request from "supertest";
import { AppModule } from "../src/app.module.js";

/**
 * The `Region → Zone → Landmark` chain (`src/nested-demo/`) exists to show
 * issue #356's recursive `$ref` schema composition: no controller registers
 * an item DTO and none sets a relation-dotted `selectable` ceiling, so every
 * includable relation is emitted as a `$ref` to its target's own
 * `<Entity>Item` component. This spec pins that in the generated document and
 * checks the runtime response actually matches the advertised shape.
 */

type Schema = {
  $ref?: string;
  type?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
};
type Document = {
  components?: { schemas?: Record<string, Schema> };
  paths: Record<
    string,
    Record<string, { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> }> | undefined
  >;
};

let app: INestApplication;
let document: Document;

const collectRefs = (node: unknown, acc: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectRefs(child, acc);
    }
    return acc;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        acc.push(value);
      } else {
        collectRefs(value, acc);
      }
    }
  }
  return acc;
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot()] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  document = registerKavoSchemas(
    SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("t").setVersion("0").build()),
  ) as unknown as Document;
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
});

describe("nested includable-relation $ref composition in the Pet example (issue #356)", () => {
  const schemas = (): Record<string, Schema> => document.components?.schemas ?? {};

  it("composes RegionItem → ZoneItem → LandmarkItem by $ref", () => {
    expect(schemas().RegionItem?.properties?.zones).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/ZoneItem" },
    });
    expect(schemas().ZoneItem?.properties?.landmarks).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/LandmarkItem" },
    });
    expect(schemas().LandmarkItem?.properties?.zone).toEqual({ $ref: "#/components/schemas/ZoneItem" });
  });

  it("emits the Zone ↔ Region cycle as a mutual $ref, still a valid document", () => {
    expect(schemas().ZoneItem?.properties?.region).toEqual({ $ref: "#/components/schemas/RegionItem" });
    // RegionItem.zones → ZoneItem.region → RegionItem — a cycle in the
    // component graph, legal OpenAPI 3.x.
    const names = new Set(Object.keys(schemas()));
    const dangling = collectRefs(document).filter((ref) => !names.has(ref.replace("#/components/schemas/", "")));
    expect(dangling).toEqual([]);
  });

  it("keeps the relation properties optional (never in required)", () => {
    expect(schemas().RegionItem?.required ?? []).not.toContain("zones");
    expect(schemas().ZoneItem?.required ?? []).not.toContain("region");
  });

  it("returns a nested tree over include=zones.landmarks that matches the advertised shape", async () => {
    const server = app.getHttpServer();
    const region = await request(server).post("/regions").send({ name: "North" }).expect(201);
    const zone = await request(server)
      .post("/zones")
      .send({ name: "N-1", region: { id: region.body.id } })
      .expect(201);
    await request(server)
      .post("/landmarks")
      .send({ name: "Tower", zone: { id: zone.body.id } })
      .expect(201);

    const fetched = await request(server).get(`/regions/${region.body.id}?include=zones.landmarks`).expect(200);
    expect(fetched.body).toMatchObject({
      id: region.body.id,
      name: "North",
      zones: [{ name: "N-1", landmarks: [{ name: "Tower" }] }],
    });
  });
});
