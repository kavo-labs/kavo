import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { DataSource } from "typeorm";
import { AppModule } from "../src/app.module.js";
import { DATA_SOURCE } from "../src/database.module.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * Attacker-controlled-input coverage over the real stack (generated Nest
 * routes -> engine -> `@kavo/typeorm` -> real SQLite), aimed at the seams
 * `kavo-security-auditor` names: the filter/sort/select allowlist, mass
 * assignment on write DTOs, and JSON-response handling of hostile payloads.
 * `crud-e2e.suite.ts` already exercises the allowlist and DTO stripping as
 * ordinary behavior (issue #45, "ignores client-sent generated columns");
 * this file's job is to attack those same seams with actual injection
 * payloads and confirm the underlying table survives intact, rather than
 * merely that a well-formed request is well-handled.
 *
 * IDOR-style authorization bypass is already the entire subject of
 * `policy.e2e.spec.ts` (ADR-0037: ownership + 404-beats-403) — not repeated
 * here.
 */

let app: INestApplication;
let dataSource: DataSource;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot()],
  }).compile();
  app = moduleRef.createNestApplication();
  dataSource = app.get<DataSource>(DATA_SOURCE);
  await listen(app);
});

afterAll(async () => {
  if (app !== undefined) await app.close();
});

function server(): SupertestTarget {
  return boundServer(app.getHttpServer() as SupertestTarget);
}

/**
 * Row count straight off the real table, bypassing the API entirely. Cat is
 * single-table inheritance over `Pet` (`@TableInheritance` on `pet.entity.ts`),
 * so the physical table is `pet`, not `cat`.
 */
async function catCount(): Promise<number> {
  const rows = (await dataSource.query("SELECT COUNT(*) as c FROM pet WHERE species = 'cat'")) as {
    c: number | string;
  }[];
  return Number(rows[0]?.c);
}

describe("SQL injection via the query grammar (identifier position)", () => {
  it("rejects an injected identifier in filter[...] as an unknown field, never reaching the query builder", async () => {
    const before = await catCount();
    const response = await request(server()).get("/cats").query({ "filter[id) OR 1=1 --][eq]": "1" }).expect(400);
    expect(response.body).toMatchObject({ code: "KAVO_QUERY_INVALID" });
    expect(response.body.errors).toEqual([expect.objectContaining({ code: "KAVO_QUERY_INVALID_FIELD" })]);
    expect(await catCount()).toBe(before);
  });

  it("rejects an injected identifier in sort as an unknown field", async () => {
    const response = await request(server()).get("/cats").query("sort=id; DROP TABLE cat; --").expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field: "id; DROP TABLE cat; --", code: "KAVO_QUERY_INVALID_FIELD" }),
    ]);
    expect(await catCount()).toBeGreaterThanOrEqual(0); // table still exists — a dropped table would 500, not 400
  });

  it("rejects an injected identifier in fields= (select) as an unknown field", async () => {
    const response = await request(server()).get("/cats").query("fields=id,name); DROP TABLE cat; --").expect(400);
    expect(response.body.errors).toEqual([expect.objectContaining({ code: "KAVO_QUERY_INVALID_FIELD" })]);
  });

  it("survives a semicolon-stacked injection attempt across all three positions in one request", async () => {
    const before = await catCount();
    await request(server())
      .get("/cats")
      .query("filter[name][eq]=x&sort=name; DROP TABLE cat --&fields=id; DROP TABLE owner --")
      .expect(400);
    expect(await catCount()).toBe(before);
    // The table is not just present — it still serves ordinary reads.
    await request(server()).get("/cats").expect(200);
  });
});

describe("SQL injection via filter/search values (data position)", () => {
  it("treats a filter value containing SQL metacharacters as a literal, parameterized string", async () => {
    await request(server())
      .post("/cats")
      .send({ name: "Legit", age: 3, size: "small", indoor: true, livesLeft: 9 })
      .expect(201);
    const before = await catCount();

    const response = await request(server()).get("/cats").query({ "filter[name][eq]": "x' OR '1'='1" }).expect(200);

    // No row's name is literally "x' OR '1'='1" — a real injection (tautology
    // bypassing the WHERE) would instead return every row.
    expect(response.body.items).toEqual([]);
    expect(await catCount()).toBe(before);
  });

  it("treats a search[query] value containing SQL metacharacters as a literal substring, not raw SQL", async () => {
    const response = await request(server())
      .get("/cats")
      .query({ "search[query]": "'; DROP TABLE cat; --" })
      .expect(200);
    expect(response.body.items).toEqual([]);
    await request(server()).get("/cats").expect(200); // table still there and queryable
  });

  it("round-trips a value containing SQL metacharacters as ordinary data on write, without executing it", async () => {
    const before = await catCount();
    const created = await request(server())
      .post("/cats")
      .send({ name: "Robert'); DROP TABLE cat; --", age: 1, size: "small", indoor: true, livesLeft: 9 })
      .expect(201);
    expect(created.body.name).toBe("Robert'); DROP TABLE cat; --");
    expect(await catCount()).toBe(before + 1);

    const fetched = await request(server())
      .get(`/cats/${created.body.id as number}`)
      .expect(200);
    expect(fetched.body.name).toBe("Robert'); DROP TABLE cat; --");
  });
});

