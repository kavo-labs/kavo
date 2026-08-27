import { describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";

/**
 * A cohesive "Address Endpoints" e2e suite, sized to what's distinctive
 * about `AddressController` (`address.controller.ts`) — the one entity in
 * this app where every standard write is an `@Override` doing real work:
 *
 * - `postalCode`'s 5-digit business rule (`assertValidPostalCode`,
 *   `address.runtime.ts`), enforced procedurally after generic DTO shape
 *   validation, on create/update/patch alike.
 * - `POST /addresses/:id/normalize-postal-code` — a **custom operation**
 *   (registry entry, own route, own settings scope) that trims and
 *   re-validates the already-stored value.
 * - `GET /addresses/:id/validate-postal-code` — a **fully custom,
 *   registry-independent route**: a plain `@Get` Kavo never touches.
 * - `deleteOne`'s cross-entity write: detaches the owning `Owner`'s join
 *   column via the raw `DataSource` before the row is removed, so deleting
 *   an address in use never leaves a dangling reference.
 * - `findOne`'s derived, unpersisted `formattedAddress` field.
 *
 * `crud-e2e.suite.ts` already covers the CRUD lifecycle and the
 * Owner<->Address one-to-one include/associate/disassociate behavior in
 * depth; this suite does not repeat that.
 *
 * Parameterized by `getApp`, like the other entity suites, to run on both
 * SQLite and a real Postgres off whichever app the caller bootstrapped.
 */
export function registerAddressE2eSuite(getApp: () => INestApplication): void {
  function server(): SupertestTarget {
    return boundServer(getApp().getHttpServer() as SupertestTarget);
  }

  let tagCounter = 0;
  function nextTag(): number {
    tagCounter += 1;
    return tagCounter;
  }

  async function createAddress(overrides: Record<string, unknown> = {}): Promise<{ id: number }> {
    const tag = nextTag();
    const response = await request(server())
      .post("/addresses")
      .send({ street: `Street-${tag}`, city: `City-${tag}`, postalCode: "12345", ...overrides })
      .expect(201);
    return { id: response.body.id as number };
  }

  describe("Address Endpoints (e2e)", () => {
    describe("postalCode business rule", () => {
      it("rejects a postal code with the wrong number of digits on create", async () => {
        await request(server())
          .post("/addresses")
          .send({ street: "1 Main St", city: "Springfield", postalCode: "123" })
          .expect(400);
      });

      it("rejects a non-numeric postal code on create", async () => {
        await request(server())
          .post("/addresses")
          .send({ street: "1 Main St", city: "Springfield", postalCode: "abcde" })
          .expect(400);
      });

      it("trims surrounding whitespace before validating and persisting", async () => {
        const created = await request(server())
          .post("/addresses")
          .send({ street: "1 Main St", city: "Springfield", postalCode: "  12345  " })
          .expect(201);
        expect(created.body.postalCode).toBe("12345");
      });

      it("rejects an invalid postal code on PUT", async () => {
        const { id } = await createAddress();
        await request(server())
          .put(`/addresses/${id}`)
          .send({ street: "New St", city: "New City", postalCode: "bad" })
          .expect(400);
      });

      it("rejects an invalid postal code on PATCH", async () => {
        const { id } = await createAddress();
        await request(server()).patch(`/addresses/${id}`).send({ postalCode: "bad" }).expect(400);
      });

      it("PATCH without postalCode does not re-validate the existing one", async () => {
        const { id } = await createAddress();
        await request(server()).patch(`/addresses/${id}`).send({ city: "Renamed" }).expect(200);
      });
    });

    describe("POST /addresses/:id/normalize-postal-code (custom operation)", () => {
      it("re-normalizes an already-stored postal code", async () => {
        const { id } = await createAddress({ postalCode: "12345" });
        const response = await request(server()).post(`/addresses/${id}/normalize-postal-code`).expect(201);
        expect(response.body).toMatchObject({ postalCode: "12345" });
      });

      it("returns 404 for a non-existent address", async () => {
        await request(server()).post("/addresses/999999/normalize-postal-code").expect(404);
      });
    });

    describe("GET /addresses/:id/validate-postal-code (fully custom route)", () => {
      it("reports valid: true for a well-formed postal code", async () => {
        const { id } = await createAddress({ postalCode: "54321" });
        const response = await request(server()).get(`/addresses/${id}/validate-postal-code`).expect(200);
        expect(response.body).toEqual({ valid: true });
      });

      it("is not a Kavo-registered route — 404s a non-existent id through the plain @Get, not KAVO_NOT_FOUND JSON shape mismatch", async () => {
        await request(server()).get("/addresses/999999/validate-postal-code").expect(404);
      });
    });

    describe("findOne's derived formattedAddress", () => {
      it("includes a formattedAddress computed from street/city/postalCode, never a persisted column", async () => {
        const created = await request(server())
          .post("/addresses")
          .send({ street: "221B Baker St", city: "London", postalCode: "12345" })
          .expect(201);
        const fetched = await request(server())
          .get(`/addresses/${created.body.id as number}`)
          .expect(200);
        expect(fetched.body.formattedAddress).toBe("221B Baker St, London 12345");
      });
    });

    describe("deleteOne's cross-entity owner detach", () => {
      it("detaches the owning Owner's address before removing the row, rather than leaving a dangling reference", async () => {
        const tag = nextTag();
        const address = await createAddress();
        const owner = await request(server())
          .post("/owners")
          .send({ name: `AddrOwner-${tag}`, email: `addrowner-${tag}@example.com`, address: { id: address.id } })
          .expect(201);
        const ownerId = owner.body.id as number;

        await request(server()).delete(`/addresses/${address.id}`).expect(204);

        const fetched = await request(server()).get(`/owners/${ownerId}?include=address`).expect(200);
        expect(fetched.body.address).toBeNull();
      });

      it("still 404s deleting a non-existent address", async () => {
        await request(server()).delete("/addresses/999999").expect(404);
      });

      it("a stale If-Match still refuses the delete (the override forwards preconditions)", async () => {
        const { id } = await createAddress();
        const fetched = await request(server()).get(`/addresses/${id}`).expect(200);
        await request(server()).patch(`/addresses/${id}`).send({ city: "Changed once" }).expect(200);
        const response = await request(server())
          .delete(`/addresses/${id}`)
          .set("If-Match", fetched.headers.etag as string)
          .expect(412);
        expect(response.body).toMatchObject({ code: "KAVO_PRECONDITION_FAILED" });
      });
    });

    describe("Error contract", () => {
      it("returns an RFC 9457 problem-details body for the postal-code business-rule 400", async () => {
        const response = await request(server())
          .post("/addresses")
          .send({ street: "x", city: "y", postalCode: "bad" })
          .expect(400)
          .expect("Content-Type", /application\/problem\+json/);
        expect(response.body).toMatchObject({ status: 400 });
      });
    });
  });
}
