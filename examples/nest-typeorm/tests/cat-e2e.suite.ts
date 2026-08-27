import { describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { boundServer, type SupertestTarget } from "./support/listen.js";

/**
 * A single cohesive "Cat Endpoints" e2e suite over the real stack (generated
 * Nest routes -> engine -> `@kavo/typeorm` -> a real database), organized by
 * concern rather than by file. It complements, rather than repeats, the
 * suites that already exercise `/cats` from a specific angle:
 *
 * - `crud-e2e.suite.ts` — the happy-path lifecycle and relation includes/writes
 * - `security.e2e.spec.ts` — SQL-injection and mass-assignment payloads
 * - `concurrency.e2e.spec.ts` / `pagination-caching.e2e.spec.ts` — the full
 *   `If-Match`/`If-None-Match` contract (ADR-0020) under real races
 *
 * so this file's ETag coverage below stays intentionally shallow (one
 * request/response pair per case), and its security-shaped assertions
 * (mass assignment, malformed input) stay narrow to what's specific to Cat's
 * own DTOs and config.
 *
 * `CatController` has no `policy` on any operation and no auth guard
 * (`cat.controller.ts`) — unlike `OwnerController` (see `policy.e2e.spec.ts`
 * for that shape) — so there is no "write operation policy" or
 * "authentication" section here; every route below is open. There is also
 * no PATCH /cats/:id: `patchOne` is deliberately not named in
 * `cat.controller.ts`'s `operations` whitelist, so PUT is the only update
 * route and every PATCH request 404s (no route generated).
 *
 * Parameterized by `getApp` — like `crud-e2e.suite.ts` — so the same suite
 * runs unchanged against SQLite (`app.e2e.spec.ts`) and a real
 * Testcontainers Postgres (`app-postgres.e2e.spec.ts`). Both call sites
 * register this alongside `registerCrudE2eSuite` on the *same* app
 * instance/database rather than bootstrapping a private one, so uniqueness
 * tags below are a per-process counter, not `Date.now()` — two tests in the
 * same millisecond must not cross-match rows seeded by the other suite.
 * There is deliberately no "Performance" section: 200-row wall-clock
 * thresholds tuned against in-memory SQLite are a flake generator against a
 * container Postgres, and seeding 200+ extra rows into the shared `pet`
 * table would perturb `crud-e2e.suite.ts`'s own pagination/`total`
 * assertions.
 */
export function registerCatE2eSuite(getApp: () => INestApplication): void {
  function server(): SupertestTarget {
    return boundServer(getApp().getHttpServer() as SupertestTarget);
  }

  let tagCounter = 0;
  function nextTag(): number {
    tagCounter += 1;
    return tagCounter;
  }

  const VALID_CAT = { name: "Whiskers", age: 3, size: "small", indoor: true, livesLeft: 9 };

  async function createCat(overrides: Record<string, unknown> = {}): Promise<{ id: number; etag: string }> {
    const response = await request(server())
      .post("/cats")
      .send({ ...VALID_CAT, ...overrides })
      .expect(201);
    return { id: response.body.id as number, etag: response.headers.etag as string };
  }

  describe("Cat Endpoints (e2e)", () => {
    describe("PATCH /cats/:id (disabled operation)", () => {
      it("404s — no route is generated because patchOne is not named in the operations whitelist", async () => {
        const { id } = await createCat({ name: `PatchDisabled-${nextTag()}` });
        await request(server()).patch(`/cats/${id}`).send({ age: 4 }).expect(404);
      });
    });

    describe("CRUD lifecycle", () => {
      it("creates, reads, updates, and deletes a cat", async () => {
        const tag = nextTag();
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: `Lifecycle-${tag}` })
          .expect(201);
        expect(created.body).toMatchObject({ name: `Lifecycle-${tag}`, age: 3, size: "small", indoor: true });
        const id = created.body.id as number;

        const fetched = await request(server()).get(`/cats/${id}`).expect(200);
        expect(fetched.body).toMatchObject({ id, name: `Lifecycle-${tag}` });

        const updated = await request(server())
          .put(`/cats/${id}`)
          .send({ name: `Renamed-${tag}`, age: 4, size: "large", indoor: false, livesLeft: 8 })
          .expect(200);
        expect(updated.body).toMatchObject({ name: `Renamed-${tag}`, age: 4, size: "large", indoor: false });

        await request(server()).delete(`/cats/${id}`).expect(204);
        await request(server()).get(`/cats/${id}`).expect(404);
      });

      it("excludes a deleted cat from list results", async () => {
        const { id } = await createCat({ name: `ToDelete-${nextTag()}` });
        await request(server()).delete(`/cats/${id}`).expect(204);

        const list = await request(server()).get("/cats").query({ "filter[id][eq]": id }).expect(200);
        expect(list.body.items).toEqual([]);
      });
    });

    describe("POST /cats validation", () => {
      it("rejects an empty name", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: "" })
          .expect(400);
      });

      it("rejects a missing required field", async () => {
        const { name: _name, ...rest } = VALID_CAT;
        await request(server()).post("/cats").send(rest).expect(400);
      });

      it("rejects a null value for a required field", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: null })
          .expect(400);
      });

      it("rejects a negative age", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, age: -1 })
          .expect(400);
      });

      it("rejects a non-integer age", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, age: 3.5 })
          .expect(400);
      });

      it("rejects a non-boolean indoor value", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, indoor: "yes" })
          .expect(400);
      });

      it("rejects a negative livesLeft", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, livesLeft: -1 })
          .expect(400);
      });

      it("rejects an invalid size enum value", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, size: "gigantic" })
          .expect(400);
      });

      it("accepts a payload with size omitted, the DB default applying", async () => {
        const { size: _size, ...rest } = VALID_CAT;
        const created = await request(server())
          .post("/cats")
          .send({ ...rest, name: `SizeOmitted-${nextTag()}` })
          .expect(201);
        expect(created.body.size).toBe("medium");
      });

      it("rejects a bare scalar owner id instead of an { id } reference (issue #291)", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, owner: 1 })
          .expect(400);
      });

      it("rejects a non-array tags field", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, tags: "not-an-array" })
          .expect(400);
      });

      it("rejects a tags array containing a bare scalar element", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, tags: [1] })
          .expect(400);
      });

      it("accepts a whitespace-only name (IsNotEmpty rejects only the empty string, not blank text)", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: "   " })
          .expect(201);
      });

      it("accepts an empty tags array", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: `EmptyTags-${nextTag()}`, tags: [] })
          .expect(201);
      });
    });

    describe("PUT /cats/:id validation and edge cases", () => {
      it("rejects a PUT body with an invalid field even when the rest is valid", async () => {
        const { id } = await createCat({ name: `PutInvalid-${nextTag()}` });
        await request(server())
          .put(`/cats/${id}`)
          .send({ ...VALID_CAT, age: -5 })
          .expect(400);
      });

      it("ignores a client-supplied id on PUT (mass assignment)", async () => {
        const tag = nextTag();
        const a = await createCat({ name: `MassA-${tag}` });
        const b = await createCat({ name: `MassB-${tag}` });
        await request(server())
          .put(`/cats/${a.id}`)
          .send({ ...VALID_CAT, id: b.id, name: `StillA-${tag}` })
          .expect(200);
        const fetchedA = await request(server()).get(`/cats/${a.id}`).expect(200);
        expect(fetchedA.body.name).toBe(`StillA-${tag}`);
        const fetchedB = await request(server()).get(`/cats/${b.id}`).expect(200);
        expect(fetchedB.body.name).toBe(`MassB-${tag}`);
      });

      it("ignores a client-supplied createdAt on PUT", async () => {
        const { id } = await createCat({ name: `CreatedAt-${nextTag()}` });
        const before = await request(server()).get(`/cats/${id}`).expect(200);
        await request(server())
          .put(`/cats/${id}`)
          .send({ ...VALID_CAT, createdAt: "2000-01-01T00:00:00.000Z" })
          .expect(200);
        const after = await request(server()).get(`/cats/${id}`).expect(200);
        expect(after.body.createdAt).toBe(before.body.createdAt);
      });

      it("returns 404 for a PUT on a non-existent id", async () => {
        await request(server()).put("/cats/999999").send(VALID_CAT).expect(404);
      });
    });

    describe("DELETE edge cases", () => {
      it("returns 404 for a DELETE on a non-existent id", async () => {
        await request(server()).delete("/cats/999999").expect(404);
      });

      it("returns 400 for a DELETE with a malformed id", async () => {
        await request(server()).delete("/cats/not-a-number").expect(400);
      });

      it("does not silently 204 twice for a DELETE on an already-deleted cat", async () => {
        const { id } = await createCat({ name: `DoubleDelete-${nextTag()}` });
        await request(server()).delete(`/cats/${id}`).expect(204);
        await request(server()).delete(`/cats/${id}`).expect(404);
      });
    });

    describe("GET /cats/:id edge cases", () => {
      it("returns 400 for a malformed id", async () => {
        await request(server()).get("/cats/not-a-number").expect(400);
      });

      it("returns 404 for a non-existent id", async () => {
        await request(server()).get("/cats/999999").expect(404);
      });

      it("does not include species in the response (never a client-facing field)", async () => {
        const { id } = await createCat({ name: `NoSpecies-${nextTag()}` });
        const fetched = await request(server()).get(`/cats/${id}`).expect(200);
        expect(fetched.body).not.toHaveProperty("species");
      });
    });

    describe("GET /cats (list)", () => {
      it("rejects an unknown sort field", async () => {
        const response = await request(server()).get("/cats").query({ sort: "indoor" }).expect(400);
        expect(response.body).toMatchObject({ code: "KAVO_QUERY_INVALID" });
      });

      it("rejects an unknown filter field", async () => {
        await request(server()).get("/cats").query({ "filter[indoor][eq]": "true" }).expect(400);
      });

      it("returns an empty list when filters match nothing", async () => {
        const response = await request(server())
          .get("/cats")
          .query({ "filter[name][eq]": `no-such-cat-${nextTag()}` })
          .expect(200);
        expect(response.body.items).toEqual([]);
        expect(response.body.total).toBe(0);
      });

      it("filters by age", async () => {
        const tag = nextTag();
        await createCat({ name: `Young-${tag}`, age: 1 });
        const response = await request(server())
          .get("/cats")
          .query({ "filter[age][eq]": 1, "filter[name][eq]": `Young-${tag}` })
          .expect(200);
        expect(response.body.items).toHaveLength(1);
        expect(response.body.items[0]).toMatchObject({ name: `Young-${tag}` });
      });

      it("clamps a limit above the entity's own max of 50 instead of rejecting it", async () => {
        const response = await request(server()).get("/cats").query({ limit: 1000 }).expect(200);
        expect(response.body.limit).toBe(50);
      });

      it("sorts by age descending with a leading '-'", async () => {
        const tag = nextTag();
        await createCat({ name: `SortA-${tag}`, age: 5 });
        await createCat({ name: `SortB-${tag}`, age: 50 });
        const response = await request(server())
          .get("/cats")
          .query({ "filter[name][like]": `Sort%-${tag}`, sort: "-age" })
          .expect(200);
        const ages = (response.body.items as { age: number }[]).map((item) => item.age);
        expect(ages).toEqual([...ages].sort((a, b) => b - a));
      });
    });

    describe("Error contract", () => {
      it("returns an RFC 9457 problem-details body for a 400", async () => {
        const response = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: "" })
          .expect(400)
          .expect("Content-Type", /application\/problem\+json/);
        expect(response.body).toMatchObject({ status: 400 });
      });

      it("returns an RFC 9457 problem-details body for a 404", async () => {
        const response = await request(server())
          .get("/cats/999999")
          .expect(404)
          .expect("Content-Type", /application\/problem\+json/);
        expect(response.body).toMatchObject({ code: "KAVO_NOT_FOUND", status: 404 });
      });

      it("returns 400, not 500, for malformed JSON", async () => {
        await request(server())
          .post("/cats")
          .set("Content-Type", "application/json")
          .send("{not valid json")
          .expect(400);
      });

      it("strips unknown fields from the body instead of persisting or rejecting them", async () => {
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: `StripUnknown-${nextTag()}`, notAField: "surprise" })
          .expect(201);
        expect(created.body).not.toHaveProperty("notAField");
      });
    });

    describe("Conditional requests (ETag)", () => {
      it("serves an ETag on a single-item GET", async () => {
        const { id } = await createCat({ name: `Etag-${nextTag()}` });
        const response = await request(server()).get(`/cats/${id}`).expect(200);
        expect(response.headers.etag).toBeDefined();
      });

      it("returns 304 for a GET with a matching If-None-Match", async () => {
        const { id, etag } = await createCat({ name: `Etag304-${nextTag()}` });
        await request(server()).get(`/cats/${id}`).set("If-None-Match", etag).expect(304);
      });

      it("returns 412 for a PUT with a stale If-Match", async () => {
        const { id, etag } = await createCat({ name: `Stale-${nextTag()}` });
        await request(server())
          .put(`/cats/${id}`)
          .send({ ...VALID_CAT, name: "First change" })
          .expect(200);

        const response = await request(server())
          .put(`/cats/${id}`)
          .set("If-Match", etag)
          .send({ ...VALID_CAT, name: "Second change" })
          .expect(412);
        expect(response.body).toMatchObject({ code: "KAVO_PRECONDITION_FAILED" });
      });

      it("allows a PUT with a matching If-Match", async () => {
        const { id, etag } = await createCat({ name: `MatchingIfMatch-${nextTag()}` });
        await request(server())
          .put(`/cats/${id}`)
          .set("If-Match", etag)
          .send({ ...VALID_CAT, name: "Updated" })
          .expect(200);
      });
    });

    describe("Data integrity", () => {
      it("round-trips Farsi (RTL) text in the name unchanged", async () => {
        const name = `گربه سفید ${nextTag()}`;
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name })
          .expect(201);
        expect(created.body.name).toBe(name);
        const fetched = await request(server())
          .get(`/cats/${created.body.id as number}`)
          .expect(200);
        expect(fetched.body.name).toBe(name);
      });

      it("round-trips an emoji-bearing name unchanged", async () => {
        const name = `Mittens 🐱 ${nextTag()}`;
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name })
          .expect(201);
        expect(created.body.name).toBe(name);
      });

      it("leaves createdAt unchanged after a PUT", async () => {
        const { id } = await createCat({ name: `CreatedAtStable-${nextTag()}` });
        const before = await request(server()).get(`/cats/${id}`).expect(200);
        await request(server())
          .put(`/cats/${id}`)
          .send({ ...VALID_CAT, name: "Changed" })
          .expect(200);
        const after = await request(server()).get(`/cats/${id}`).expect(200);
        expect(after.body.createdAt).toBe(before.body.createdAt);
      });

      it("preserves an explicit false for indoor (not coerced to the default)", async () => {
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: `IndoorFalse-${nextTag()}`, indoor: false })
          .expect(201);
        expect(created.body.indoor).toBe(false);
      });

      it("round-trips a multiline name unchanged", async () => {
        const name = `Line one\nLine two ${nextTag()}`;
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name })
          .expect(201);
        expect(created.body.name).toBe(name);
      });
    });

    describe("POST /cats additional validation", () => {
      it("rejects a string age instead of a number", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, age: "three" })
          .expect(400);
      });

      it("accepts an age of exactly 0", async () => {
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: `AgeZero-${nextTag()}`, age: 0 })
          .expect(201);
        expect(created.body.age).toBe(0);
      });

      it("accepts a livesLeft of exactly 0", async () => {
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: `LivesLeftZero-${nextTag()}`, livesLeft: 0 })
          .expect(201);
        expect(created.body.livesLeft).toBe(0);
      });

      it("rejects a non-integer livesLeft", async () => {
        await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, livesLeft: 2.5 })
          .expect(400);
      });

      it("does not persist a client-supplied id on create (mass assignment)", async () => {
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name: `ClientId-${nextTag()}`, id: 999999 })
          .expect(201);
        expect(created.body.id).not.toBe(999999);
      });

      it("handles an excessively long name without erroring", async () => {
        const name = `${"x".repeat(5000)}-${nextTag()}`;
        const created = await request(server())
          .post("/cats")
          .send({ ...VALID_CAT, name })
          .expect(201);
        expect(created.body.name).toBe(name);
      });
    });

    describe("PUT /cats/:id additional edge cases", () => {
      it("rejects an empty PUT body (name defaults to '', which is invalid)", async () => {
        const { id } = await createCat({ name: `EmptyPut-${nextTag()}` });
        await request(server()).put(`/cats/${id}`).send({}).expect(400);
      });

      it("returns 400 for a PUT with a malformed id", async () => {
        await request(server()).put("/cats/not-a-number").send(VALID_CAT).expect(400);
      });

      it("returns 404 for a PUT on an already-deleted cat", async () => {
        const { id } = await createCat({ name: `PutDeleted-${nextTag()}` });
        await request(server()).delete(`/cats/${id}`).expect(204);
        await request(server()).put(`/cats/${id}`).send(VALID_CAT).expect(404);
      });

      it("updates every field provided in one PUT (full replace, not a partial merge)", async () => {
        const tag = nextTag();
        const { id } = await createCat({ name: `Before-${tag}`, age: 1, size: "small", indoor: true, livesLeft: 9 });
        const updated = await request(server())
          .put(`/cats/${id}`)
          .send({ name: `After-${tag}`, age: 2, size: "large", indoor: false, livesLeft: 1 })
          .expect(200);
        expect(updated.body).toMatchObject({ name: `After-${tag}`, age: 2, size: "large", indoor: false });
      });
    });

    describe("GET /cats (list) additional validation", () => {
      it("rejects a negative limit", async () => {
        await request(server()).get("/cats").query({ limit: -1 }).expect(400);
      });

      it("rejects a negative offset", async () => {
        await request(server()).get("/cats").query({ offset: -1 }).expect(400);
      });

      it("advances through pages via offset", async () => {
        const tag = nextTag();
        const names = Array.from({ length: 5 }, (_, index) => `Offset-${tag}-${index}`);
        for (const name of names) {
          await createCat({ name });
        }
        const seen = new Set<string>();
        for (let offset = 0; offset < names.length; offset += 2) {
          const response = await request(server())
            .get("/cats")
            .query({ "filter[name][like]": `Offset-${tag}-%`, sort: "id", limit: 2, offset })
            .expect(200);
          for (const item of response.body.items as { name: string }[]) {
            seen.add(item.name);
          }
        }
        expect(seen.size).toBe(names.length);
      });

      it("filters by size", async () => {
        const tag = nextTag();
        await createCat({ name: `Sm-${tag}`, size: "small" });
        await createCat({ name: `Lg-${tag}`, size: "large" });
        const response = await request(server())
          .get("/cats")
          .query({ "filter[size][eq]": "large", "filter[name][like]": `%${tag}` })
          .expect(200);
        expect(response.body.items).toHaveLength(1);
        expect(response.body.items[0]).toMatchObject({ name: `Lg-${tag}` });
      });

      it("combines a filter, a sort, and pagination together", async () => {
        const tag = nextTag();
        await createCat({ name: `Combo-${tag}-1`, size: "small", age: 2 });
        await createCat({ name: `Combo-${tag}-2`, size: "small", age: 5 });
        await createCat({ name: `Combo-${tag}-3`, size: "small", age: 1 });
        const response = await request(server())
          .get("/cats")
          .query({ "filter[size][eq]": "small", "filter[name][like]": `Combo-${tag}-%`, sort: "-age", limit: 2 })
          .expect(200);
        expect(response.body.items).toHaveLength(2);
        // CatListDto's projection carries id/name/indoor, not age — order is
        // asserted through name, which encodes the age each row was seeded with.
        const names = (response.body.items as { name: string }[]).map((item) => item.name);
        expect(names).toEqual([`Combo-${tag}-2`, `Combo-${tag}-1`]);
      });
    });

    describe("Idempotency", () => {
      it("a repeated PUT with the same body applied twice leaves the row in the same final state", async () => {
        const { id } = await createCat({ name: `IdempotentPut-${nextTag()}` });
        await request(server())
          .put(`/cats/${id}`)
          .send({ ...VALID_CAT, name: "Steady" })
          .expect(200);
        const second = await request(server())
          .put(`/cats/${id}`)
          .send({ ...VALID_CAT, name: "Steady" })
          .expect(200);
        expect(second.body).toMatchObject({ name: "Steady" });
      });

      it("a repeated identical GET returns the same representation", async () => {
        const { id } = await createCat({ name: `IdempotentGet-${nextTag()}` });
        const first = await request(server()).get(`/cats/${id}`).expect(200);
        const second = await request(server()).get(`/cats/${id}`).expect(200);
        expect(second.body).toEqual(first.body);
      });
    });

    describe("ETag behavior", () => {
      it("changes the ETag after an update", async () => {
        const { id, etag } = await createCat({ name: `EtagChange-${nextTag()}` });
        const updated = await request(server())
          .put(`/cats/${id}`)
          .send({ ...VALID_CAT, name: "Changed" })
          .expect(200);
        expect(updated.headers.etag).not.toBe(etag);
      });

      it("leaves the ETag unchanged across repeated GETs with no write in between", async () => {
        const { id } = await createCat({ name: `EtagStable-${nextTag()}` });
        const first = await request(server()).get(`/cats/${id}`).expect(200);
        const second = await request(server()).get(`/cats/${id}`).expect(200);
        expect(second.headers.etag).toBe(first.headers.etag);
      });

      it("returns 200, not an error, for a GET with a malformed If-None-Match header", async () => {
        const { id } = await createCat({ name: `MalformedIfNoneMatch-${nextTag()}` });
        await request(server()).get(`/cats/${id}`).set("If-None-Match", "not-a-valid-etag").expect(200);
      });

      it("returns 412 for a PUT with a malformed If-Match header, rather than silently applying it", async () => {
        const { id } = await createCat({ name: `MalformedIfMatch-${nextTag()}` });
        const response = await request(server())
          .put(`/cats/${id}`)
          .set("If-Match", "not-a-valid-etag")
          .send({ ...VALID_CAT, name: "Should not apply" })
          .expect(412);
        expect(response.body).toMatchObject({ code: "KAVO_PRECONDITION_FAILED" });
      });
    });

    describe("Concurrency", () => {
      // The full race-condition contract (last-write-wins with no If-Match,
      // stale-If-Match rejection under real concurrent writers) lives in
      // `concurrency.e2e.spec.ts`; this is a light Cat-specific smoke test.
      it("handles concurrent GET requests for the same cat without errors or cross-request interference", async () => {
        const { id } = await createCat({ name: `Concurrent-${nextTag()}` });
        const responses = await Promise.all(
          Array.from({ length: 10 }, () => request(server()).get(`/cats/${id}`).expect(200)),
        );
        for (const response of responses) {
          expect(response.body).toMatchObject({ id });
        }
      });

      it("handles two concurrent DELETE requests on the same cat consistently — exactly one succeeds", async () => {
        const { id } = await createCat({ name: `ConcurrentDelete-${nextTag()}` });
        const results = await Promise.all([
          request(server()).delete(`/cats/${id}`),
          request(server()).delete(`/cats/${id}`),
        ]);
        // Which of the two wins is a race, not a contract — Postgres MVCC and
        // SQLite's serialized writes can pick differently. What must hold on
        // both: exactly one 204, the rest 404s, and the row is actually gone.
        const succeeded = results.filter((response) => response.status === 204);
        const failed = results.filter((response) => response.status === 404);
        expect(succeeded).toHaveLength(1);
        expect(failed).toHaveLength(1);
        await request(server()).get(`/cats/${id}`).expect(404);
      });
    });
  });
}
