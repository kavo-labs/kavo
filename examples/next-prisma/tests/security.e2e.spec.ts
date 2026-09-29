import { beforeEach, describe, expect, it } from "vitest";
import { createKavoHandler, type KavoRouteHandlers } from "@kavo/next";
import { buildTestApp } from "./support/app";

/**
 * Attacker-controlled-input coverage over the real stack (`createKavoHandler`
 * -> engine -> `@kavo/prisma` -> real SQLite), the Next.js counterpart of
 * `examples/nest-typeorm/tests/security.e2e.spec.ts` (issue #493). The
 * `describe`/`it` names match that suite wherever a case ports one-to-one, so
 * the shared testkit (#491) can merge them mechanically.
 *
 * Cases that exist only because of this stack: Prisma's nested-write
 * syntax (`author: { create | connect }`) smuggled into a write body, a
 * Prisma operator object smuggled into a filter value, and an encoded path
 * segment in a catch-all route id.
 *
 * Every row count goes straight through the Prisma client, never the API.
 *
 * The harness (`support/app.ts`) wires the entities without the zod `schema`
 * the real `entities/*.service.ts` register, so this suite attacks the
 * framework's own defaults: the entity-derived write allowlist and core's
 * relation narrowing, with no validator in front to strip anything first.
 * That is the stricter test; a validator only removes more.
 */

let prisma: ReturnType<typeof buildTestApp>["prisma"];
let handlers: KavoRouteHandlers;

beforeEach(() => {
  const app = buildTestApp();
  prisma = app.prisma;
  handlers = createKavoHandler({ authors: app.authors, books: app.books });
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One request through the catch-all handler. `segments` is what Next.js hands
 * the route as `params.kavo` (already split and decoded); `search` is the raw
 * query string, kept verbatim so hostile keys reach the wire parser as sent.
 */
function call(method: Method, segments: readonly string[], init: { search?: string; body?: unknown } = {}) {
  const url = `http://localhost/api/${segments.map(encodeURIComponent).join("/")}${init.search ?? ""}`;
  const request = new Request(url, {
    method,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return handlers[method](request, { params: Promise.resolve({ kavo: segments }) });
}

/** `?key=value&…` with each key and value percent-encoded, like a browser would send them. */
function query(params: Record<string, string>): string {
  return `?${new URLSearchParams(params).toString()}`;
}

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createBook(
  body: Record<string, unknown>,
): Promise<{ id: number; title: string; authorId: number | null }> {
  const response = await call("POST", ["books"], { body });
  expect(response.status).toBe(201);
  return json(response);
}

describe("SQL injection via the query grammar (identifier position)", () => {
  it("rejects an injected identifier in filter[...] as an unknown field, never reaching the query builder", async () => {
    const before = await prisma.book.count();
    const response = await call("GET", ["books"], { search: query({ "filter[id) OR 1=1 --][eq]": "1" }) });
    expect(response.status).toBe(400);
    const body = await json<{ code: string; errors: unknown[] }>(response);
    expect(body).toMatchObject({ code: "KAVO_QUERY_INVALID" });
    expect(body.errors).toEqual([expect.objectContaining({ code: "KAVO_QUERY_INVALID_FIELD" })]);
    expect(await prisma.book.count()).toBe(before);
  });

  it("rejects an injected identifier in sort as an unknown field", async () => {
    const response = await call("GET", ["books"], { search: query({ sort: "id; DROP TABLE Book; --" }) });
    expect(response.status).toBe(400);
    expect((await json<{ errors: unknown[] }>(response)).errors).toEqual([
      expect.objectContaining({ field: "id; DROP TABLE Book; --", code: "KAVO_QUERY_INVALID_FIELD" }),
    ]);
    expect(await prisma.book.count()).toBeGreaterThanOrEqual(0); // table still exists: a dropped table would throw
  });

  it("rejects an injected identifier in select= as an unknown field", async () => {
    const response = await call("GET", ["books"], { search: query({ select: "id,title); DROP TABLE Book; --" }) });
    expect(response.status).toBe(400);
    expect((await json<{ errors: unknown[] }>(response)).errors).toEqual([
      expect.objectContaining({ code: "KAVO_QUERY_INVALID_FIELD" }),
    ]);
  });

  it("survives a semicolon-stacked injection attempt across all three positions in one request", async () => {
    await createBook({ title: "Legit" });
    const before = await prisma.book.count();
    const response = await call("GET", ["books"], {
      search: query({
        "filter[title][eq]": "x",
        sort: "title; DROP TABLE Book --",
        select: "id; DROP TABLE Author --",
      }),
    });
    expect(response.status).toBe(400);
    const { errors } = await json<{ errors: { field: string; code: string }[] }>(response);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "title; DROP TABLE Book --", code: "KAVO_QUERY_INVALID_FIELD" }),
        expect.objectContaining({ code: "KAVO_QUERY_INVALID_FIELD" }),
      ]),
    );
    expect(await prisma.book.count()).toBe(before);
    expect(await prisma.author.count()).toBeGreaterThanOrEqual(0);
    // The table is not just present, it still serves ordinary reads.
    expect((await call("GET", ["books"])).status).toBe(200);
  });
});

