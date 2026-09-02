import { describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";

/**
 * An "OwnerSetting Endpoints" e2e suite sized to what's distinctive about
 * `OwnerSettingController` — a shared-primary-key one-to-one (issue #267):
 * `owner_id` is both this entity's sole primary column and the
 * `@JoinColumn` of its `owner` relation, so a row is addressed by the same
 * id its owning `Owner` uses, and a given owner can have at most one
 * settings row. The ordinary lifecycle is already `crud-e2e.suite.ts`'s
 * subject; this suite covers the shared-key-specific edges: the
 * at-most-one-per-owner constraint, association-by-id validation, and a
 * foreign-key violation on a nonexistent owner.
 *
 * Parameterized by `getApp`, like the other entity suites.
 */
export function registerOwnerSettingE2eSuite(getApp: () => INestApplication): void {
  function server(): SupertestTarget {
    return boundServer(getApp().getHttpServer() as SupertestTarget);
  }

  let tagCounter = 0;
  function nextTag(): number {
    tagCounter += 1;
    return tagCounter;
  }

  async function createOwner(): Promise<number> {
    const tag = nextTag();
    const response = await request(server())
      .post("/owners")
      .send({ name: `SettingsOwner-${tag}`, email: `settingsowner-${tag}@example.com` })
      .expect(201);
    return response.body.id as number;
  }

  describe("OwnerSetting Endpoints (e2e)", () => {
    describe("Shared-primary-key routing", () => {
      it("addresses a settings row by the same id its owner uses", async () => {
        const ownerId = await createOwner();
        await request(server())
          .post("/owner-settings")
          .send({ owner: { id: ownerId }, theme: "dark", emailNotifications: true })
          .expect(201);

        const fetched = await request(server()).get(`/owner-settings/${ownerId}`).expect(200);
        expect(fetched.body).toMatchObject({ owner_id: ownerId, theme: "dark" });
      });

      it("returns 404 for a settings row on an owner id with no settings yet", async () => {
        const ownerId = await createOwner();
        await request(server()).get(`/owner-settings/${ownerId}`).expect(404);
      });
    });

    describe("At most one settings row per owner", () => {
      it("a second create for the same owner upserts rather than conflicting — the shared primary key makes it a save(), not an insert-only create", async () => {
        const ownerId = await createOwner();
        await request(server())
          .post("/owner-settings")
          .send({ owner: { id: ownerId }, theme: "light", emailNotifications: true })
          .expect(201);
        const second = await request(server())
          .post("/owner-settings")
          .send({ owner: { id: ownerId }, theme: "dark", emailNotifications: false })
          .expect(201);
        expect(second.body).toMatchObject({ theme: "dark", emailNotifications: false });

        const fetched = await request(server()).get(`/owner-settings/${ownerId}`).expect(200);
        expect(fetched.body.theme).toBe("dark");
      });
    });

    describe("owner association validation", () => {
      it("rejects a bare scalar owner id instead of an { id } reference (issue #291)", async () => {
        await request(server())
          .post("/owner-settings")
          .send({ owner: 1, theme: "dark", emailNotifications: true })
          .expect(400);
      });

      it("rejects a missing owner", async () => {
        await request(server()).post("/owner-settings").send({ theme: "dark", emailNotifications: true }).expect(400);
      });

      it("rejects an owner id that does not reference an existing owner, as a 422 (the DB's own FK constraint)", async () => {
        await request(server())
          .post("/owner-settings")
          .send({ owner: { id: 999999 }, theme: "dark", emailNotifications: true })
          .expect(422)
          .expect((res) => {
            expect(res.body.code).toBe("KAVO_UNRESOLVED_RELATION");
          });
      });
    });

    describe("theme/emailNotifications validation", () => {
      it("rejects an empty theme", async () => {
        const ownerId = await createOwner();
        await request(server())
          .post("/owner-settings")
          .send({ owner: { id: ownerId }, theme: "", emailNotifications: true })
          .expect(400);
      });

      it("rejects a non-boolean emailNotifications", async () => {
        const ownerId = await createOwner();
        await request(server())
          .post("/owner-settings")
          .send({ owner: { id: ownerId }, theme: "dark", emailNotifications: "yes" })
          .expect(400);
      });

      it("updates only the field(s) provided on PATCH", async () => {
        const ownerId = await createOwner();
        await request(server())
          .post("/owner-settings")
          .send({ owner: { id: ownerId }, theme: "light", emailNotifications: true })
          .expect(201);
        const patched = await request(server())
          .patch(`/owner-settings/${ownerId}`)
          .send({ emailNotifications: false })
          .expect(200);
        expect(patched.body).toMatchObject({ theme: "light", emailNotifications: false });
      });
    });

    describe("CRUD lifecycle", () => {
      it("creates, reads, updates, and deletes a settings row", async () => {
        const ownerId = await createOwner();
        await request(server())
          .post("/owner-settings")
          .send({ owner: { id: ownerId }, theme: "light", emailNotifications: true })
          .expect(201);

        const updated = await request(server())
          .put(`/owner-settings/${ownerId}`)
          .send({ theme: "dark", emailNotifications: false })
          .expect(200);
        expect(updated.body).toMatchObject({ theme: "dark", emailNotifications: false });

        await request(server()).delete(`/owner-settings/${ownerId}`).expect(204);
        await request(server()).get(`/owner-settings/${ownerId}`).expect(404);
      });

      it("deleting a settings row does not delete the owner it belongs to", async () => {
        const ownerId = await createOwner();
        await request(server())
          .post("/owner-settings")
          .send({ owner: { id: ownerId }, theme: "light", emailNotifications: true })
          .expect(201);
        await request(server()).delete(`/owner-settings/${ownerId}`).expect(204);
        await request(server()).get(`/owners/${ownerId}`).expect(200);
      });
    });
  });
}
