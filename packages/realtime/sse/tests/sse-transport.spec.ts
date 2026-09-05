import { describe, expect, it, vi } from "vitest";
import type { EntityMetadata, RealtimeEventDto, ResolvedEntityConfig } from "@kavo/core";
import { createKavo } from "@kavo/core";
import { createTransport, type FilterableEntity } from "@kavo/sse";
import { fakeRequest, fakeResponse, setWritableLength } from "./support/fake-http.js";
import { Book, bookMetadata, InMemoryBookAdapter } from "./support/book-fixture.js";

function createdEvent(overrides: Partial<RealtimeEventDto> = {}): RealtimeEventDto {
  return {
    event: "created",
    entity: "Book",
    id: 1,
    channel: "Book.1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    item: { id: 1, title: "Dune" },
    ...overrides,
  };
}

/**
 * A real `ResolvedEntityConfig`/`EntityMetadata` pair for `Book`, the same
 * way an app would obtain one — off `DefaultKavoService.engine` — rather
 * than hand-building a fake that could drift from the real shape.
 */
function bookFilterable(): FilterableEntity {
  const kavo = createKavo();
  const crud = kavo.createCrud(Book, undefined, { adapter: new InMemoryBookAdapter(), metadata: bookMetadata });
  // Same erasure cast `kavo.ts`'s own `catalog.register` uses to hand a
  // concretely-typed `ResolvedEntityConfig<Book>` to a type-erased consumer
  // — `Entity`'s variance in `ResolvedQueryAllowed` makes a direct
  // assignment to the `object`-parameterized shape fail structurally, even
  // though it's sound at runtime.
  return {
    metadata: crud.engine.metadata as EntityMetadata,
    config: crud.engine.config as unknown as ResolvedEntityConfig,
  };
}

describe("createTransport — name", () => {
  it("identifies itself as 'sse'", () => {
    expect(createTransport({}).name).toBe("sse");
  });
});

