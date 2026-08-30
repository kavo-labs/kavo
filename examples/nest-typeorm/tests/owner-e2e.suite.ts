import { describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";

/**
 * A cohesive "Owner Endpoints" e2e suite, sized to what `OwnerController`
 * (`owner.controller.ts`) does that no other entity in this app does:
 *
 * - **policy** — `deleteOne` requires the `owner:delete` permission
 *   (ADR-0037), enforced through `OwnerAppContextGuard` reading a real
 *   `x-permissions` header, over real HTTP. The deeper policy contract
 *   (ownership, 404-beats-403, the soft-delete pre-fetch) is already
 *   `policy.e2e.spec.ts`'s entire subject against a purpose-built entity —
 *   this suite only confirms Owner's own one-line `hasPermission` gate.
 * - **soft delete** — `DELETE /owners/:id` stamps `deletedAt` rather than
 *   removing the row; `restoreOne`/`purgeOne` opt back in over
 *   `AppModule`'s app-wide `operations.restoreOne: false` default.
 * - **the unique `email` index** — a soft-deleted owner still occupies it
 *   (a caveat the controller's own doc comment calls out), so recreating
 *   one with the same email 409s.
 * - **no ETag** — `cache: { etag: false }` on `OwnerController`, unlike
 *   Cat's default-on caching (`cat-e2e.suite.ts`), so this suite asserts
 *   the *absence* of the header rather than the conditional-request
 *   contract.
 *
 * Ordinary CRUD lifecycle, envelope shape, and problem-details format are
 * `crud-e2e.suite.ts`'s job and are not repeated here.
 *
 * Parameterized by `getApp`, like `cat-e2e.suite.ts`, so it runs unchanged
 * against SQLite and a real Postgres, sharing whichever app/database the
 * caller already bootstrapped.
 */
export function registerOwnerE2eSuite(getApp: () => INestApplication): void {
  function server(): SupertestTarget {
    return boundServer(getApp().getHttpServer() as SupertestTarget);
  }

  let tagCounter = 0;
  function nextTag(): number {
    tagCounter += 1;
    return tagCounter;
  }

  function email(tag: number): string {
    return `owner-${tag}@example.com`;
  }

  async function createOwner(overrides: Record<string, unknown> = {}): Promise<{ id: number; email: string }> {
    const tag = nextTag();
    const body = { name: `Owner-${tag}`, email: email(tag), ...overrides };
    const response = await request(server()).post("/owners").send(body).expect(201);
    return { id: response.body.id as number, email: body.email as string };
  }

  const withPermission = (permissions: string) => ({ "x-permissions": permissions });

  describe("Owner Endpoints (e2e)", () => {
    describe("Write operation policy (deleteOne only)", () => {
      it("rejects DELETE /owners/:id without the owner:delete permission", async () => {
        const { id } = await createOwner();
        const response = await request(server()).delete(`/owners/${id}`).expect(403);
        expect(response.body).toMatchObject({ code: "KAVO_FORBIDDEN", status: 403 });
      });

      it("rejects DELETE /owners/:id with an unrelated permission", async () => {
        const { id } = await createOwner();
        await request(server()).delete(`/owners/${id}`).set(withPermission("owner:read")).expect(403);
      });

      it("allows DELETE /owners/:id with the owner:delete permission", async () => {
        const { id } = await createOwner();
        await request(server()).delete(`/owners/${id}`).set(withPermission("owner:delete")).expect(204);
      });

      it("does not gate createOne, updateOne, patchOne, or findOne — only deleteOne carries a policy", async () => {
        const created = await request(server())
          .post("/owners")
          .send({ name: "Open", email: email(nextTag()) });
        expect(created.status).toBe(201);
        const id = created.body.id as number;
        await request(server()).get(`/owners/${id}`).expect(200);
        await request(server())
          .put(`/owners/${id}`)
          .send({ name: "Still open", email: created.body.email })
          .expect(200);
        await request(server()).patch(`/owners/${id}`).send({ name: "Patched" }).expect(200);
      });
    });

    describe("Soft delete, restore, purge", () => {
      it("DELETE stamps deletedAt instead of removing the row — findOne 404s but the row survives underneath", async () => {
        const { id } = await createOwner();
        await request(server()).delete(`/owners/${id}`).set(withPermission("owner:delete")).expect(204);
        await request(server()).get(`/owners/${id}`).expect(404);
      });

      it("excludes a soft-deleted owner from list results", async () => {
        const { id } = await createOwner();
        await request(server()).delete(`/owners/${id}`).set(withPermission("owner:delete")).expect(204);
        const list = await request(server()).get("/owners").query({ "filter[id][eq]": id }).expect(200);
        expect(list.body.items).toEqual([]);
      });

      it("restoreOne opts back in over AppModule's app-wide operations.restoreOne: false default", async () => {
        const { id } = await createOwner();
        await request(server()).delete(`/owners/${id}`).set(withPermission("owner:delete")).expect(204);
        const restored = await request(server()).patch(`/owners/${id}/restore`).expect(200);
        expect(restored.body).toMatchObject({ id });
        await request(server()).get(`/owners/${id}`).expect(200);
      });

      it("rejects restoring an owner that was never deleted (nothing to restore, not a missing row)", async () => {
        const { id } = await createOwner();
        const response = await request(server()).patch(`/owners/${id}/restore`).expect(409);
        expect(response.body).toMatchObject({ status: 409 });
      });

      it("purgeOne removes the row for good — a restore after purge 404s", async () => {
        const { id } = await createOwner();
        await request(server()).delete(`/owners/${id}`).set(withPermission("owner:delete")).expect(204);
        await request(server()).delete(`/owners/${id}/purge`).expect(204);
        await request(server()).patch(`/owners/${id}/restore`).expect(404);
      });
    });

    describe("Unique email index", () => {
      it("maps a duplicate email on create to a 409 conflict", async () => {
        const { email: existingEmail } = await createOwner();
        const response = await request(server())
          .post("/owners")
          .send({ name: "Duplicate", email: existingEmail })
          .expect(409);
        expect(response.body).toMatchObject({ status: 409 });
      });

      it("a soft-deleted owner still occupies the unique index — recreating the same email still 409s", async () => {
        const { id, email: existingEmail } = await createOwner();
        await request(server()).delete(`/owners/${id}`).set(withPermission("owner:delete")).expect(204);
        await request(server()).post("/owners").send({ name: "Reincarnated", email: existingEmail }).expect(409);
      });

      it("maps a duplicate email on PUT to a 409 conflict", async () => {
        const a = await createOwner();
        const b = await createOwner();
        await request(server()).put(`/owners/${b.id}`).send({ name: "Taken", email: a.email }).expect(409);
      });
    });

    describe("POST /owners validation", () => {
      it("rejects an empty name", async () => {
        await request(server())
          .post("/owners")
          .send({ name: "", email: email(nextTag()) })
          .expect(400);
      });

      it("rejects a malformed email", async () => {
        await request(server()).post("/owners").send({ name: "Bad Email", email: "not-an-email" }).expect(400);
      });

      it("rejects a missing email", async () => {
        await request(server()).post("/owners").send({ name: "No Email" }).expect(400);
      });

      it("rejects a non-ISO8601 startedAt", async () => {
        await request(server())
          .post("/owners")
          .send({ name: "Bad Date", email: email(nextTag()), startedAt: "not-a-date" })
          .expect(400);
      });

      it("accepts a valid ISO8601 startedAt", async () => {
        const tag = nextTag();
        const created = await request(server())
          .post("/owners")
          .send({ name: "Good Date", email: email(tag), startedAt: "2024-01-01T00:00:00.000Z" })
          .expect(201);
        expect(created.body.startedAt).toBeDefined();
      });

      it("rejects a bare scalar address id instead of an { id } reference (issue #291)", async () => {
        await request(server())
          .post("/owners")
          .send({ name: "Bad Ref", email: email(nextTag()), address: 1 })
          .expect(400);
      });

      it("accepts startedAt omitted (defaults to null)", async () => {
        const created = await request(server())
          .post("/owners")
          .send({ name: "No Start", email: email(nextTag()) })
          .expect(201);
        expect(created.body.startedAt).toBeNull();
      });
    });

    describe("PATCH /owners/:id (partial update)", () => {
      it("updates only the field(s) provided, leaving the rest untouched", async () => {
        const { id, email: originalEmail } = await createOwner({ name: "Original" });
        const patched = await request(server()).patch(`/owners/${id}`).send({ name: "Patched" }).expect(200);
        expect(patched.body).toMatchObject({ name: "Patched", email: originalEmail });
      });

      it("rejects an empty string name on patch (still validated, just optional)", async () => {
        const { id } = await createOwner();
        await request(server()).patch(`/owners/${id}`).send({ name: "" }).expect(400);
      });

      it("rejects a malformed email on patch", async () => {
        const { id } = await createOwner();
        await request(server()).patch(`/owners/${id}`).send({ email: "not-an-email" }).expect(400);
      });

      it("strips unknown fields from a patch body instead of persisting or rejecting them", async () => {
        const { id } = await createOwner();
        const patched = await request(server())
          .patch(`/owners/${id}`)
          .send({ name: "Stripped", notAField: "x" })
          .expect(200);
        expect(patched.body).not.toHaveProperty("notAField");
        expect(patched.body).toMatchObject({ name: "Stripped" });
      });

      it("404s patching a non-existent owner", async () => {
        await request(server()).patch("/owners/999999").send({ name: "Ghost" }).expect(404);
      });
    });

    describe("Mass assignment", () => {
      it("ignores an owner-supplied deletedAt on create, never soft-deleting a row on arrival", async () => {
        const tag = nextTag();
        const created = await request(server())
          .post("/owners")
          .send({ name: "Ghost", email: email(tag), deletedAt: new Date().toISOString() })
          .expect(201);
        await request(server())
          .get(`/owners/${created.body.id as number}`)
          .expect(200);
      });

      it("a patch body cannot resurrect a soft-deleted owner by smuggling deletedAt: null", async () => {
        const { id } = await createOwner();
        await request(server()).delete(`/owners/${id}`).set(withPermission("owner:delete")).expect(204);
        await request(server()).get(`/owners/${id}`).expect(404);
        await request(server()).patch(`/owners/${id}`).send({ deletedAt: null, name: "Sneaky" }).expect(404);
        await request(server()).get(`/owners/${id}`).expect(404);
      });

      it("ignores a client-supplied id on create", async () => {
        const created = await request(server())
          .post("/owners")
          .send({ name: "Id Spoof", email: email(nextTag()), id: 999999 })
          .expect(201);
        expect(created.body.id).not.toBe(999999);
      });
    });

    describe("Search", () => {
      it("free-text searches both name and email (the zero-config default over own string columns)", async () => {
        const tag = nextTag();
        const uniqueName = `Zephyrine-${tag}`;
        await createOwner({ name: uniqueName });
        const response = await request(server()).get("/owners").query({ "search[query]": uniqueName }).expect(200);
        expect(response.body.items).toHaveLength(1);
        expect(response.body.items[0]).toMatchObject({ name: uniqueName });
      });
    });

    describe("No ETag (cache.etag: false)", () => {
      it("rejects a write carrying an If-Match with 412 KAVO_PRECONDITION_UNSUPPORTED — no tag was ever issued to compare against", async () => {
        const { id, email: existingEmail } = await createOwner();
        const response = await request(server())
          .put(`/owners/${id}`)
          .set("If-Match", '"bogus"')
          .send({ name: "Updated", email: existingEmail })
          .expect(412);
        expect(response.body).toMatchObject({ code: "KAVO_PRECONDITION_UNSUPPORTED" });
      });

      it("a write with no If-Match at all succeeds normally", async () => {
        const { id, email: existingEmail } = await createOwner();
        await request(server()).put(`/owners/${id}`).send({ name: "Updated", email: existingEmail }).expect(200);
      });
    });

    describe("Error contract", () => {
      it("returns an RFC 9457 problem-details body for a 403", async () => {
        const { id } = await createOwner();
        const response = await request(server())
          .delete(`/owners/${id}`)
          .expect(403)
          .expect("Content-Type", /application\/problem\+json/);
        expect(response.body).toMatchObject({ code: "KAVO_FORBIDDEN" });
      });

      it("returns an RFC 9457 problem-details body for a 409", async () => {
        const { email: existingEmail } = await createOwner();
        const response = await request(server())
          .post("/owners")
          .send({ name: "Dup", email: existingEmail })
          .expect(409)
          .expect("Content-Type", /application\/problem\+json/);
        expect(response.body).toMatchObject({ status: 409 });
      });
    });
  });
}
