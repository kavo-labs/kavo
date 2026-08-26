import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { MikroORM } from "@mikro-orm/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { createSqliteOrm } from "../src/database.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * The `@kavo/mikroorm` mirror of `examples/nest-typeorm/tests/
 * security.e2e.spec.ts` — same attacker-controlled-input coverage (SQL
 * injection at the identifier and data position, mass assignment, stored
 * XSS-payload safety), run over the real Nest -> engine -> `@kavo/mikroorm`
 * -> SQLite stack instead. Kept as a close mirror deliberately: the point is
 * that the allowlist/DTO/JSON-response seams these tests attack are engine
 * concerns, not TypeORM-adapter concerns, so the same attacks must fail the
 * same way on a different ORM adapter.
 *
 * Two shape differences from the TypeORM app worth calling out:
 * - `OwnerController` here has no `owner:delete` policy guard (the
 *   TypeORM app's is a hand-added ADR-0037 example, not a Kavo default), so
 *   `DELETE /owners/:id` needs no extra header.
 * - Neither `createOne` nor `patchOne` is `@Override()`'d on this app's
 *   `CatController`/`OwnerController`, so mass assignment here is stopped
 *   by Kavo's own DTO-derivation stripping, not by a hand-written
 *   `class-validator` whitelist — a stronger proof that the engine's own
 *   seam is what's doing the work.
 */

let orm: MikroORM;
let app: INestApplication;

beforeAll(async () => {
  orm = await createSqliteOrm();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ orm })],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
}, 60_000);

afterAll(async () => {
  try {
    if (app !== undefined) {
      await app.close();
    }
  } finally {
    if (orm !== undefined) {
      await orm.close();
    }
  }
});

function server(): SupertestTarget {
  return boundServer(app.getHttpServer() as SupertestTarget);
}

/**
 * Row count straight off the real table, bypassing the API entirely. Cat is
 * single-table inheritance over the abstract `Pet` (`discriminatorColumn:
 * "species"` on `pet.entity.ts`), so the physical table is `pet`, not `cat`.
 */
async function catCount(): Promise<number> {
  const rows = (await orm.em.getConnection().execute("SELECT COUNT(*) as c FROM pet WHERE species = 'cat'")) as {
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
    await request(server()).get("/cats").expect(200);
  });
});

describe("SQL injection via filter values (data position)", () => {
  it("treats a filter value containing SQL metacharacters as a literal, parameterized string", async () => {
    await request(server())
      .post("/cats")
      .send({ name: "Legit", age: 3, size: "small", indoor: true, livesLeft: 9 })
      .expect(201);
    const before = await catCount();

    const response = await request(server()).get("/cats").query({ "filter[name][eq]": "x' OR '1'='1" }).expect(200);

    expect(response.body.items).toEqual([]);
    expect(await catCount()).toBe(before);
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
    await request(server()).delete(`/owners/${id}`).expect(204);
    await request(server()).get(`/owners/${id}`).expect(404);

    // deletedAt is absent from every DTO slot on this controller (doc 17
    // §7), so the engine's own DTO derivation strips it before it ever
    // reaches the adapter, regardless of whether a validator would too.
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

  it("keeps a 404's error detail JSON-encoded, not interpolated as HTML", async () => {
    const response = await request(server())
      .get(`/cats/999999`)
      .expect(404)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body.code).toBe("KAVO_NOT_FOUND");
  });
});
