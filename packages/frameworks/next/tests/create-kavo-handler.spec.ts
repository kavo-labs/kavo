import { beforeEach, describe, expect, it } from "vitest";
import { createKavoHandler, type KavoRouteHandlers } from "@kavo/next";
import type { StandardSchemaV1 } from "@kavo/core";
import type { Todo } from "./support/fake-infrastructure.js";
import {
  buildTodoCrud,
  buildTodoCrudOnInstance,
  buildTodoCrudWithCollidingCustomOp,
  buildTodoCrudWithValidate,
} from "./support/todo-crud.js";

/** A minimal Standard Schema for tests — no `zod` dependency in this package. */
function fakeSchema(
  check: (value: unknown) => StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>,
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor: "test", validate: check } };
}

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

    it("answers a matching If-None-Match with a bodyless 304", async () => {
      const row = await adapter.create({ title: "cached" });
      const first = await call(handlers, "GET", ["todos", String(row.id)]);
      const etag = first.headers.get("ETag");
      expect(etag).not.toBeNull();

      const second = await call(handlers, "GET", ["todos", String(row.id)], {
        headers: { "If-None-Match": etag as string },
      });
      expect(second.status).toBe(304);
      expect(second.headers.get("ETag")).toBe(etag);
      expect(await second.text()).toBe("");
    });
  });

  describe("request body parsing", () => {
    it("answers malformed JSON with a 400, not a 500", async () => {
      const request = new Request("http://localhost/api/todos", {
        method: "POST",
        body: "{not json",
      });
      const response = await handlers.POST(request, { params: Promise.resolve({ kavo: ["todos"] }) });
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    });

    it("never parses a body for a bodyless write, even a malformed one (restoreOne/purgeOne)", async () => {
      const restoreRow = await adapter.create({ title: "restore me" });
      await call(handlers, "DELETE", ["todos", String(restoreRow.id)]);
      const restoreRequest = new Request(`http://localhost/api/todos/${restoreRow.id}/restore`, {
        method: "PATCH",
        body: "{not json",
      });
      const restoreResponse = await handlers.PATCH(restoreRequest, {
        params: Promise.resolve({ kavo: ["todos", String(restoreRow.id), "restore"] }),
      });
      expect(restoreResponse.status).toBe(200);

      const purgeRow = await adapter.create({ title: "purge me" });
      await call(handlers, "DELETE", ["todos", String(purgeRow.id)]);
      const purgeRequest = new Request(`http://localhost/api/todos/${purgeRow.id}/purge`, {
        method: "DELETE",
        body: "{not json",
      });
      const purgeResponse = await handlers.DELETE(purgeRequest, {
        params: Promise.resolve({ kavo: ["todos", String(purgeRow.id), "purge"] }),
      });
      expect(purgeResponse.status).toBe(204);
    });
  });

  describe("custom-operation vs. standard-route precedence", () => {
    it("a custom operation registered ahead of the standard table wins a route collision", async () => {
      // Registration order is route-generation order (ADR-0012): a custom
      // operation is registered before the standard eight
      // (createOperationRegistry), so a custom route configured to collide
      // with a standard one — same method, same path — is matched first by
      // the same registry.all() iteration order @kavo/nest's route
      // generator relies on for the identical guarantee.
      const built = buildTodoCrudWithCollidingCustomOp();
      const collidingHandlers = createKavoHandler({ todos: built.service });
      const row = await built.adapter.create({ title: "original" });
      const response = await call(collidingHandlers, "GET", ["todos", String(row.id)]);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { title: string };
      expect(body.title).toBe("custom-operation-won");
    });

    it("skips a disabled registry entry while resolving a route (404, never a match)", async () => {
      // restoreOne/purgeOne are absent from this fixture's operations
      // config, so they're disabled — the loop walks past them via
      // `!descriptor.enabled` on every request, not just this one.
      const built = buildTodoCrudWithCollidingCustomOp();
      const handlers = createKavoHandler({ todos: built.service });
      const response = await call(handlers, "PATCH", ["todos", "1", "restore"]);
      expect(response.status).toBe(404);
    });
  });

  describe("edge cases in request-shape resolution", () => {
    it("answers 404 when the App Router hands over no dynamic segments at all", async () => {
      const request = new Request("http://localhost/api", { method: "GET" });
      const response = await handlers.GET(request, { params: Promise.resolve({}) });
      expect(response.status).toBe(404);
    });

    it("skips a non-array param on the way to the catch-all's own array segment", async () => {
      const row = await adapter.create({ title: "found despite a sibling scalar param" });
      const request = new Request(`http://localhost/api/todos/${row.id}`, { method: "GET" });
      const response = await handlers.GET(request, {
        params: Promise.resolve({ locale: "en", kavo: ["todos", String(row.id)] }),
      });
      expect(response.status).toBe(200);
    });

    it("answers 500 (not a body-parsing 400) when reading the body itself fails for a reason other than malformed JSON", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error("stream boom"));
        },
      });
      const request = new Request("http://localhost/api/todos", {
        method: "POST",
        body: stream,
        duplex: "half",
      });
      const response = await handlers.POST(request, { params: Promise.resolve({ kavo: ["todos"] }) });
      expect(response.status).toBe(500);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("KAVO_UNEXPECTED_ERROR");
    });
  });

  describe("EntityConfig.validate (ADR-0056)", () => {
    const rejectEmptyTitle = fakeSchema((body) => {
      const title = (body as { title?: unknown } | null)?.title;
      if (typeof title === "string" && title.length > 0) {
        return { value: body };
      }
      return { issues: [{ path: ["title"], message: "title must be a non-empty string" }] };
    });

    it("rejects a body its create schema fails with a 400 problem-details response", async () => {
      const built = buildTodoCrudWithValidate({ create: rejectEmptyTitle });
      const validated = createKavoHandler({ todos: built.service });

      const response = await call(validated, "POST", ["todos"], { body: { title: "" } });
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toBe("application/problem+json");
      const responseBody = (await response.json()) as {
        code: string;
        errors: { path: string[]; message: string }[];
      };
      expect(responseBody.code).toBe("KAVO_NEXT_BODY_VALIDATION_FAILED");
      expect(responseBody.errors).toEqual([{ path: ["title"], message: "title must be a non-empty string" }]);
      expect(built.adapter.rows).toHaveLength(0);
    });

    it("dispatches the schema's (possibly transformed) value, not the raw body", async () => {
      const upperCaseTitle = fakeSchema((body) => {
        const { title, ...rest } = body as { title: string };
        return { value: { ...rest, title: title.toUpperCase() } };
      });
      const built = buildTodoCrudWithValidate({ create: upperCaseTitle });
      const validated = createKavoHandler({ todos: built.service });

      const response = await call(validated, "POST", ["todos"], { body: { title: "buy milk" } });
      expect(response.status).toBe(201);
      const created = (await response.json()) as { title: string };
      expect(created.title).toBe("BUY MILK");
    });

    it("resolves the schema by write slot — create/update/patch dispatch to their own schema", async () => {
      const seenSlots: string[] = [];
      const record = (slot: string) =>
        fakeSchema((body) => {
          seenSlots.push(slot);
          return { value: body };
        });
      const built = buildTodoCrudWithValidate({
        create: record("create"),
        update: record("update"),
        patch: record("patch"),
      });
      const validated = createKavoHandler({ todos: built.service });

      const created = await call(validated, "POST", ["todos"], { body: { title: "a" } });
      const row = (await created.json()) as { id: number };
      await call(validated, "PUT", ["todos", String(row.id)], { body: { title: "b", done: false, priority: 0 } });
      await call(validated, "PATCH", ["todos", String(row.id)], { body: { done: true } });

      expect(seenSlots).toEqual(["create", "update", "patch"]);
    });

    it("leaves an entity with no registered validate schema dispatching unvalidated", async () => {
      const built = buildTodoCrud();
      const validated = createKavoHandler({ todos: built.service });

      const response = await call(validated, "POST", ["todos"], { body: { title: "unvalidated" } });
      expect(response.status).toBe(201);
    });

    it("never runs the schema for GET, DELETE, or a bodyless write", async () => {
      let calls = 0;
      const countCalls = fakeSchema((body) => {
        calls++;
        return { value: body };
      });
      const built = buildTodoCrudWithValidate({ create: countCalls });
      const validated = createKavoHandler({ todos: built.service });

      const created = await call(validated, "POST", ["todos"], { body: { title: "a" } });
      const row = (await created.json()) as { id: number };
      expect(calls).toBe(1);

      await call(validated, "GET", ["todos", String(row.id)]);
      await call(validated, "DELETE", ["todos", String(row.id)]);
      expect(calls).toBe(1);
    });

    it("awaits an async schema's validate() result", async () => {
      const asyncSchema = fakeSchema(async (body) => {
        await Promise.resolve();
        return { value: body };
      });
      const built = buildTodoCrudWithValidate({ create: asyncSchema });
      const validated = createKavoHandler({ todos: built.service });

      const response = await call(validated, "POST", ["todos"], { body: { title: "async" } });
      expect(response.status).toBe(201);
    });
  });

  describe("auto-discovery from a KavoInstance", () => {
    it("serves every entity registered on the root, keyed by lowercase-first entityName", async () => {
      const built = buildTodoCrudOnInstance();
      const autoHandlers = createKavoHandler(built.instance);
      const created = await call(autoHandlers, "POST", ["todo"], { body: { title: "auto-discovered" } });
      expect(created.status).toBe(201);
      expect(built.adapter.rows).toHaveLength(1);

      const found = await call(autoHandlers, "GET", ["todo", String(built.adapter.rows[0]!.id)]);
      expect(found.status).toBe(200);
      expect(await found.json()).toMatchObject({ title: "auto-discovered" });
    });

    it("404s an unregistered key the way the explicit-map form does", async () => {
      const built = buildTodoCrudOnInstance();
      const autoHandlers = createKavoHandler(built.instance);
      const response = await call(autoHandlers, "GET", ["nonexistent"]);
      expect(response.status).toBe(404);
    });

    it("leaves the explicit Record<string, DefaultKavoService> form unaffected", async () => {
      const built = buildTodoCrudOnInstance();
      const explicitHandlers = createKavoHandler({ todos: built.service });
      const response = await call(explicitHandlers, "GET", ["todos"]);
      expect(response.status).toBe(200);
      // The auto-discovery key ("todo") is not registered by the explicit map.
      const autoKeyResponse = await call(explicitHandlers, "GET", ["todo"]);
      expect(autoKeyResponse.status).toBe(404);
    });
  });
});