describe("SQL injection via filter/search values (data position)", () => {
  it("treats a filter value containing SQL metacharacters as a literal, parameterized string", async () => {
    await createBook({ title: "Legit" });
    const before = await prisma.book.count();

    const response = await call("GET", ["books"], { search: query({ "filter[title][eq]": "x' OR '1'='1" }) });

    // No row's title is literally "x' OR '1'='1"; a real injection (a
    // tautology bypassing the WHERE) would instead return every row.
    expect(response.status).toBe(200);
    expect((await json<{ items: unknown[] }>(response)).items).toEqual([]);
    expect(await prisma.book.count()).toBe(before);
  });

  it("treats a search[query] value containing SQL metacharacters as a literal substring, not raw SQL", async () => {
    await createBook({ title: "Legit" });
    const response = await call("GET", ["books"], { search: query({ "search[query]": "'; DROP TABLE Book; --" }) });
    expect(response.status).toBe(200);
    expect((await json<{ items: unknown[] }>(response)).items).toEqual([]);
    expect(await prisma.book.count()).toBe(1); // table still there, row intact
  });

  it("round-trips a value containing SQL metacharacters as ordinary data on write, without executing it", async () => {
    const before = await prisma.book.count();
    const created = await createBook({ title: "Robert'); DROP TABLE Book; --" });
    expect(created.title).toBe("Robert'); DROP TABLE Book; --");
    expect(await prisma.book.count()).toBe(before + 1);

    const fetched = await call("GET", ["books", String(created.id)]);
    expect(fetched.status).toBe(200);
    expect((await json<{ title: string }>(fetched)).title).toBe("Robert'); DROP TABLE Book; --");
  });

  describe("a Prisma operator object smuggled into a filter, never read as a nested where", () => {
    // A title containing "a": if any request below were read as
    // `{ title: { contains: "a" } }`, this row would come back.
    beforeEach(async () => {
      await createBook({ title: "Alpha" });
    });

    async function expectInvalid(search: string, code: string) {
      const response = await call("GET", ["books"], { search });
      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({
        code: "KAVO_QUERY_INVALID",
        errors: [expect.objectContaining({ field: "title", code })],
      });
    }

    it("rejects the bracket form under an operator as an invalid value", async () => {
      await expectInvalid(query({ "filter[title][eq][contains]": "a" }), "KAVO_QUERY_INVALID_VALUE");
    });

    it("rejects the JSON filter form under an operator as an invalid value", async () => {
      await expectInvalid(
        query({ filter: JSON.stringify({ title: { eq: { contains: "a" } } }) }),
        "KAVO_QUERY_INVALID_VALUE",
      );
    });

    it("rejects a Prisma operator name in the operator position as an unknown operator", async () => {
      await expectInvalid(
        query({ filter: JSON.stringify({ title: { contains: "a" } }) }),
        "KAVO_QUERY_INVALID_OPERATOR",
      );
    });

    it("treats a JSON-looking string value as a literal, matching nothing", async () => {
      const response = await call("GET", ["books"], { search: query({ "filter[title][eq]": '{"contains":"a"}' }) });
      expect(response.status).toBe(200);
      expect((await json<{ items: unknown[] }>(response)).items).toEqual([]);
    });
  });
});