describe("createTransport — no authentication of its own", () => {
  it("accepts a subscribe request whether or not it carries a token or Authorization header", async () => {
    const transport = createTransport({});

    for (const url of ["/realtime?channel=Book.1", "/realtime?channel=Book.1&token=whatever"]) {
      const { req } = fakeRequest(url, { accept: "text/event-stream" });
      const res = fakeResponse();
      await transport.handleRequest(req, res);
      expect(res.statusCode).toBe(200);
    }

    const { req } = fakeRequest("/realtime?channel=Book.1", {
      accept: "text/event-stream",
      authorization: "Bearer whatever",
    });
    const res = fakeResponse();
    await transport.handleRequest(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("never produces a 401", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book", { accept: "text/event-stream" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).not.toBe(401);
  });
});

describe("createTransport — handleRequest request shape", () => {
  it("rejects a non-GET method with 400 before opening the stream", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" });
    (req as { method: string }).method = "POST";
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("rejects a request with no 'Accept: text/event-stream' header with 400", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book.1", { accept: "application/json" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("rejects a request with no 'channel' query parameter with 400", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime", { accept: "text/event-stream" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
  });

  it.each(["", ".42", "Book."])("rejects a malformed channel %j with 400", async (channel) => {
    const transport = createTransport({});
    const { req } = fakeRequest(`/realtime?channel=${encodeURIComponent(channel)}`, {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("accepts a bare entity name as a collection-channel subscription (issue #160)", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book", { accept: "text/event-stream" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(transport.connectionCount).toBe(1);
  });
});

describe("createTransport — subscribableFields enforcement", () => {
  it("accepts a 'fields' request naming only allowlisted fields (array form)", async () => {
    const transport = createTransport({
      subscribableFields: (entity) => (entity === "Book" ? ["title", "status"] : undefined),
    });
    const { req } = fakeRequest("/realtime?channel=Book.1&fields=title,status", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
  });

  it("rejects a 'fields' request naming a field outside the allowlist (array form) with 400", async () => {
    const transport = createTransport({
      subscribableFields: (entity) => (entity === "Book" ? ["title", "status"] : undefined),
    });
    const { req } = fakeRequest("/realtime?channel=Book.1&fields=title,price", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toMatchObject({ error: expect.stringContaining("price") });
    expect(transport.connectionCount).toBe(0);
  });

  it("rejects a field named in an 'exclude' selector with 400", async () => {
    const transport = createTransport({
      subscribableFields: () => ({ exclude: ["price"] }),
    });
    const { req } = fakeRequest("/realtime?channel=Book.1&fields=price", { accept: "text/event-stream" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("accepts a field not named by an 'exclude' selector", async () => {
    const transport = createTransport({
      subscribableFields: () => ({ exclude: ["price"] }),
    });
    const { req } = fakeRequest("/realtime?channel=Book.1&fields=title", { accept: "text/event-stream" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
  });

  it("accepts any field when no subscribableFields callback is configured", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book.1&fields=anything", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
  });

  it("accepts any field when the callback returns undefined for that entity", async () => {
    const transport = createTransport({
      subscribableFields: () => undefined,
    });
    const { req } = fakeRequest("/realtime?channel=Book.1&fields=anything", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
  });

  it("skips 'fields'-list validation when no 'fields' param is given, but still resolves the allowlist for payload narrowing", async () => {
    const subscribableFields = vi.fn().mockReturnValue([]);
    const transport = createTransport({ subscribableFields });
    const { req } = fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    // Called once, to capture the allowlist this connection narrows every
    // outgoing item to (unconditionally, per `subscribableFields`'s doc) —
    // not to validate a 'fields' list, since none was given.
    expect(subscribableFields).toHaveBeenCalledWith("Book");
  });
});

describe("createTransport — subscribableFields payload narrowing", () => {
  it("narrows the outgoing item to an array selector even when no 'fields' param was requested", async () => {
    const transport = createTransport({
      subscribableFields: (entity) => (entity === "Book" ? ["title", "status"] : undefined),
    });
    const { req } = fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    await transport.publish(createdEvent({ item: { id: 1, title: "Dune", status: "published", price: 12 } }));

    const body = JSON.parse(res.frames[0]!.match(/^data: (.*)$/m)![1]!) as RealtimeEventDto;
    expect(body.item).toEqual({ title: "Dune", status: "published" });
  });

  it("narrows further to a requested 'fields' subset within the configured allowlist", async () => {
    const transport = createTransport({
      subscribableFields: (entity) => (entity === "Book" ? ["title", "status"] : undefined),
    });
    const { req } = fakeRequest("/realtime?channel=Book.1&fields=title", { accept: "text/event-stream" });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    await transport.publish(createdEvent({ item: { id: 1, title: "Dune", status: "published" } }));

    const body = JSON.parse(res.frames[0]!.match(/^data: (.*)$/m)![1]!) as RealtimeEventDto;
    expect(body.item).toEqual({ title: "Dune" });
  });

  it("narrows to 'not excluded' for an exclude selector, with no 'fields' param", async () => {
    const transport = createTransport({
      subscribableFields: () => ({ exclude: ["price"] }),
    });
    const { req } = fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    await transport.publish(createdEvent({ item: { id: 1, title: "Dune", price: 12 } }));

    const body = JSON.parse(res.frames[0]!.match(/^data: (.*)$/m)![1]!) as RealtimeEventDto;
    expect(body.item).toEqual({ id: 1, title: "Dune" });
  });

  it("delivers the item unnarrowed when no subscribableFields callback is configured", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    await transport.publish(createdEvent({ item: { id: 1, title: "Dune", price: 12 } }));

    const body = JSON.parse(res.frames[0]!.match(/^data: (.*)$/m)![1]!) as RealtimeEventDto;
    expect(body.item).toEqual({ id: 1, title: "Dune", price: 12 });
  });
});

describe("createTransport — opening a stream", () => {
  it("writes text/event-stream response headers and registers the connection", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(false);
    expect(res.headers).toMatchObject({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    expect(transport.connectionCount).toBe(1);
  });

  it("unsubscribes the connection once the underlying request closes", async () => {
    const transport = createTransport({});
    const { req, close } = fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);
    expect(transport.connectionCount).toBe(1);

    close();
    expect(transport.connectionCount).toBe(0);
  });

  it("unsubscribes the connection once the underlying response errors", async () => {
    // The other half of cleanup, alongside the request's own 'close' above —
    // a broken pipe surfaces as an 'error' on the response, not a 'close' on
    // the request, and both must free the connection or a channel accumulates
    // dead subscribers forever.
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" });
    const res = fakeResponse();

    await transport.handleRequest(req, res);
    expect(transport.connectionCount).toBe(1);

    res.emit("error", new Error("ECONNRESET"));
    expect(transport.connectionCount).toBe(0);
  });
});

describe("createTransport — publish", () => {
  it("writes a spec-correct SSE frame (id/event/data) to a subscriber of the matching channel", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    const event = createdEvent();
    await transport.publish(event);

    expect(res.frames).toHaveLength(1);
    const frame = res.frames[0]!;
    expect(frame).toMatch(/^id: \d+\n/);
    expect(frame).toContain(`event: ${event.event}\n`);
    expect(frame).toContain(`data: ${JSON.stringify(event)}\n`);
    expect(frame.endsWith("\n\n")).toBe(true);
  });

  it("does not deliver to a connection subscribed to a different channel", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book.2", { accept: "text/event-stream" });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    await transport.publish(createdEvent({ channel: "Book.1" }));

    expect(res.frames).toHaveLength(0);
  });

  it("is a no-op when no connection is subscribed to the event's channel", async () => {
    const transport = createTransport({});
    await expect(transport.publish(createdEvent())).resolves.toBeUndefined();
  });

  it("fans one event out to every connection subscribed to the same channel", async () => {
    const transport = createTransport({});
    const first = fakeResponse();
    const second = fakeResponse();
    await transport.handleRequest(fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" }).req, first);
    await transport.handleRequest(fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" }).req, second);

    await transport.publish(createdEvent());

    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(1);
    // Same payload delivered to both, not just the same count — a fan-out
    // bug that mutated per-connection state or reused a stale event object
    // would still pass a length-only assertion.
    expect(second.frames[0]).toBe(first.frames[0]);
  });

  it("assigns increasing 'id:' values across successive publishes, shared across channels", async () => {
    const transport = createTransport({});
    const bookRes = fakeResponse();
    const authorRes = fakeResponse();
    await transport.handleRequest(
      fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" }).req,
      bookRes,
    );
    await transport.handleRequest(
      fakeRequest("/realtime?channel=Author.5", { accept: "text/event-stream" }).req,
      authorRes,
    );

    await transport.publish(createdEvent({ channel: "Book.1" }));
    await transport.publish(createdEvent({ entity: "Author", id: 5, channel: "Author.5" }));

    const idOf = (frame: string) => Number(/^id: (\d+)/.exec(frame)![1]);
    // One counter shared across every channel on the transport, not a
    // per-channel one — the second publish landed on a different channel's
    // connection entirely, and its id must still be greater.
    expect(idOf(authorRes.frames[0]!)).toBeGreaterThan(idOf(bookRes.frames[0]!));
  });

  it("drops a connection whose write buffer exceeds bufferLimitBytes instead of blocking other subscribers", async () => {
    const transport = createTransport({ bufferLimitBytes: 10 });
    const slow = fakeResponse();
    const healthy = fakeResponse();
    await transport.handleRequest(fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" }).req, slow);
    await transport.handleRequest(
      fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" }).req,
      healthy,
    );
    setWritableLength(slow, 1_000_000);

    expect(transport.connectionCount).toBe(2);
    await transport.publish(createdEvent());

    expect(slow.frames).toHaveLength(0);
    expect(slow.ended).toBe(true);
    expect(healthy.frames).toHaveLength(1);
    expect(transport.connectionCount).toBe(1);
  });
});

describe("createTransport — collection channel + dual routing", () => {
  it("delivers one write to both an item-channel and a collection-channel subscriber", async () => {
    const transport = createTransport({});
    const itemSub = fakeResponse();
    const collectionSub = fakeResponse();
    await transport.handleRequest(
      fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" }).req,
      itemSub,
    );
    await transport.handleRequest(
      fakeRequest("/realtime?channel=Book", { accept: "text/event-stream" }).req,
      collectionSub,
    );

    await transport.publish(createdEvent());

    expect(itemSub.frames).toHaveLength(1);
    expect(collectionSub.frames).toHaveLength(1);
  });

  it("does not deliver to a collection subscriber of a different entity", async () => {
    const transport = createTransport({});
    const authorSub = fakeResponse();
    await transport.handleRequest(
      fakeRequest("/realtime?channel=Author", { accept: "text/event-stream" }).req,
      authorSub,
    );

    await transport.publish(createdEvent());

    expect(authorSub.frames).toHaveLength(0);
  });

  it("shares one 'id:' across every connection notified by one publish, even across item and collection channels", async () => {
    const transport = createTransport({});
    const itemSub = fakeResponse();
    const collectionSub = fakeResponse();
    await transport.handleRequest(
      fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" }).req,
      itemSub,
    );
    await transport.handleRequest(
      fakeRequest("/realtime?channel=Book&fields=title", { accept: "text/event-stream" }).req,
      collectionSub,
    );

    await transport.publish(createdEvent({ item: { id: 1, title: "Dune", price: 12 } }));

    const idOf = (frame: string) => Number(/^id: (\d+)/.exec(frame)![1]);
    // The collection subscriber's payload is narrowed (differs from the
    // item subscriber's), but both must carry the same event id — they are
    // two views of the same logical write, not two publishes.
    expect(itemSub.frames[0]).not.toBe(collectionSub.frames[0]);
    expect(idOf(itemSub.frames[0]!)).toBe(idOf(collectionSub.frames[0]!));
  });
});

describe("createTransport — subscribe-time filtering (issue #160)", () => {
  it("rejects filter query params with 400 when filterableEntities is not configured", async () => {
    const transport = createTransport({});
    const { req } = fakeRequest("/realtime?channel=Book&filter[status][eq]=published", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
    expect(transport.connectionCount).toBe(0);
  });

  it("accepts a well-formed filter when filterableEntities is configured", async () => {
    const transport = createTransport({
      filterableEntities: (entity) => (entity === "Book" ? bookFilterable() : undefined),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[status][eq]=published", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
  });

  it("accepts a nested AND/OR group filter and still collects every condition field", async () => {
    const transport = createTransport({
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest(
      "/realtime?channel=Book&filter[and][0][status][eq]=published&filter[and][1][or][0][price][gte]=10&filter[and][1][or][1][price][lt]=5",
      { accept: "text/event-stream" },
    );
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(200);
    expect(transport.connectionCount).toBe(1);
  });

  it("rejects a filter field that parses but cannot be evaluated — a relation, not an entity column", async () => {
    // A relation (or computed field) can sit in the filterable allowlist and
    // so parses cleanly, but realtime evaluation only knows the entity's own
    // columns (sse-transport.ts's unevaluable guard).
    const filterableWithRelation = (): FilterableEntity => {
      const kavo = createKavo();
      const metadata = {
        ...bookMetadata,
        relations: [
          {
            name: "author",
            target: () => class {},
            cardinality: "one" as const,
            includable: false,
            strategy: "auto" as const,
          },
        ],
      } as unknown as EntityMetadata<Book>;
      const crud = kavo.createCrud(Book, { filter: { fields: ["title", "status", "author"] } } as never, {
        adapter: new InMemoryBookAdapter(),
        metadata,
      });
      return {
        metadata: crud.engine.metadata as EntityMetadata,
        config: crud.engine.config as unknown as ResolvedEntityConfig,
      };
    };
    const transport = createTransport({ filterableEntities: () => filterableWithRelation() });
    const { req } = fakeRequest("/realtime?channel=Book&filter[author][eq]=1", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toMatchObject({
      error: expect.stringContaining("author"),
    });
    expect(transport.connectionCount).toBe(0);
  });

  it("rejects a malformed filter (unknown operator) with 400 before opening the stream", async () => {
    const transport = createTransport({
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[status][bogus]=published", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toMatchObject({ error: "invalid filter" });
    expect(transport.connectionCount).toBe(0);
  });

  it("rejects a filter naming a field the entity doesn't have, with 400", async () => {
    const transport = createTransport({
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[nope][eq]=x", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
  });

  it("rejects a filter field outside subscribableFields with 400", async () => {
    const transport = createTransport({
      subscribableFields: (entity) => (entity === "Book" ? ["title", "status"] : undefined),
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[price][eq]=12", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();

    await transport.handleRequest(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toMatchObject({ error: expect.stringContaining("price") });
  });

  it("delivers to a filtered collection subscriber only when the published item matches", async () => {
    const transport = createTransport({
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[status][eq]=published", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    await transport.publish(createdEvent({ item: { id: 1, title: "Dune", status: "draft" } }));
    expect(res.frames).toHaveLength(0);

    await transport.publish(createdEvent({ event: "patched", item: { id: 1, title: "Dune", status: "published" } }));
    expect(res.frames).toHaveLength(1);
  });

  it("delivers an 'entering' write as its ordinary event id, not a synthesized one", async () => {
    const transport = createTransport({
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[status][eq]=published", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    // Didn't match before (never delivered), matches now — delivered as the
    // real "patched" event, per the documented enter policy.
    await transport.publish(createdEvent({ event: "patched", item: { id: 1, title: "Dune", status: "published" } }));

    expect(res.frames).toHaveLength(1);
    expect(res.frames[0]).toContain("event: patched\n");
  });

  it("does not deliver a write that makes a row stop matching (leave is silent — documented limitation)", async () => {
    const transport = createTransport({
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[status][eq]=published", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    await transport.publish(createdEvent({ event: "patched", item: { id: 1, title: "Dune", status: "published" } }));
    expect(res.frames).toHaveLength(1);

    await transport.publish(createdEvent({ event: "patched", item: { id: 1, title: "Dune", status: "draft" } }));
    // No second frame: the row left the filtered view silently.
    expect(res.frames).toHaveLength(1);
  });

  it("delivers a 'deleted' event to a filtered subscriber unconditionally, item null (bypass policy)", async () => {
    const transport = createTransport({
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[status][eq]=published", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    // This row never matched the filter — never delivered a create/update —
    // yet its delete is still delivered, per the documented bypass.
    await transport.publish(createdEvent({ event: "deleted", item: null }));

    expect(res.frames).toHaveLength(1);
    expect(res.frames[0]).toContain("event: deleted\n");
  });

  it("never delivers to a filtered subscriber across several writes that never match", async () => {
    const transport = createTransport({
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[status][eq]=published", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    await transport.publish(createdEvent({ item: { id: 1, title: "Dune", status: "draft" } }));
    await transport.publish(
      createdEvent({ event: "patched", item: { id: 1, title: "Dune 2nd ed.", status: "draft" } }),
    );

    expect(res.frames).toHaveLength(0);
  });

  it("delivers from creation when the created item already matches", async () => {
    const transport = createTransport({
      filterableEntities: () => bookFilterable(),
    });
    const { req } = fakeRequest("/realtime?channel=Book&filter[status][eq]=published", {
      accept: "text/event-stream",
    });
    const res = fakeResponse();
    await transport.handleRequest(req, res);

    await transport.publish(createdEvent({ item: { id: 1, title: "Dune", status: "published" } }));

    expect(res.frames).toHaveLength(1);
  });
});

describe("createTransport — close", () => {
  it("ends every open connection and clears the registry", async () => {
    const transport = createTransport({});
    const res = fakeResponse();
    await transport.handleRequest(fakeRequest("/realtime?channel=Book.1", { accept: "text/event-stream" }).req, res);
    expect(transport.connectionCount).toBe(1);

    transport.close();

    expect(res.ended).toBe(true);
    expect(transport.connectionCount).toBe(0);
  });
});