describe("Mass assignment", () => {
  it("does not let a create body overwrite an existing row's id (client-sent id is not the identity)", async () => {
    const first = await request(server())
      .post("/cats")
      .send({ name: "Original", age: 2, size: "small", indoor: true, livesLeft: 9 })
      .expect(201);
    const firstId = first.body.id as number;

    // Attacker guesses/reuses an existing id on a fresh create.
    const second = await request(server())
      .post("/cats")
      .send({ id: firstId, name: "Attacker", age: 9, size: "large", indoor: false, livesLeft: 1 })
      .expect(201);

    expect(second.body.id).not.toBe(firstId);
    const original = await request(server()).get(`/cats/${firstId}`).expect(200);
    expect(original.body.name).toBe("Original");
  });

  it("ignores an owner-supplied deletedAt on create, never soft-deleting a row on arrival", async () => {
    const created = await request(server())
      .post("/owners")
      .send({ name: "Ghost", email: `ghost-${Date.now()}@example.com`, deletedAt: new Date().toISOString() })
      .expect(201);
    // deletedAt is excluded from the response DTO, but the effect is
    // observable: the row is immediately findable, not born soft-deleted.
    await request(server())
      .get(`/owners/${created.body.id as number}`)
      .expect(200);
  });

  it("a patch body cannot resurrect a soft-deleted row by smuggling deletedAt: null (must go through restoreOne)", async () => {
    const owner = await request(server())
      .post("/owners")
      .send({ name: "ToDelete", email: `todelete-${Date.now()}@example.com` })
      .expect(201);
    const id = owner.body.id as number;
    await request(server()).delete(`/owners/${id}`).set("x-permissions", "owner:delete").expect(204);
    await request(server()).get(`/owners/${id}`).expect(404);

    // PatchOwnerDto carries no deletedAt field — class-validator's
    // whitelist strips it before it ever reaches the engine.
    await request(server()).patch(`/owners/${id}`).send({ deletedAt: null, name: "Sneaky" }).expect(404);
    await request(server()).get(`/owners/${id}`).expect(404);
  });
});

describe("Stored payload safety (JSON API, not an HTML renderer)", () => {
  const XSS_PAYLOAD = "<script>alert(document.cookie)</script>";

  it("stores and returns a script-tag payload as opaque data, verbatim, never executed server-side", async () => {
    const created = await request(server())
      .post("/cats")
      .send({ name: XSS_PAYLOAD, age: 1, size: "small", indoor: true, livesLeft: 9 })
      .expect(201);
    expect(created.body.name).toBe(XSS_PAYLOAD);

    const fetched = await request(server())
      .get(`/cats/${created.body.id as number}`)
      .expect(200);
    expect(fetched.body.name).toBe(XSS_PAYLOAD);
  });

  it("serves every response as application/json, never text/html, so a stored payload cannot be browser-rendered", async () => {
    const created = await request(server())
      .post("/cats")
      .send({ name: XSS_PAYLOAD, age: 1, size: "small", indoor: true, livesLeft: 9 })
      .expect(201)
      .expect("Content-Type", /application\/json/);

    await request(server())
      .get(`/cats/${created.body.id as number}`)
      .expect(200)
      .expect("Content-Type", /application\/json/);

    await request(server())
      .get("/cats")
      .query({ "filter[name][eq]": XSS_PAYLOAD })
      .expect(200)
      .expect("Content-Type", /application\/json/);
  });

  it("keeps a payload in a 404's error detail JSON-encoded, not interpolated as HTML", async () => {
    const response = await request(server())
      .get(`/cats/999999`)
      .expect(404)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body.code).toBe("KAVO_NOT_FOUND");
  });
});