describe("Mass assignment", () => {
  it("does not let a create body overwrite an existing row's id (client-sent id is not the identity)", async () => {
    const first = await createBook({ title: "Original" });

    // Attacker guesses/reuses an existing id on a fresh create.
    const second = await createBook({ id: first.id, title: "Attacker" });

    expect(second.id).not.toBe(first.id);
    const original = await prisma.book.findUnique({ where: { id: first.id } });
    expect(original?.title).toBe("Original");
  });

  it("ignores an owner-supplied deletedAt on create, never soft-deleting a row on arrival", async () => {
    const response = await call("POST", ["authors"], {
      body: { name: "Ghost", email: "ghost@example.com", deletedAt: new Date().toISOString() },
    });
    expect(response.status).toBe(201);
    const { id } = await json<{ id: number }>(response);
    expect((await prisma.author.findUnique({ where: { id } }))?.deletedAt).toBeNull();
    expect((await call("GET", ["authors", String(id)])).status).toBe(200);
  });

  it("a patch body cannot resurrect a soft-deleted row by smuggling deletedAt: null (must go through restoreOne)", async () => {
    const created = await call("POST", ["authors"], { body: { name: "ToDelete", email: "todelete@example.com" } });
    const { id } = await json<{ id: number }>(created);
    expect((await call("DELETE", ["authors", String(id)])).status).toBe(204);
    expect((await call("GET", ["authors", String(id)])).status).toBe(404);

    const response = await call("PATCH", ["authors", String(id)], { body: { deletedAt: null, name: "Sneaky" } });
    expect(response.status).toBe(404);
    expect((await prisma.author.findUnique({ where: { id } }))?.deletedAt).not.toBeNull();
    expect((await call("GET", ["authors", String(id)])).status).toBe(404);
  });

  describe("Prisma nested-write syntax smuggled into a write body", () => {
    async function expectRejected(response: Response) {
      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({ code: "KAVO_ASSOCIATION_INVALID_SHAPE" });
    }

    it("rejects a nested create on create, writing neither row", async () => {
      const [authorsBefore, booksBefore] = await Promise.all([prisma.author.count(), prisma.book.count()]);
      await expectRejected(
        await call("POST", ["books"], {
          body: { title: "Trojan", author: { create: { name: "Mallory", email: "mallory@example.com" } } },
        }),
      );
      expect(await prisma.author.count()).toBe(authorsBefore);
      expect(await prisma.book.count()).toBe(booksBefore);
    });

    it("rejects a nested connect on create, never linking the related row", async () => {
      const victim = await prisma.author.create({ data: { name: "Victim", email: "victim@example.com" } });
      await expectRejected(
        await call("POST", ["books"], { body: { title: "Hijack", author: { connect: { id: victim.id } } } }),
      );
      expect(await prisma.book.count({ where: { authorId: victim.id } })).toBe(0);
    });

    it.each(["PATCH", "PUT"] as const)(
      "rejects a nested create in a %s body, leaving the existing link in place",
      async (method) => {
        const author = await prisma.author.create({ data: { name: "Kept", email: "kept@example.com" } });
        const book = await prisma.book.create({ data: { title: "Linked", authorId: author.id } });
        await expectRejected(
          await call(method, ["books", String(book.id)], {
            body: { title: "Renamed", author: { create: { name: "Mallory", email: "mallory2@example.com" } } },
          }),
        );
        expect(await prisma.book.findUnique({ where: { id: book.id } })).toMatchObject({
          title: "Linked",
          authorId: author.id,
        });
        expect(await prisma.author.count()).toBe(1);
      },
    );

    it("never associates through a to-many relation key the entity did not opt in, leaving other rows untouched", async () => {
      // To-many association is opt-in (GHSA-p8cm-xwp6-gvrc): by default the
      // key is not part of the write shape, so it is dropped like any other
      // unknown key and the related row keeps its owner.
      const book = await prisma.book.create({ data: { title: "Elsewhere" } });
      const response = await call("POST", ["authors"], {
        body: { name: "Grabber", email: "grab@example.com", books: [{ id: book.id }] },
      });
      expect(response.status).toBe(201);
      expect((await prisma.book.findUnique({ where: { id: book.id } }))?.authorId).toBeNull();
    });
  });
});

