import { beforeEach, describe, expect, it } from "vitest";
import { createKavoHandler, type KavoRouteHandlers } from "@kavo/next";
import type { Todo } from "./support/fake-infrastructure.js";
import { buildTodoCrud } from "./support/todo-crud.js";

function call(
  handlers: KavoRouteHandlers,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  segments: readonly string[],
  init: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const url = new URL(`http://localhost/api/${segments.join("/")}`);
  const request = new Request(url, {
    method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return handlers[method](request, { params: Promise.resolve({ kavo: segments }) });
}

describe("createKavoHandler", () => {
  let handlers: KavoRouteHandlers;
  let adapter: ReturnType<typeof buildTodoCrud>["adapter"];

  beforeEach(() => {
    const built = buildTodoCrud();
    handlers = createKavoHandler({ todos: built.service });
    adapter = built.adapter;
  });

  describe("standard CRUD dispatch", () => {
    it("createOne: POST /todos → 201 with the created item", async () => {
      const response = await call(handlers, "POST", ["todos"], {
        body: { title: "buy milk", done: false, priority: 1 },
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as Todo;
      expect(body).toMatchObject({ title: "buy milk", done: false });
      expect(adapter.rows).toHaveLength(1);
    });

    it("findMany: GET /todos → 200 with the list envelope", async () => {
      await adapter.create({ title: "a" });
      await adapter.create({ title: "b" });
      const response = await call(handlers, "GET", ["todos"]);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: unknown[]; limit: number; offset: number; total: number | null };
      expect(body.items).toHaveLength(2);
      expect(body).toMatchObject({ limit: expect.any(Number), offset: 0 });
    });

    it("findOne: GET /todos/:id → 200 with the item", async () => {
      const row = await adapter.create({ title: "find me" });
      const response = await call(handlers, "GET", ["todos", String(row.id)]);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ title: "find me" });
    });

    it("findOne: unknown id → 404 problem-details", async () => {
      const response = await call(handlers, "GET", ["todos", "999"]);
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toBe("application/problem+json");
      const body = (await response.json()) as { code: string; status: number };
      expect(body.code).toBe("KAVO_NOT_FOUND");
      expect(body.status).toBe(404);
    });

    it("updateOne: PUT /todos/:id → 200 with the updated item", async () => {
      const row = await adapter.create({ title: "old", done: false, priority: 0 });
      const response = await call(handlers, "PUT", ["todos", String(row.id)], {
        body: { title: "new", done: true, priority: 2 },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ title: "new", done: true });
    });

    it("patchOne: PATCH /todos/:id → 200 with the patched item", async () => {
      const row = await adapter.create({ title: "old", done: false, priority: 0 });
      const response = await call(handlers, "PATCH", ["todos", String(row.id)], { body: { done: true } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ title: "old", done: true });
    });

    it("deleteOne: DELETE /todos/:id → 204 with no body", async () => {
      const row = await adapter.create({ title: "gone" });
      const response = await call(handlers, "DELETE", ["todos", String(row.id)]);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    });

    it("restoreOne: PATCH /todos/:id/restore → 200", async () => {
      const row = await adapter.create({ title: "soft-deleted" });
      await call(handlers, "DELETE", ["todos", String(row.id)]);
      const response = await call(handlers, "PATCH", ["todos", String(row.id), "restore"]);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: row.id });
    });

    it("purgeOne: DELETE /todos/:id/purge → 204", async () => {
      const row = await adapter.create({ title: "purge me" });
      await call(handlers, "DELETE", ["todos", String(row.id)]);
      const response = await call(handlers, "DELETE", ["todos", String(row.id), "purge"]);
      expect(response.status).toBe(204);
      expect(adapter.rows).toHaveLength(0);
    });
  });

  it("dispatches a custom operation the same way a standard one is (meta.routes segment)", async () => {
    const row = await adapter.create({ title: "invoice", done: false });
    const response = await call(handlers, "POST", ["todos", String(row.id), "mark-paid"]);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Todo;
    expect(body.done).toBe(true);
  });

  describe("query-grammar parity", () => {
    it("parses filter/sort/pagination/include wire params into the same NormalizedQueryContext the engine's own pipeline builds", async () => {
      // The fake adapter only *evaluates* soft-delete visibility — filter/sort
      // evaluation belongs to a real adapter (@kavo/typeorm's suite) — so this
      // asserts the normalized query the engine handed it, the same contract
      // `@kavo/nest`'s wire-query tests assert against.
      const request = new Request(
        "http://localhost/api/todos?filter[priority][gte]=2&sort=-priority&limit=1&offset=0",
        {
          method: "GET",
        },
      );
      const response = await handlers.GET(request, { params: Promise.resolve({ kavo: ["todos"] }) });
      expect(response.status).toBe(200);
      await response.body?.cancel();

      expect(adapter.lastQuery).toMatchObject({
        filter: { root: { field: "priority", operator: "GTE", value: 2 } },
        sort: [{ field: "priority", direction: "desc" }],
        pagination: { limit: 1, offset: 0 },
      });
    });

    it("rejects a non-allowlisted filter field with a validation problem-details, not a 500", async () => {
      const request = new Request("http://localhost/api/todos?filter[nope][eq]=1", { method: "GET" });
      const response = await handlers.GET(request, { params: Promise.resolve({ kavo: ["todos"] }) });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("KAVO_QUERY_INVALID");
    });
  });

  describe("404 handling", () => {
    it("returns 404 for an unknown entity key", async () => {
      const response = await call(handlers, "GET", ["unknown"]);
      expect(response.status).toBe(404);
    });

    it("returns 404 for a method no enabled route matches", async () => {
      // markPaidOne only resolves for POST; PUT on the same path is unmatched.
      const row = await adapter.create({ title: "x" });
      const response = await call(handlers, "PUT", ["todos", String(row.id), "mark-paid"]);
      expect(response.status).toBe(404);
    });

    it("returns 404 for a segment shape no enabled route matches", async () => {
      const response = await call(handlers, "GET", ["todos", "1", "nonsense", "extra"]);
      expect(response.status).toBe(404);
    });
  });

  describe("ETag / conditional requests (ADR-0020)", () => {
    it("sets an ETag on a findOne response", async () => {
      const row = await adapter.create({ title: "tagged" });
      const response = await call(handlers, "GET", ["todos", String(row.id)]);
      expect(response.headers.get("ETag")).not.toBeNull();
    });

    it("rejects a write with a stale If-Match with the standard precondition error", async () => {
      const row = await adapter.create({ title: "guarded" });
      const response = await call(handlers, "PUT", ["todos", String(row.id)], {
        headers: { "If-Match": '"stale"' },
        body: { title: "changed", done: false, priority: 0 },
      });
      expect(response.status).toBe(412);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("KAVO_PRECONDITION_FAILED");
    });
  });
});
