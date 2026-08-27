import { describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";

/**
 * A thin "Photo Endpoints" e2e suite. `Photo` is a small lookup table with
 * one validated string field (`url`, deliberately a plain non-empty string
 * rather than `@IsUrl()` — see `photo.dtos.ts`'s own comment, since this
 * reference app stores relative paths too). Its many-to-many array-mutation
 * behavior on `Cat` (`GET/POST/DELETE/PUT /cats/:id/photos`) is already
 * `crud-e2e.suite.ts`'s subject; this suite sticks to `/photos` itself.
 *
 * Parameterized by `getApp`, like the other entity suites.
 */
export function registerPhotoE2eSuite(getApp: () => INestApplication): void {
  function server(): SupertestTarget {
    return boundServer(getApp().getHttpServer() as SupertestTarget);
  }

  let tagCounter = 0;
  function nextTag(): number {
    tagCounter += 1;
    return tagCounter;
  }

  describe("Photo Endpoints (e2e)", () => {
    describe("POST /photos validation", () => {
      it("rejects an empty url", async () => {
        await request(server()).post("/photos").send({ url: "" }).expect(400);
      });

      it("rejects a missing url", async () => {
        await request(server()).post("/photos").send({}).expect(400);
      });

      it("accepts a relative path, not just an absolute URL (url is a plain non-empty string, not @IsUrl())", async () => {
        const created = await request(server())
          .post("/photos")
          .send({ url: `/uploads/photo-${nextTag()}.jpg` })
          .expect(201);
        expect(created.body.url).toMatch(/^\/uploads\//);
      });
    });

    describe("CRUD lifecycle", () => {
      it("creates, reads, updates, and deletes a photo", async () => {
        const tag = nextTag();
        const created = await request(server())
          .post("/photos")
          .send({ url: `https://example.com/${tag}.jpg` })
          .expect(201);
        const id = created.body.id as number;

        await request(server()).get(`/photos/${id}`).expect(200);
        const updated = await request(server())
          .put(`/photos/${id}`)
          .send({ url: `https://example.com/renamed-${tag}.jpg` })
          .expect(200);
        expect(updated.body.url).toBe(`https://example.com/renamed-${tag}.jpg`);

        await request(server()).delete(`/photos/${id}`).expect(204);
        await request(server()).get(`/photos/${id}`).expect(404);
      });
    });

    describe("Error contract", () => {
      it("returns 404 for a non-existent photo", async () => {
        await request(server()).get("/photos/999999").expect(404);
      });

      it("returns 400 for a malformed id", async () => {
        await request(server()).get("/photos/not-a-number").expect(400);
      });
    });
  });
}
