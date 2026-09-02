import { describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";

/**
 * A "PetTag Endpoints" e2e suite sized to what's distinctive about
 * `PetTagController` — a composite-primary-key entity (ADR-0039, issue
 * #267): `petId`/`tagId` are the whole primary key, so every route
 * addresses a row by `:petId~:tagId` (one path segment, `~`-joined)
 * instead of a single numeric `:id`, and the key is immutable after
 * create. The ordinary lifecycle (including `note`'s trim-then-validate
 * step) is already `crud-e2e.suite.ts`'s subject; this suite covers the
 * composite-id-specific edges: duplicate-key conflicts, malformed
 * composite ids, and a foreign-key violation on a nonexistent pet/tag.
 *
 * Parameterized by `getApp`, like the other entity suites.
 */
export function registerPetTagE2eSuite(getApp: () => INestApplication): void {
  function server(): SupertestTarget {
    return boundServer(getApp().getHttpServer() as SupertestTarget);
  }

  let tagCounter = 0;
  function nextTag(): number {
    tagCounter += 1;
    return tagCounter;
  }

  async function createPet(): Promise<number> {
    const response = await request(server())
      .post("/cats")
      .send({ name: `PetTagCat-${nextTag()}`, age: 1, size: "small", indoor: true, livesLeft: 9 })
      .expect(201);
    return response.body.id as number;
  }

  async function createTag(): Promise<number> {
    const response = await request(server())
      .post("/tags")
      .send({ name: `PetTagLabel-${nextTag()}` })
      .expect(201);
    return response.body.id as number;
  }

  describe("PetTag Endpoints (e2e)", () => {
    describe("Composite-key routing", () => {
      it("addresses a row by :petId~:tagId, distinct from either id alone", async () => {
        const petId = await createPet();
        const tagId = await createTag();
        await request(server()).post("/pet-tags").send({ petId, tagId, note: "collar" }).expect(201);

        const fetched = await request(server()).get(`/pet-tags/${petId}~${tagId}`).expect(200);
        expect(fetched.body).toMatchObject({ petId, tagId, note: "collar" });
      });

      it("returns 404 for a well-formed but nonexistent composite id", async () => {
        await request(server()).get("/pet-tags/999999~999999").expect(404);
      });

      it("returns 400 for a malformed composite id (missing the ~ separator)", async () => {
        await request(server()).get("/pet-tags/123").expect(400);
      });
    });

    describe("Duplicate key", () => {
      it("creating the same petId/tagId pair twice upserts rather than conflicting — TypeORM's save() treats a fully-keyed entity as a write, not an insert-only create", async () => {
        const petId = await createPet();
        const tagId = await createTag();
        await request(server()).post("/pet-tags").send({ petId, tagId, note: "first" }).expect(201);
        const second = await request(server()).post("/pet-tags").send({ petId, tagId, note: "second" }).expect(201);
        expect(second.body).toMatchObject({ petId, tagId, note: "second" });

        const fetched = await request(server()).get(`/pet-tags/${petId}~${tagId}`).expect(200);
        expect(fetched.body.note).toBe("second");
      });
    });

    describe("Foreign key validity", () => {
      it("rejects a petId that does not reference an existing pet, as a 422 (the DB's own FK constraint, not a shape error)", async () => {
        const tagId = await createTag();
        const response = await request(server())
          .post("/pet-tags")
          .send({ petId: 999999, tagId, note: "orphan" })
          .expect(422);
        expect(response.body).toMatchObject({ status: 422, code: "KAVO_UNRESOLVED_RELATION" });
      });

      it("rejects a tagId that does not reference an existing tag, as a 422", async () => {
        const petId = await createPet();
        await request(server()).post("/pet-tags").send({ petId, tagId: 999999, note: "orphan" }).expect(422);
      });
    });

    describe("The composite key is immutable after create", () => {
      it("PUT does not accept petId/tagId in the body — only note is writable", async () => {
        const petId = await createPet();
        const tagId = await createTag();
        await request(server()).post("/pet-tags").send({ petId, tagId, note: "original" }).expect(201);

        const otherPetId = await createPet();
        const updated = await request(server())
          .put(`/pet-tags/${petId}~${tagId}`)
          .send({ petId: otherPetId, note: "updated" })
          .expect(200);
        // The route id still addresses the original pair — petId in the
        // body is silently not part of the writable projection.
        expect(updated.body).toMatchObject({ petId, tagId, note: "updated" });
      });
    });

    describe("note validation", () => {
      it("rejects an empty note", async () => {
        const petId = await createPet();
        const tagId = await createTag();
        await request(server()).post("/pet-tags").send({ petId, tagId, note: "" }).expect(400);
      });

      it("trims a whitespace-padded note before persisting", async () => {
        const petId = await createPet();
        const tagId = await createTag();
        const created = await request(server())
          .post("/pet-tags")
          .send({ petId, tagId, note: "  padded  " })
          .expect(201);
        expect(created.body.note).toBe("padded");
      });
    });
  });
}
