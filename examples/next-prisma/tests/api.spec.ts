import { describe, expect, it } from "vitest";
import { buildKavoSchemas, createKavoHandler, type KavoRouteHandlers } from "@kavo/next";
import { buildTestApp } from "./support/app";

function call(
  handlers: KavoRouteHandlers,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  segments: readonly string[],
  init: { body?: unknown } = {},
): Promise<Response> {
  const url = new URL(`http://localhost/api/${segments.join("/")}`);
  const request = new Request(url, {
    method,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return handlers[method](request, { params: Promise.resolve({ kavo: segments }) });
}

describe("next-prisma example app", () => {
  it("creates an author and a book, and reads them back over the catch-all route", async () => {
    const { authors, books } = buildTestApp();
    const handlers = createKavoHandler({ authors, books });

    const authorResponse = await call(handlers, "POST", ["authors"], {
      body: { name: "Ada Lovelace", email: "ada@example.com" },
    });
    expect(authorResponse.status).toBe(201);
    const author = (await authorResponse.json()) as { id: number };

    const bookResponse = await call(handlers, "POST", ["books"], {
      body: { title: "Notes on the Analytical Engine", authorId: author.id },
    });
    expect(bookResponse.status).toBe(201);
    const book = (await bookResponse.json()) as { id: number; published: boolean };
    expect(book.published).toBe(false);

    const listResponse = await call(handlers, "GET", ["books"]);
    const list = (await listResponse.json()) as { items: unknown[]; total: number | null };
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);

    const includeUrl = new URL(`http://localhost/api/books/${book.id}?include=author`);
    const includeRequest = new Request(includeUrl, { method: "GET" });
    const includeResponse = await handlers.GET(includeRequest, {
      params: Promise.resolve({ kavo: ["books", String(book.id)] }),
    });
    expect(includeResponse.status).toBe(200);
    const included = (await includeResponse.json()) as { author: { name: string } | null };
    expect(included.author?.name).toBe("Ada Lovelace");
  });

  it("dispatches the publishOne custom operation over the same catch-all route", async () => {
    const { authors, books } = buildTestApp();
    const handlers = createKavoHandler({ authors, books });

    const bookResponse = await call(handlers, "POST", ["books"], { body: { title: "Draft" } });
    const book = (await bookResponse.json()) as { id: number };

    const publishResponse = await call(handlers, "POST", ["books", String(book.id), "publish"]);
    expect(publishResponse.status).toBe(201);
    const published = (await publishResponse.json()) as { published: boolean };
    expect(published.published).toBe(true);
  });

  it("filters and sorts books through the wire query grammar", async () => {
    const { authors, books } = buildTestApp();
    const handlers = createKavoHandler({ authors, books });

    await call(handlers, "POST", ["books"], { body: { title: "A" } });
    const publishedResponse = await call(handlers, "POST", ["books"], { body: { title: "B" } });
    const published = (await publishedResponse.json()) as { id: number };
    await call(handlers, "POST", ["books", String(published.id), "publish"]);

    const response = await call(handlers, "GET", ["books"]);
    const url = new URL("http://localhost/api/books?filter[published][eq]=true");
    const request = new Request(url, { method: "GET" });
    const filtered = await handlers.GET(request, { params: Promise.resolve({ kavo: ["books"] }) });
    const body = (await filtered.json()) as { items: { title: string; published: boolean }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.title).toBe("B");
    await response.body?.cancel();
  });

  it("returns a problem-details 404 for an unknown book id", async () => {
    const { authors, books } = buildTestApp();
    const handlers = createKavoHandler({ authors, books });

    const response = await call(handlers, "GET", ["books", "999999"]);
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  });

  it("rejects a create body that fails the entity's own Zod schema (EntityConfig.validate) with a 400", async () => {
    const { authors, books } = buildTestApp();
    const handlers = createKavoHandler({ authors, books });

    const response = await call(handlers, "POST", ["authors"], { body: { name: "", email: "not-an-email" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    const body = (await response.json()) as { code: string; errors: { path: string[] }[] };
    expect(body.code).toBe("KAVO_NEXT_BODY_VALIDATION_FAILED");
    expect(body.errors.map((issue) => issue.path)).toEqual(expect.arrayContaining([["name"], ["email"]]));
  });

  it("still creates a valid entity once its EntityConfig.validate schema passes", async () => {
    const { authors, books } = buildTestApp();
    const handlers = createKavoHandler({ authors, books });

    const response = await call(handlers, "POST", ["books"], { body: { title: "Valid Title" } });
    expect(response.status).toBe(201);
    const book = (await response.json()) as { title: string };
    expect(book.title).toBe("Valid Title");
  });

  it("serves component schemas over /api/openapi.json's own buildKavoSchemas call", () => {
    const { authors, books } = buildTestApp();
    const { schemas } = buildKavoSchemas({ authors, books });
    expect(schemas).toHaveProperty("AuthorItem");
    expect(schemas).toHaveProperty("BookItem");
    expect(schemas).toHaveProperty("KavoProblemDetails");
  });
});
