import { describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";

/**
 * A thin "Tag Endpoints" e2e suite. `Tag` is a small lookup table with one
 * validated string field — its own distinctive behavior is
 * `pagination: { strategy: "none" }` (issue #225), already exercised at
 * length by `crud-e2e.suite.ts` ("Tag: pagination.strategy 'none'"), so
 * this suite sticks to DTO validation and ordinary CRUD/error-contract
 * edge cases rather than repeating that.
 *
 * Parameterized by `getApp`, like the other entity suites.
 */
export function registerTagE2eSuite(getApp: () => INestApplication): void {
  function server(): SupertestTarget {
    return boundServer(getApp().getHttpServer() as SupertestTarget);
  }

  let tagCounter = 0;
  function nextTag(): number {
    tagCounter += 1;
    return tagCounter;
  }

  describe("Tag Endpoints (e2e)", () => {
    describe("POST /tags validation", () => {
      it("rejects an empty name", async () => {
        await request(server()).post("/tags").send({ name: "" }).expect(400);
      });

      it("rejects a missing name", async () => {
        await request(server()).post("/tags").send({}).expect(400);
      });

      it("accepts a valid name", async () => {
        const created = await request(server())
          .post("/tags")
          .send({ name: `Friendly-${nextTag()}` })
          .expect(201);
        expect(created.body.name).toMatch(/^Friendly-/);
      });
    });

    describe("CRUD lifecycle", () => {
      it("creates, reads, updates, and deletes a tag", async () => {
        const tag = nextTag();
        const created = await request(server())
          .post("/tags")
          .send({ name: `Lifecycle-${tag}` })
          .expect(201);
        const id = created.body.id as number;

        await request(server()).get(`/tags/${id}`).expect(200);
        const updated = await request(server())
          .put(`/tags/${id}`)
          .send({ name: `Renamed-${tag}` })
          .expect(200);
        expect(updated.body.name).toBe(`Renamed-${tag}`);

        const patched = await request(server())
          .patch(`/tags/${id}`)
          .send({ name: `Patched-${tag}` })
          .expect(200);
        expect(patched.body.name).toBe(`Patched-${tag}`);

        await request(server()).delete(`/tags/${id}`).expect(204);
        await request(server()).get(`/tags/${id}`).expect(404);
      });

      it("rejects an empty name on PATCH", async () => {
        const created = await request(server())
          .post("/tags")
          .send({ name: `PatchEmpty-${nextTag()}` })
          .expect(201);
        await request(server())
          .patch(`/tags/${created.body.id as number}`)
          .send({ name: "" })
          .expect(400);
      });
    });

    describe("Error contract", () => {
      it("returns 404 for a non-existent tag", async () => {
        await request(server()).get("/tags/999999").expect(404);
      });

      it("returns 400 for a malformed id", async () => {
        await request(server()).get("/tags/not-a-number").expect(400);
      });
    });
  });
}
