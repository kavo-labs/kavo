import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { Article } from "../src/article/article.model.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * The `@kavo/mongoose` mirror of `examples/nest-typeorm/tests/
 * security.e2e.spec.ts`, adjusted for a document store. TypeORM's SQL
 * injection payloads (`'; DROP TABLE ...`) don't apply here — the
 * equivalent document-store attack is **NoSQL operator injection**: a
 * client trying to smuggle a Mongo query operator (`$ne`, `$gt`, `$where`,
 * …) into a filter through the field-name or value position instead of a
 * SQL keyword. `Article` (`article.controller.ts`) is used throughout
 * because it declares explicit allowlists, unlike the zero-config
 * `AuthorController` — the identifier-injection tests need something to be
 * rejected *from*.
 */

let mongoServer: MongoMemoryServer;
let app: INestApplication;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { dbName: "kavo-examples-security" });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot()],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
}, 60_000);

afterAll(async () => {
  try {
    if (app !== undefined) await app.close();
  } finally {
    try {
      await mongoose.disconnect();
    } finally {
      if (mongoServer !== undefined) await mongoServer.stop();
    }
  }
});

function server(): SupertestTarget {
  return boundServer(app.getHttpServer() as SupertestTarget);
}

/** Document count straight off the real collection, bypassing the API entirely. */
async function articleCount(): Promise<number> {
  return Article.countDocuments({});
}

describe("NoSQL operator injection via the query grammar (identifier position)", () => {
  it("rejects a $-operator field name in filter[...] as an unknown field, never reaching the query builder", async () => {
    const before = await articleCount();
    const response = await request(server()).get("/articles").query({ "filter[$where][eq]": "1" }).expect(400);
    expect(response.body).toMatchObject({ code: "KAVO_QUERY_INVALID" });
    expect(response.body.errors).toEqual([expect.objectContaining({ code: "KAVO_QUERY_INVALID_FIELD" })]);
    expect(await articleCount()).toBe(before);
  });

  it("rejects a $-operator field name in sort as an unknown field", async () => {
    const response = await request(server()).get("/articles").query("sort=$where").expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field: "$where", code: "KAVO_QUERY_INVALID_FIELD" }),
    ]);
  });

  it("rejects a $-operator field name in fields= (select) as an unknown field", async () => {
    const response = await request(server()).get("/articles").query("fields=title,$where").expect(400);
    expect(response.body.errors).toEqual([expect.objectContaining({ code: "KAVO_QUERY_INVALID_FIELD" })]);
  });

  it("rejects a non-allowlisted, non-operator field the same way — the allowlist, not operator syntax, is the gate", async () => {
    const response = await request(server()).get("/articles").query("filter[body][eq]=x").expect(400);
    expect(response.body.errors).toEqual([
      expect.objectContaining({ field: "body", code: "KAVO_QUERY_INVALID_FIELD" }),
    ]);
  });
});

describe("NoSQL operator injection via filter values (data position)", () => {
  it("treats a filter value that looks like a Mongo operator object as a literal string, never as $ne/$gt", async () => {
    await request(server()).post("/articles").send({ title: "Legit" }).expect(201);
    const before = await articleCount();

    // A real operator-injection bug (e.g. building `{ $where: rawValue }` or
    // passing an attacker-controlled object straight into the query) would
    // make this match every row. Kavo's filter grammar only ever produces
    // `{ title: { $eq: "<string>" } }` — the value is data, never structure.
    const response = await request(server())
      .get("/articles")
      .query({ "filter[title][eq]": '{"$ne": null}' })
      .expect(200);

    expect(response.body.items).toEqual([]);
    expect(await articleCount()).toBe(before);
  });

  // KNOWN GAP (found writing this suite, not yet fixed): `filter[title][eq]
  // [$ne]=` parses as a nested object under `eq`, which the query
  // normalizer does not reject as a bad *value shape* the way it rejects a
  // bad *field*. It reaches `@kavo/mongoose`'s driver call, which throws a
  // Mongoose cast error, and that surfaces as a 500 `KAVO_PERSISTENCE_FAILED`
  // rather than a 400 `KAVO_QUERY_INVALID`. It is not an actual injection —
  // the driver rejects the malformed query outright, nothing is bypassed —
  // but attacker-controlled input should never reach the persistence layer
  // unvalidated and turn into an unhandled 500. This test pins the current
  // (wrong) behavior so a fix shows up as an intentional change here, not a
  // silent regression; see the roadmap doc's follow-up list.
  it("does not yet reject a nested-object eq value at the query-validation stage — reaches the driver and 500s instead of 400ing (tracked gap)", async () => {
    const response = await request(server()).get("/articles").query("filter[title][eq][$ne]=").expect(500);
    expect(response.body).toMatchObject({ code: "KAVO_PERSISTENCE_FAILED" });
  });

  it("round-trips a value containing Mongo operator syntax as ordinary data on write, without executing it", async () => {
    const before = await articleCount();
    const created = await request(server())
      .post("/articles")
      .send({ title: '{"$where": "this.title.length > 0"}' })
      .expect(201);
    expect(created.body.title).toBe('{"$where": "this.title.length > 0"}');
    expect(await articleCount()).toBe(before + 1);

    const fetched = await request(server())
      .get(`/articles/${created.body._id as string}`)
      .expect(200);
    expect(fetched.body.title).toBe('{"$where": "this.title.length > 0"}');
  });
});