describe("Stored payload safety (JSON API, not an HTML renderer)", () => {
  const XSS_PAYLOAD = "<script>alert(document.cookie)</script>";

  it("stores and returns a script-tag payload as opaque data, verbatim, never executed server-side", async () => {
    const created = await createBook({ title: XSS_PAYLOAD });
    expect(created.title).toBe(XSS_PAYLOAD);

    const fetched = await call("GET", ["books", String(created.id)]);
    expect((await json<{ title: string }>(fetched)).title).toBe(XSS_PAYLOAD);
  });

  it("serves every response as application/json, never text/html, so a stored payload cannot be browser-rendered", async () => {
    const created = await call("POST", ["books"], { body: { title: XSS_PAYLOAD } });
    expect(created.status).toBe(201);
    expect(created.headers.get("Content-Type")).toMatch(/application\/json/);
    const { id } = await json<{ id: number }>(created);

    const fetched = await call("GET", ["books", String(id)]);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("Content-Type")).toMatch(/application\/json/);

    const listed = await call("GET", ["books"], { search: query({ "filter[title][eq]": XSS_PAYLOAD }) });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Content-Type")).toMatch(/application\/json/);
  });

  it("keeps a payload in a 404's error detail JSON-encoded, not interpolated as HTML", async () => {
    const response = await call("GET", ["books", "999999"]);
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toMatch(/application\/problem\+json/);
    expect((await json<{ code: string }>(response)).code).toBe("KAVO_NOT_FOUND");
  });
});

describe("Catch-all route ids (Next.js-specific)", () => {
  // Next.js decodes each `[...kavo]` segment before the handler sees it, and
  // an encoded `/` stays inside its one segment, so these are the ids an
  // attacker can actually deliver. The raw, still-encoded forms are covered
  // too, for a runtime that passes segments through undecoded.
  // Books 1 and 2 and an author exist, so a traversal that resolved to any of
  // them would answer 200, not the 400 an invalid numeric id earns.
  beforeEach(async () => {
    await prisma.author.create({ data: { name: "Admin", email: "admin@example.com" } });
    await createBook({ title: "One" });
    await createBook({ title: "Two" });
  });

  it.each(["../../admin", "..", "1/../2", "..%2F..%2Fadmin", "%2e%2e", "1%2F..%2F2", "%"])(
    "never lets an encoded path segment in an id (%s) reach another route or operation",
    async (id) => {
      const response = await call("GET", ["books", id]);
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toMatch(/application\/problem\+json/);
      expect(await json(response)).toMatchObject({
        errors: [expect.objectContaining({ field: "id", code: "KAVO_QUERY_INVALID_VALUE" })],
      });
    },
  );

  it("does not treat dot segments that arrive as separate segments as navigation", async () => {
    const response = await call("GET", ["books", "..", "authors"]);
    expect(response.status).toBe(404);
  });
});
