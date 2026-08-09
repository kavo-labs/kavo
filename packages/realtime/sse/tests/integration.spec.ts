import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKavo } from "@kavo/core";
import { createTransport, type SseTransport } from "@kavo/sse";
import { Book, bookMetadata, InMemoryBookAdapter } from "./support/book-fixture.js";

/**
 * The acceptance criterion's own words: "a real HTTP client consuming the
 * text/event-stream response against a running transport wired to an
 * in-memory Kavo instance". A real `http.Server` plus the platform's own
 * `fetch`, not a mocked request/response — `sse-transport.spec.ts` covers
 * the same logic in isolation with fakes; this suite is what proves the
 * wiring actually works over a socket.
 */

function readSseFrames(body: ReadableStream<Uint8Array>): { next(): Promise<string>; cancel(): Promise<void> } {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function next(): Promise<string> {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before a full SSE frame arrived");
      buffer += decoder.decode(value, { stream: true });
    }
    const end = buffer.indexOf("\n\n") + 2;
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end);
    return frame;
  }

  return { next, cancel: () => reader.cancel() };
}

/**
 * A real client disconnect frees the connection asynchronously — the
 * server only learns about it once the socket teardown propagates to the
 * request's own `close` event, which `handleRequest` listens for. Polling
 * is what proves that actually happens over a genuine socket, as opposed
 * to `sse-transport.spec.ts`'s fake, which only proves the transport reacts
 * correctly *given* a `close` event, not that Node produces one.
 */
async function waitForConnectionCount(transport: SseTransport, expected: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (transport.connectionCount !== expected) {
    if (Date.now() > deadline) {
      throw new Error(`connectionCount never reached ${expected}, stuck at ${transport.connectionCount}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("@kavo/sse — end-to-end over a real HTTP server", () => {
  let server: Server;
  let baseUrl: string;
  let transport: SseTransport;
  let adapter: InMemoryBookAdapter;

  beforeEach(async () => {
    adapter = new InMemoryBookAdapter();
    transport = createTransport({
      subscribableFields: (entity) => (entity === "Book" ? ["title", "status"] : undefined),
    });

    server = createServer((req, res) => {
      void transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("opens the stream over a real socket with no authentication involved", async () => {
    const response = await fetch(`${baseUrl}/realtime?channel=Book.1`, {
      headers: { Accept: "text/event-stream" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(transport.connectionCount).toBe(1);
    await response.body?.cancel();
  });

  it("rejects a 'fields' request naming a field outside subscribableFields with 400", async () => {
    const response = await fetch(`${baseUrl}/realtime?channel=Book.1&fields=title,price`, {
      headers: { Accept: "text/event-stream" },
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("price");
    expect(transport.connectionCount).toBe(0);
  });

  it("delivers a created event as a spec-correct SSE frame to a connected subscriber", async () => {
    const kavo = createKavo({ realtimeTransports: [transport] });
    const crud = kavo.createCrud(Book, { realtime: { enabled: true, events: {} } } as never, {
      adapter,
      metadata: bookMetadata,
    });

    const response = await fetch(`${baseUrl}/realtime?channel=Book.1`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const frames = readSseFrames(response.body!);
    // Book.1: this adapter's ids start at 1, and this is the first write —
    // an entity-level SSE channel is exactly `<entity>.<id>`, known ahead of
    // the write only because nothing else has created a Book yet.
    await crud.createOne({ title: "Dune", status: "draft", price: 999 } as never);

    const frame = await frames.next();

    expect(frame).toMatch(/^id: \d+\n/);
    expect(frame).toContain("event: created\n");

    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))!;
    const event = JSON.parse(dataLine.slice("data: ".length)) as {
      event: string;
      entity: string;
      channel: string;
      item: { title: string };
    };
    expect(event.event).toBe("created");
    expect(event.entity).toBe("Book");
    expect(event.channel).toBe("Book.1");
    expect(event.item).toMatchObject({ title: "Dune" });

    expect(transport.connectionCount).toBe(1);
    await frames.cancel();
    // Proves the real disconnect path over a genuine socket, not just the
    // fake-driven mechanism sse-transport.spec.ts exercises.
    await waitForConnectionCount(transport, 0);
  });
});
