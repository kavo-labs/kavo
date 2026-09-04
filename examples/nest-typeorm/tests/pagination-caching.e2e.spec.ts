import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from "typeorm";
import { Controller, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Kavo, KavoModule } from "@kavo/nest";
import { createInfrastructure } from "@kavo/typeorm";
import { boundServer, listen, type SupertestTarget } from "./support/listen.js";

/**
 * Cursor pagination, `since` pagination, and ETag conditional requests,
 * driven over real HTTP against a real database.
 *
 * Each of the three is well covered a layer at a time — core's engine
 * specs against an in-memory adapter, and (for cursor) each ORM's own
 * suite against SQLite — but nothing ran the whole path: query string →
 * `WireQuery` → normalizer → keyset predicate → SQL → envelope →
 * `meta.nextCursor`/`meta.nextSince` → the client's next request. A token
 * that survives every unit test and still fails to round-trip through a
 * URL and a driver is exactly the bug this file exists to catch.
 *
 * It builds its own module rather than reusing `AppModule`: the reference
 * app is adopter-facing documentation and should keep showing the default
 * offset paging, not carry three extra entities that exist for a test.
 */

@Entity()
class Reading {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  label!: string;

  /** Set explicitly by the seeds, so several rows can share a timestamp. */
  @Column("datetime")
  recordedAt!: Date;
}

@Kavo(Reading, {
  pagination: { strategy: "cursor", defaultLimit: 20, maxLimit: 100 },
  defaults: { sort: ["id"] },
})
@Controller("cursor-readings")
class CursorReadingController {}

@Kavo(Reading, {
  pagination: { strategy: "since", since: { field: "recordedAt" }, defaultLimit: 20, maxLimit: 100 },
})
@Controller("since-readings")
class SinceReadingController {}

@Kavo(Reading, { cache: { etag: true } })
@Controller("cached-readings")
class CachedReadingController {}

let dataSource: DataSource;
let app: INestApplication;
let httpServer: SupertestTarget | undefined;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Reading],
    synchronize: true,
  });
  await dataSource.initialize();

  const moduleRef = await Test.createTestingModule({
    imports: [
      KavoModule.forRoot({ infrastructure: createInfrastructure(dataSource) }),
      KavoModule.forFeature([CursorReadingController, SinceReadingController, CachedReadingController]),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  httpServer = await listen(app);
});

afterAll(async () => {
  httpServer = undefined;
  if (app !== undefined) {
    await app.close();
  }
  if (dataSource !== undefined) {
    await dataSource.destroy();
  }
});

beforeEach(async () => {
  await dataSource.getRepository(Reading).clear();
});

function server(): SupertestTarget {
  return boundServer(httpServer);
}

const BASE = new Date("2024-01-01T00:00:00.000Z");

/** `count` rows, one minute apart, through the ordinary create route. */
async function seed(count: number, path = "cursor-readings"): Promise<void> {
  for (let index = 1; index <= count; index++) {
    await request(server())
      .post(`/${path}`)
      .send({ label: `r-${index}`, recordedAt: new Date(BASE.getTime() + index * 60_000).toISOString() })
      .expect(201);
  }
}

describe("cursor pagination over HTTP", () => {
  it("walks every row exactly once, in order, following nextCursor", async () => {
    await seed(7);

    const labels: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const query = cursor === null ? "?limit=3" : `?limit=3&cursor=${encodeURIComponent(cursor)}`;
      const response = await request(server()).get(`/cursor-readings${query}`).expect(200);
      pages++;
      labels.push(...(response.body.items as { label: string }[]).map((item) => item.label));
      cursor = (response.body.meta?.nextCursor ?? null) as string | null;
      if (cursor === null) {
        break;
      }
      if (pages > 20) {
        throw new Error("cursor paging did not terminate");
      }
    }

    expect(labels).toEqual(["r-1", "r-2", "r-3", "r-4", "r-5", "r-6", "r-7"]);
    expect(pages).toBe(3);
  });

  it("emits a token that survives URL encoding intact", async () => {
    // The whole point of driving this over HTTP: a base64url token has to
    // reach the server byte-identical after a round trip through a query
    // string, or page two silently restarts at page one.
    await seed(4);

    const first = await request(server()).get("/cursor-readings?limit=2").expect(200);
    const token = first.body.meta.nextCursor as string;

    const second = await request(server())
      .get(`/cursor-readings?limit=2&cursor=${encodeURIComponent(token)}`)
      .expect(200);
    expect((second.body.items as { label: string }[]).map((item) => item.label)).toEqual(["r-3", "r-4"]);
  });

  it("reports nextCursor: null on the last page rather than omitting it", async () => {
    await seed(2);

    const page = await request(server()).get("/cursor-readings?limit=5").expect(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.meta).toHaveProperty("nextCursor");
    expect(page.body.meta.nextCursor).toBeNull();
  });

  it("answers a tampered cursor with problem details, not a 500", async () => {
    await seed(2);

    const response = await request(server()).get("/cursor-readings?limit=2&cursor=not-a-real-token").expect(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).toMatchObject({ status: 400 });
  });

  it("ignores an offset param — the cursor alone decides the position", async () => {
    // Asymmetric with the reverse case on purpose, and worth pinning
    // because it is easy to misread: a `cursor` sent under offset paging
    // is a 400 (`KAVO_QUERY_UNSUPPORTED_PARAM`), but `offset` sent under
    // cursor paging is dropped, because `CursorPaginationStrategy` reads
    // only `limit` and `cursor`. A client mixing the two gets page one.
    await seed(3);

    const response = await request(server()).get("/cursor-readings?limit=2&offset=1").expect(200);
    expect((response.body.items as { label: string }[]).map((item) => item.label)).toEqual(["r-1", "r-2"]);
  });
});

