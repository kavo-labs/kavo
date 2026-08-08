import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { DefaultKavoService, EntityMetadata, ResolvedEntityConfig } from "@kavo/core";
import { getKavoServiceToken } from "@kavo/nest";
import { createSseTransport, type SseTransport } from "@kavo/sse";
import { AppModule } from "../src/app.module.js";
import { Owner } from "../src/owner/owner.entity.js";
import { listen } from "./support/listen.js";

/**
 * Proves the wiring `main.ts` does — `AppModule.forRoot(sql, [sse])` plus
 * mounting `sse.handleRequest` — actually works end to end, not only that
 * `@kavo/sse` and `@kavo/nest`'s `realtimeTransports` pass-through each
 * work in isolation (both already have their own dedicated suites). A real
 * `http.Server` and the platform's own `fetch`, the same reasoning
 * `@kavo/sse`'s own `integration.spec.ts` gives for not mocking this.
 */

let app: INestApplication;
let baseUrl: string;
let sse: SseTransport;

beforeAll(async () => {
  let ownerService: DefaultKavoService<Owner> | undefined;
  sse = createSseTransport({
    filterableEntities: (entityName: string) =>
      entityName === "Owner" && ownerService !== undefined
        ? {
            metadata: ownerService.engine.metadata as EntityMetadata,
            config: ownerService.engine.config as unknown as ResolvedEntityConfig,
          }
        : undefined,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(undefined, [sse])],
  }).compile();
  app = moduleRef.createNestApplication();
  ownerService = app.get(getKavoServiceToken(Owner));

  app
    .getHttpAdapter()
    .getInstance()
    .get("/realtime", (req: unknown, res: unknown) => {
      void sse.handleRequest(req as never, res as never);
    });

  const server = await listen(app);
  const address = (server as unknown as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  sse.close();
  if (app !== undefined) await app.close();
});

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

describe("GET /realtime — Owner writes stream over SSE", () => {
  it("delivers a created event on the item channel", async () => {
    const response = await fetch(`${baseUrl}/realtime?channel=Owner.1`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const frames = readSseFrames(response.body!);
    await fetch(`${baseUrl}/owners`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@example.com" }),
    });

    const frame = await frames.next();
    expect(frame).toContain("event: created\n");
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))!;
    const event = JSON.parse(dataLine.slice("data: ".length)) as { entity: string; channel: string };
    expect(event.entity).toBe("Owner");
    expect(event.channel).toBe("Owner.1");

    await frames.cancel();
  });

  it("delivers to the collection channel, filtered by a query-string filter", async () => {
    const response = await fetch(`${baseUrl}/realtime?channel=Owner&filter[name][eq]=Grace`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);

    const frames = readSseFrames(response.body!);
    // Non-matching write: never delivered.
    await fetch(`${baseUrl}/owners`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Not Grace", email: "notgrace@example.com" }),
    });
    // Matching write: delivered.
    await fetch(`${baseUrl}/owners`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Grace", email: "grace@example.com" }),
    });

    const frame = await frames.next();
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))!;
    const event = JSON.parse(dataLine.slice("data: ".length)) as { item: { name: string } };
    expect(event.item.name).toBe("Grace");

    await frames.cancel();
  });

  it("delivers patched, deleted, and restored events for the same owner in order", async () => {
    const created = await fetch(`${baseUrl}/owners`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lifecycle", email: "lifecycle@example.com" }),
    }).then((r) => r.json() as Promise<{ id: number }>);

    const response = await fetch(`${baseUrl}/realtime?channel=Owner.${created.id}`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    const frames = readSseFrames(response.body!);

    const patchResponse = await fetch(`${baseUrl}/owners/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Lifecycle Renamed" }),
    });
    expect(patchResponse.status).toBe(200);
    const deleteResponse = await fetch(`${baseUrl}/owners/${created.id}`, { method: "DELETE" });
    expect(deleteResponse.status).toBe(204);
    const restoreResponse = await fetch(`${baseUrl}/owners/${created.id}/restore`, { method: "PATCH" });
    expect(restoreResponse.status).toBe(200);

    const events: string[] = [];
    for (let i = 0; i < 3; i++) {
      const frame = await frames.next();
      events.push(/^event: (.+)$/m.exec(frame)![1]!);
    }
    expect(events).toEqual(["patched", "deleted", "restored"]);

    await frames.cancel();
  });

  it("rejects a filter query param with 400 for an entity not wired for filtering (Cat)", async () => {
    const response = await fetch(`${baseUrl}/realtime?channel=Cat&filter[name][eq]=Whiskers`, {
      headers: { Accept: "text/event-stream" },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Cat");
  });

  it("registers and frees the connection, visible on the transport's own connectionCount", async () => {
    expect(sse.connectionCount).toBe(0);

    const response = await fetch(`${baseUrl}/realtime?channel=Owner`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(sse.connectionCount).toBe(1);

    await response.body?.cancel();
    // The server only learns about a client disconnect once the socket
    // teardown propagates — poll rather than assert immediately.
    const deadline = Date.now() + 2000;
    while (sse.connectionCount !== 0) {
      if (Date.now() > deadline) throw new Error(`connectionCount stuck at ${sse.connectionCount}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});