describe("Mass assignment", () => {
  it("does not let a create body set its own _id (client-sent _id is not the identity)", async () => {
    const first = await request(server()).post("/articles").send({ title: "Original" }).expect(201);
    const firstId = first.body._id as string;

    const second = await request(server()).post("/articles").send({ _id: firstId, title: "Attacker" }).expect(201);

    expect(second.body._id).not.toBe(firstId);
    const original = await request(server()).get(`/articles/${firstId}`).expect(200);
    expect(original.body.title).toBe("Original");
  });

  it("ignores an owner-supplied deletedAt on create, never soft-deleting a document on arrival", async () => {
    const created = await request(server())
      .post("/articles")
      .send({ title: "Ghost", deletedAt: new Date().toISOString() })
      .expect(201);
    await request(server())
      .get(`/articles/${created.body._id as string}`)
      .expect(200);
  });

  it("a patch body cannot resurrect a soft-deleted document by smuggling deletedAt: null (must go through restoreOne)", async () => {
    const article = await request(server()).post("/articles").send({ title: "ToDelete" }).expect(201);
    const id = article.body._id as string;
    await request(server()).delete(`/articles/${id}`).expect(204);
    await request(server()).get(`/articles/${id}`).expect(404);

    // deletedAt is absent from every DTO slot (article.dtos.ts's own
    // comment), so the engine's own DTO derivation strips it.
    await request(server()).patch(`/articles/${id}`).send({ deletedAt: null, title: "Sneaky" }).expect(404);
    await request(server()).get(`/articles/${id}`).expect(404);
  });

  it("ignores client-sent createdAt/updatedAt timestamps on create", async () => {
    const spoofed = new Date("1999-01-01T00:00:00.000Z").toISOString();
    const created = await request(server())
      .post("/articles")
      .send({ title: "TimeTraveler", createdAt: spoofed, updatedAt: spoofed })
      .expect(201);
    expect(created.body.createdAt).not.toBe(spoofed);
  });
});

describe("Stored payload safety (JSON API, not an HTML renderer)", () => {
  const XSS_PAYLOAD = "<script>alert(document.cookie)</script>";

  it("stores and returns a script-tag payload as opaque data, verbatim, never executed server-side", async () => {
    const created = await request(server()).post("/articles").send({ title: XSS_PAYLOAD }).expect(201);
    expect(created.body.title).toBe(XSS_PAYLOAD);

    const fetched = await request(server())
      .get(`/articles/${created.body._id as string}`)
      .expect(200);
    expect(fetched.body.title).toBe(XSS_PAYLOAD);
  });

  it("serves every response as application/json, never text/html, so a stored payload cannot be browser-rendered", async () => {
    const created = await request(server())
      .post("/articles")
      .send({ title: XSS_PAYLOAD })
      .expect(201)
      .expect("Content-Type", /application\/json/);

    await request(server())
      .get(`/articles/${created.body._id as string}`)
      .expect(200)
      .expect("Content-Type", /application\/json/);

    await request(server())
      .get("/articles")
      .query({ "filter[title][eq]": XSS_PAYLOAD })
      .expect(200)
      .expect("Content-Type", /application\/json/);
  });

  it("keeps a 404's error detail JSON-encoded, not interpolated as HTML", async () => {
    const response = await request(server())
      .get(`/articles/507f1f77bcf86cd799439011`)
      .expect(404)
      .expect("Content-Type", /application\/problem\+json/);
    expect(response.body.code).toBe("KAVO_NOT_FOUND");
  });
});
