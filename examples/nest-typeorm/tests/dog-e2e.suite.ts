import { describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";

/**
 * A cohesive "Dog Endpoints" e2e suite, sized to what's distinctive about
 * `DogController` (`dog.controller.ts`) among this app's entities:
 *
 * - **zero-config**: `@Kavo(Dog)` with no options — root default pagination
 *   (limit 20 / max 100), every standard operation on, entity-derived DTOs
 *   (no `class-validator` decorators at all, unlike Cat/Owner).
 * - **single-table inheritance isolation**: Dog and Cat share one physical
 *   `pet` table (`@TableInheritance` on `pet.entity.ts`) — `/dogs` must
 *   never surface a `/cats`-created row and vice versa.
 * - the JSON `attributes` column's own round-trip and not-filterable rules.
 *
 * `crud-e2e.suite.ts` already covers the JSON column and entity-derived-DTO
 * fallback in some depth (search "Dog.attributes" there); this suite adds
 * STI isolation, pagination defaults, the default-on ETag/precondition
 * contract (Dog takes no `cache` override, unlike Owner), and the error
 * contract, rather than repeating that coverage.
 *
 * Parameterized by `getApp`, like the other entity suites, to run on both
 * SQLite and a real Postgres off whichever app the caller bootstrapped.
 */
export function registerDogE2eSuite(getApp: () => INestApplication): void {
  function server(): SupertestTarget {
    return boundServer(getApp().getHttpServer() as SupertestTarget);
  }

  let tagCounter = 0;
  function nextTag(): number {
    tagCounter += 1;
    return tagCounter;
  }

  const VALID_DOG = { name: "Rex", age: 4, size: "medium", breed: "Labrador", goodBoy: true };

  async function createDog(overrides: Record<string, unknown> = {}): Promise<{ id: number; etag: string }> {
    const response = await request(server())
      .post("/dogs")
      .send({ ...VALID_DOG, ...overrides })
      .expect(201);
    return { id: response.body.id as number, etag: response.headers.etag as string };
  }

  describe("Dog Endpoints (e2e)", () => {
    describe("CRUD lifecycle", () => {
      it("creates, reads, updates, and deletes a dog", async () => {
        const tag = nextTag();
        const created = await request(server())
          .post("/dogs")
          .send({ ...VALID_DOG, name: `Lifecycle-${tag}` })
          .expect(201);
        expect(created.body).toMatchObject({ name: `Lifecycle-${tag}`, breed: "Labrador", goodBoy: true });
        const id = created.body.id as number;

        await request(server())
          .put(`/dogs/${id}`)
          .send({ ...VALID_DOG, name: `Renamed-${tag}`, goodBoy: false })
          .expect(200);

        const patched = await request(server()).patch(`/dogs/${id}`).send({ goodBoy: true }).expect(200);
        expect(patched.body).toMatchObject({ name: `Renamed-${tag}`, goodBoy: true });

        await request(server()).delete(`/dogs/${id}`).expect(204);
        await request(server()).get(`/dogs/${id}`).expect(404);
      });
    });

    describe("Single-table inheritance isolation", () => {
      it("a dog created via /dogs never appears in /cats", async () => {
        const tag = nextTag();
        const { id } = await createDog({ name: `Isolated-${tag}` });
        await request(server()).get(`/cats/${id}`).expect(404);
        const catList = await request(server()).get("/cats").query({ "filter[name][eq]": `Isolated-${tag}` });
        expect(catList.body.items).toEqual([]);
      });

      it("a cat created via /cats never appears in /dogs", async () => {
        const tag = nextTag();
        const created = await request(server())
          .post("/cats")
          .send({ name: `CatOnly-${tag}`, age: 1, size: "small", indoor: true, livesLeft: 9 })
          .expect(201);
        const id = created.body.id as number;
        await request(server()).get(`/dogs/${id}`).expect(404);
        const dogList = await request(server()).get("/dogs").query({ "filter[name][eq]": `CatOnly-${tag}` });
        expect(dogList.body.items).toEqual([]);
      });

      it("does not include species or a discriminator field in the response", async () => {
        const { id } = await createDog({ name: `NoSpecies-${nextTag()}` });
        const fetched = await request(server()).get(`/dogs/${id}`).expect(200);
        expect(fetched.body).not.toHaveProperty("species");
      });
    });

    describe("JSON attributes column", () => {
      it("round-trips a nested object unchanged", async () => {
        const attributes = { color: "brown", tricks: ["sit", "stay"], nested: { weight: 30 } };
        const created = await request(server())
          .post("/dogs")
          .send({ ...VALID_DOG, name: `Json-${nextTag()}`, attributes })
          .expect(201);
        expect(created.body.attributes).toEqual(attributes);
      });

      it("accepts attributes omitted (defaults to null)", async () => {
        const created = await request(server())
          .post("/dogs")
          .send({ ...VALID_DOG, name: `JsonNull-${nextTag()}` })
          .expect(201);
        expect(created.body.attributes).toBeNull();
      });

      it("rejects filtering on the json attributes column", async () => {
        await request(server()).get("/dogs").query({ "filter[attributes][eq]": "x" }).expect(400);
      });
    });

    describe("GET /dogs (list) — zero-config defaults", () => {
      it("applies the root default limit of 20 when limit is omitted", async () => {
        const response = await request(server())
          .get("/dogs")
          .query({ "filter[name][eq]": "__never_matches__" })
          .expect(200);
        expect(response.body.limit).toBe(20);
      });

      it("clamps a limit above the root max of 100 instead of rejecting it", async () => {
        const response = await request(server()).get("/dogs").query({ limit: 1000 }).expect(200);
        expect(response.body.limit).toBe(100);
      });

      it("rejects an unknown sort field", async () => {
        await request(server()).get("/dogs").query({ sort: "notAField" }).expect(400);
      });

      it("filters by breed", async () => {
        const tag = nextTag();
        await createDog({ name: `Poodle-${tag}`, breed: "Poodle" });
        const response = await request(server())
          .get("/dogs")
          .query({ "filter[breed][eq]": "Poodle", "filter[name][eq]": `Poodle-${tag}` })
          .expect(200);
        expect(response.body.items).toHaveLength(1);
      });
    });

    describe("Error contract", () => {
      it("returns an RFC 9457 problem-details body for a 404", async () => {
        const response = await request(server())
          .get("/dogs/999999")
          .expect(404)
          .expect("Content-Type", /application\/problem\+json/);
        expect(response.body).toMatchObject({ code: "KAVO_NOT_FOUND", status: 404 });
      });

      it("returns 404 for a DELETE on a non-existent id", async () => {
        await request(server()).delete("/dogs/999999").expect(404);
      });

      it("returns 400 for a malformed id", async () => {
        await request(server()).get("/dogs/not-a-number").expect(400);
      });
    });

    describe("Conditional requests (ETag) — default on, unlike Owner", () => {
      it("serves an ETag on a single-item GET", async () => {
        const { id } = await createDog({ name: `Etag-${nextTag()}` });
        const response = await request(server()).get(`/dogs/${id}`).expect(200);
        expect(response.headers.etag).toBeDefined();
      });

      it("returns 304 for a GET with a matching If-None-Match", async () => {
        const { id, etag } = await createDog({ name: `Etag304-${nextTag()}` });
        await request(server()).get(`/dogs/${id}`).set("If-None-Match", etag).expect(304);
      });

      it("returns 412 for a PATCH with a stale If-Match", async () => {
        const { id, etag } = await createDog({ name: `Stale-${nextTag()}` });
        await request(server()).patch(`/dogs/${id}`).send({ goodBoy: false }).expect(200);
        const response = await request(server())
          .patch(`/dogs/${id}`)
          .set("If-Match", etag)
          .send({ goodBoy: true })
          .expect(412);
        expect(response.body).toMatchObject({ code: "KAVO_PRECONDITION_FAILED" });
      });
    });

    describe("Mass assignment", () => {
      it("ignores a client-supplied id on create", async () => {
        const created = await request(server())
          .post("/dogs")
          .send({ ...VALID_DOG, name: `IdSpoof-${nextTag()}`, id: 999999 })
          .expect(201);
        expect(created.body.id).not.toBe(999999);
      });

      it("ignores a client-supplied createdAt on create", async () => {
        const created = await request(server())
          .post("/dogs")
          .send({ ...VALID_DOG, name: `CreatedAtSpoof-${nextTag()}`, createdAt: "2000-01-01T00:00:00.000Z" })
          .expect(201);
        expect(created.body.createdAt).not.toBe("2000-01-01T00:00:00.000Z");
      });
    });
  });
}
