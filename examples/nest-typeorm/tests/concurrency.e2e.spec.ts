import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * Two overlapping requests against the same row, over the real stack
 * (generated Nest routes -> engine -> `@kavo/typeorm` -> real SQLite).
 * ADR-0020's optimistic-concurrency contract (`If-Match` -> 412
 * `KAVO_PRECONDITION_FAILED`) is unit-pinned in `packages/core/tests/
 * caching.spec.ts` and wired end to end (fake adapter) in `packages/
 * frameworks/nest/tests/caching.e2e.spec.ts`; this file is the missing
 * "actually race two writers" case neither of those runs, and the
 * documented alternative for a caller that sends no precondition at all:
 * last-write-wins, not a silently dropped write.
 */

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot()],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
});

function server(): SupertestTarget {
  return boundServer(app.getHttpServer() as SupertestTarget);
}

async function createCat(): Promise<{ id: number; etag: string }> {
  const created = await request(server())
    .post("/cats")
    .send({ name: "Racer", age: 1, size: "small", indoor: true, livesLeft: 9 })
    .expect(201);
  return { id: created.body.id as number, etag: created.headers.etag as string };
}

describe("Concurrent writes against the same row (real HTTP + SQLite)", () => {
  it("two writers racing with no If-Match: both succeed, the row ends on the later response's values (last-write-wins, not a silent drop)", async () => {
    const { id } = await createCat();

    const [first, second] = await Promise.all([
      request(server())
        .put(`/cats/${id}`)
        .send({ name: "WriterA", age: 2, size: "small", indoor: true, livesLeft: 8 })
        .expect(200),
      request(server())
        .put(`/cats/${id}`)
        .send({ name: "WriterB", age: 3, size: "medium", indoor: false, livesLeft: 7 })
        .expect(200),
    ]);

    // Both requests were accepted — neither writer was told its update was
    // lost — and the stored row matches whichever request the database
    // actually applied last, not some merged or corrupted hybrid.
    const final = await request(server()).get(`/cats/${id}`).expect(200);
    const winner = final.body.name === first.body.name ? first.body : second.body;
    expect(final.body).toMatchObject({ name: winner.name, age: winner.age, size: winner.size });
  });

  it("a stale If-Match loses the race: the second writer's stale ETag is rejected with 412, the first writer's update stands", async () => {
    const { id, etag } = await createCat();

    // Writer A updates first, using the ETag from creation — moves the row
    // to a new ETag.
    const updatedByA = await request(server())
      .put(`/cats/${id}`)
      .set("If-Match", etag)
      .send({ name: "WriterA", age: 2, size: "small", indoor: true, livesLeft: 8 })
      .expect(200);

    // Writer B still holds the *original* ETag (its read raced ahead of
    // Writer A's write) and tries to update against it.
    const rejected = await request(server())
      .put(`/cats/${id}`)
      .set("If-Match", etag)
      .send({ name: "WriterB", age: 3, size: "medium", indoor: false, livesLeft: 7 })
      .expect(412)
      .expect("Content-Type", /application\/problem\+json/);
    expect(rejected.body).toMatchObject({ code: "KAVO_PRECONDITION_FAILED", status: 412 });

    // The row reflects Writer A's update only — Writer B's rejected write
    // never touched it.
    const final = await request(server()).get(`/cats/${id}`).expect(200);
    expect(final.body).toMatchObject({ name: "WriterA", age: 2 });
    expect(final.headers.etag).toBe(updatedByA.headers.etag);
  });

  it("a writer that re-reads after losing the race, then retries with the fresh ETag, succeeds", async () => {
    const { id, etag } = await createCat();

    await request(server())
      .put(`/cats/${id}`)
      .set("If-Match", etag)
      .send({ name: "WriterA", age: 2, size: "small", indoor: true, livesLeft: 8 })
      .expect(200);

    const rejected = await request(server())
      .put(`/cats/${id}`)
      .set("If-Match", etag)
      .send({ name: "WriterB", age: 3, size: "medium", indoor: false, livesLeft: 7 })
      .expect(412);
    void rejected;

    // Writer B re-reads to get the current ETag, then retries.
    const fresh = await request(server()).get(`/cats/${id}`).expect(200);
    const retried = await request(server())
      .put(`/cats/${id}`)
      .set("If-Match", fresh.headers.etag as string)
      .send({ name: "WriterB", age: 3, size: "medium", indoor: false, livesLeft: 7 })
      .expect(200);
    expect(retried.body).toMatchObject({ name: "WriterB", age: 3 });
  });

  it("two concurrent deletes: the first succeeds, the second 404s rather than double-deleting silently", async () => {
    const { id } = await createCat();

    const results = await Promise.allSettled([
      request(server()).delete(`/cats/${id}`),
      request(server()).delete(`/cats/${id}`),
    ]);

    const statuses = results
      .map((result) => (result.status === "fulfilled" ? result.value.status : -1))
      .sort((a, b) => a - b);
    // One winner (204), one loser — 404 (row already gone) is the only
    // acceptable loser status; a 500 would mean the second delete crashed
    // instead of finding nothing.
    expect(statuses).toEqual([204, 404]);

    await request(server()).get(`/cats/${id}`).expect(404);
  });
});