describe("since pagination over HTTP", () => {
  it("polls forward through nextSince without repeating or skipping a row", async () => {
    await seed(6, "since-readings");

    const labels: string[] = [];
    let since: string | null = null;
    let polls = 0;
    for (;;) {
      const query = since === null ? "?limit=2" : `?limit=2&since=${encodeURIComponent(since)}`;
      const response = await request(server()).get(`/since-readings${query}`).expect(200);
      polls++;
      const page = response.body.items as { label: string }[];
      labels.push(...page.map((item) => item.label));
      since = (response.body.meta?.nextSince ?? null) as string | null;
      if (since === null || page.length === 0) {
        break;
      }
      if (polls > 20) {
        throw new Error("since paging did not terminate");
      }
    }

    expect(labels).toEqual(["r-1", "r-2", "r-3", "r-4", "r-5", "r-6"]);
  });

  it("emits a human-readable value|id token, unlike cursor's opaque blob", async () => {
    // ADR-0022 makes this token deliberately legible so an operator can
    // read a poll position out of a log line. Pinning the shape here keeps
    // that promise from eroding into an opaque encoding.
    await seed(2, "since-readings");

    const page = await request(server()).get("/since-readings?limit=1").expect(200);
    expect(page.body.meta.nextSince).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|\d+$/);
  });

  it("returns nothing new when polled with the boundary it just issued", async () => {
    await seed(3, "since-readings");

    const first = await request(server()).get("/since-readings?limit=10").expect(200);
    expect(first.body.items).toHaveLength(3);

    const caughtUp = await request(server())
      .get(`/since-readings?limit=10&since=${encodeURIComponent(first.body.meta.nextSince as string)}`)
      .expect(200);
    expect(caughtUp.body.items).toEqual([]);
  });

  it("picks up a row written after the boundary was issued", async () => {
    await seed(2, "since-readings");
    const first = await request(server()).get("/since-readings?limit=10").expect(200);
    const boundary = first.body.meta.nextSince as string;

    await request(server())
      .post("/since-readings")
      .send({ label: "r-late", recordedAt: new Date(BASE.getTime() + 99 * 60_000).toISOString() })
      .expect(201);

    const polled = await request(server())
      .get(`/since-readings?limit=10&since=${encodeURIComponent(boundary)}`)
      .expect(200);
    expect((polled.body.items as { label: string }[]).map((item) => item.label)).toEqual(["r-late"]);
  });

  it("answers a malformed since token with problem details", async () => {
    await seed(1, "since-readings");

    const response = await request(server()).get("/since-readings?since=no-pipe-here").expect(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
  });
});

describe("ETag conditional requests over HTTP", () => {
  async function createReading(label = "etag"): Promise<{ id: number; etag: string }> {
    const created = await request(server())
      .post("/cached-readings")
      .send({ label, recordedAt: BASE.toISOString() })
      .expect(201);
    const id = created.body.id as number;
    const read = await request(server()).get(`/cached-readings/${id}`).expect(200);
    return { id, etag: read.headers["etag"] as string };
  }

  it("serves an ETag on a single-item read", async () => {
    const { etag } = await createReading();
    expect(etag).toMatch(/^"[^"]+"$/);
  });

  it("answers 304 with no body when the client already has that version", async () => {
    const { id, etag } = await createReading();

    const response = await request(server()).get(`/cached-readings/${id}`).set("If-None-Match", etag).expect(304);
    expect(response.body).toEqual({});
  });

  it("serves 200 again once the row changes, with a different tag", async () => {
    const { id, etag } = await createReading();

    await request(server()).patch(`/cached-readings/${id}`).send({ label: "changed" }).expect(200);

    const response = await request(server()).get(`/cached-readings/${id}`).set("If-None-Match", etag).expect(200);
    expect(response.headers["etag"]).not.toBe(etag);
    expect(response.body).toMatchObject({ label: "changed" });
  });

  it("accepts a write whose If-Match names the current version", async () => {
    const { id, etag } = await createReading();

    await request(server()).patch(`/cached-readings/${id}`).set("If-Match", etag).send({ label: "ok" }).expect(200);
  });

  it("refuses a write whose If-Match names a stale version, leaving the row untouched", async () => {
    // The lost-update case the precondition exists for: two clients read
    // the same row, both write, and the second must be told rather than
    // silently overwriting the first.
    const { id, etag } = await createReading();
    await request(server()).patch(`/cached-readings/${id}`).send({ label: "first writer" }).expect(200);

    await request(server())
      .patch(`/cached-readings/${id}`)
      .set("If-Match", etag)
      .send({ label: "second writer" })
      .expect(412);

    const current = await request(server()).get(`/cached-readings/${id}`).expect(200);
    expect(current.body.label).toBe("first writer");
  });

  it("reports a 412 as problem details rather than a bare status", async () => {
    const { id, etag } = await createReading();
    await request(server()).patch(`/cached-readings/${id}`).send({ label: "moved on" }).expect(200);

    const response = await request(server())
      .patch(`/cached-readings/${id}`)
      .set("If-Match", etag)
      .send({ label: "stale" })
      .expect(412);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).toMatchObject({ status: 412 });
  });
});
