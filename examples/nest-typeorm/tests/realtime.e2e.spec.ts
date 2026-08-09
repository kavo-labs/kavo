import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type { DefaultKavoService, EntityMetadata, ResolvedEntityConfig } from "@kavo/core";
import { getKavoServiceToken } from "@kavo/nest";
import { createTransport, type SseTransport } from "@kavo/sse";
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

let app: NestExpressApplication;
let baseUrl: string;
let sse: SseTransport;

beforeAll(async () => {
  let ownerService: DefaultKavoService<Owner> | undefined;
  sse = createTransport({
    filterableEntities: (entityName: string) =>
      entityName === "Owner" && ownerService !== undefined
        ? {
            metadata: ownerService.engine.metadata as EntityMetadata,
            config: ownerService.engine.config as unknown as ResolvedEntityConfig,
          }
        : undefined,
    // Mirrors main.ts exactly, so this suite exercises the real
    // configuration rather than a lighter stand-in.
    subscribableFields: (entityName: string) => (entityName === "Owner" ? ["id", "name", "email"] : undefined),
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(undefined, [sse])],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  ownerService = app.get(getKavoServiceToken(Owner));

  app
    .getHttpAdapter()
    .getInstance()
    .get("/realtime", (req: unknown, res: unknown) => {
      void sse.handleRequest(req as never, res as never);
    });
  // Mirrors main.ts's static-asset mount for the manual test page.
  app.useStaticAssets(join(dirname(fileURLToPath(import.meta.url)), "..", "public"));

  const server = await listen(app);
  const address = (server as unknown as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  sse.close();
  if (app !== undefined) await app.close();
});

interface RealtimeFrames {
  next(): Promise<string>;
  /** Parses the next frame's `event:`/`data:` lines together. */
  nextEvent(): Promise<{ event: string; data: Record<string, unknown> }>;
  cancel(): Promise<void>;
}

function readSseFrames(body: ReadableStream<Uint8Array>): RealtimeFrames {
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

  async function nextEvent(): Promise<{ event: string; data: Record<string, unknown> }> {
    const frame = await next();
    const event = /^event: (.+)$/m.exec(frame)![1]!;
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))!;
    const data = JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
    return { event, data };
  }

  return { next, nextEvent, cancel: () => reader.cancel() };
}

async function subscribe(channel: string, extra = ""): Promise<{ status: number; frames: RealtimeFrames }> {
  const response = await fetch(`${baseUrl}/realtime?channel=${channel}${extra}`, {
    headers: { Accept: "text/event-stream" },
  });
  return { status: response.status, frames: readSseFrames(response.body!) };
}

async function createOwner(name: string, email: string): Promise<{ id: number; name: string; email: string }> {
  const response = await fetch(`${baseUrl}/owners`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email }),
  });
  return (await response.json()) as { id: number; name: string; email: string };
}

async function patchOwner(id: number, body: Record<string, unknown>): Promise<number> {
  const response = await fetch(`${baseUrl}/owners/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.status;
}

async function putOwner(id: number, body: Record<string, unknown>): Promise<number> {
  const response = await fetch(`${baseUrl}/owners/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.status;
}

async function deleteOwner(id: number): Promise<number> {
  return (await fetch(`${baseUrl}/owners/${id}`, { method: "DELETE" })).status;
}

async function restoreOwner(id: number): Promise<number> {
  return (await fetch(`${baseUrl}/owners/${id}/restore`, { method: "PATCH" })).status;
}

async function purgeOwner(id: number): Promise<number> {
  return (await fetch(`${baseUrl}/owners/${id}/purge`, { method: "DELETE" })).status;
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

describe("GET /realtime — item channel: every standard event type", () => {
  it("delivers 'updated' on a full PUT replace", async () => {
    const owner = await createOwner("Put Target", "put-target@example.com");
    const { status, frames } = await subscribe(`Owner.${owner.id}`);
    expect(status).toBe(200);

    expect(await putOwner(owner.id, { name: "Put Replaced", email: owner.email })).toBe(200);

    const event = await frames.nextEvent();
    expect(event.event).toBe("updated");
    expect(event.data["entity"]).toBe("Owner");
    await frames.cancel();
  });

  it("delivers 'deleted' for a permanent purge, same event id as a soft delete", async () => {
    const owner = await createOwner("Purge Target", "purge-target@example.com");
    expect(await deleteOwner(owner.id)).toBe(204); // soft delete first — purge needs an already-deleted row

    const { status, frames } = await subscribe(`Owner.${owner.id}`);
    expect(status).toBe(200);

    expect(await purgeOwner(owner.id)).toBe(204);

    const event = await frames.nextEvent();
    expect(event.event).toBe("deleted");
    await frames.cancel();
  });

  it("never delivers another owner's events to this item channel (channel isolation)", async () => {
    const watched = await createOwner("Watched", "watched@example.com");
    const other = await createOwner("Other", "other@example.com");
    const { status, frames } = await subscribe(`Owner.${watched.id}`);
    expect(status).toBe(200);

    await patchOwner(other.id, { name: "Other Renamed" });
    // The only write this subscriber should ever see is the one below —
    // if isolation were broken, this would be the *second* frame, not the
    // first, and `nextEvent()` would return the other owner's patch instead.
    await patchOwner(watched.id, { name: "Watched Renamed" });

    const event = await frames.nextEvent();
    expect(event.data["id"]).toBe(watched.id);
    await frames.cancel();
  });
});

describe("GET /realtime — collection channel: every standard event type reaches it too", () => {
  it("delivers created/patched/deleted/restored/purged, in order, to a bare-entity subscriber", async () => {
    const { status, frames } = await subscribe("Owner");
    expect(status).toBe(200);

    const owner = await createOwner("Collection Lifecycle", "collection-lifecycle@example.com");
    expect(await patchOwner(owner.id, { name: "Renamed" })).toBe(200);
    expect(await deleteOwner(owner.id)).toBe(204);
    expect(await restoreOwner(owner.id)).toBe(200);
    expect(await deleteOwner(owner.id)).toBe(204);
    expect(await purgeOwner(owner.id)).toBe(204);

    const events: string[] = [];
    for (let i = 0; i < 6; i++) events.push((await frames.nextEvent()).event);
    expect(events).toEqual(["created", "patched", "deleted", "restored", "deleted", "deleted"]);

    await frames.cancel();
  });
});

describe("GET /realtime — subscribe-time filtering: transitions", () => {
  it("delivers from creation when the created item already matches", async () => {
    const { status, frames } = await subscribe("Owner", "&filter[name][eq]=MatchesImmediately");
    expect(status).toBe(200);

    await createOwner("MatchesImmediately", "matches@example.com");

    const event = await frames.nextEvent();
    expect((event.data["item"] as { name: string }).name).toBe("MatchesImmediately");
    await frames.cancel();
  });

  it("delivers an 'entering' write as its real event id, not a synthesized one", async () => {
    const owner = await createOwner("EnterMe", "enterme@example.com");
    const { status, frames } = await subscribe("Owner", "&filter[name][eq]=Entered");
    expect(status).toBe(200);

    // Didn't match at creation (filter targets "Entered") — this patch is
    // the write that makes it start matching.
    expect(await patchOwner(owner.id, { name: "Entered" })).toBe(200);

    const event = await frames.nextEvent();
    expect(event.event).toBe("patched");
    await frames.cancel();
  });

  it("delivers 'deleted' unconditionally, even for a row that never matched the filter (bypass policy)", async () => {
    const owner = await createOwner("NeverMatches", "nevermatches@example.com");
    const { status, frames } = await subscribe("Owner", "&filter[name][eq]=SomethingElseEntirely");
    expect(status).toBe(200);

    expect(await deleteOwner(owner.id)).toBe(204);

    const event = await frames.nextEvent();
    expect(event.event).toBe("deleted");
    await frames.cancel();
  });

  it("rejects a malformed filter (unknown operator) with 400 before opening the stream", async () => {
    const response = await fetch(`${baseUrl}/realtime?channel=Owner&filter[name][bogus]=x`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a filter naming a field the entity doesn't have, with 400", async () => {
    const response = await fetch(`${baseUrl}/realtime?channel=Owner&filter[nope][eq]=x`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /realtime — subscribableFields payload narrowing", () => {
  it("narrows the item to id/name/email unconditionally, with no 'fields' param", async () => {
    const { status, frames } = await subscribe("Owner");
    expect(status).toBe(200);

    await createOwner("Narrowed", "narrowed@example.com");

    const event = await frames.nextEvent();
    expect(Object.keys(event.data["item"] as object).sort()).toEqual(["email", "id", "name"]);
    await frames.cancel();
  });

  it("narrows further to a requested 'fields' subset within the allowlist", async () => {
    const { status, frames } = await subscribe("Owner", "&fields=name");
    expect(status).toBe(200);

    await createOwner("Fielded", "fielded@example.com");

    const event = await frames.nextEvent();
    expect(Object.keys(event.data["item"] as object)).toEqual(["name"]);
    await frames.cancel();
  });

  it("rejects a 'fields' request naming a field outside subscribableFields with 400", async () => {
    const response = await fetch(`${baseUrl}/realtime?channel=Owner&fields=startedAt`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a filter field outside subscribableFields with 400, even though it's on the REST filterable allowlist", async () => {
    // `startedAt` is filterable over REST (Owner's allowlist excludes only
    // `deletedAt`) but is not in `subscribableFields` — a subscriber can't
    // scope itself by a field it isn't allowed to receive.
    const response = await fetch(`${baseUrl}/realtime?channel=Owner&filter[startedAt][isNull]=true`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /realtime — one write, multiple simultaneous subscribers", () => {
  it("fans out to an item-channel and a collection-channel subscriber from the same write", async () => {
    const owner = await createOwner("FanOut", "fanout@example.com");
    const item = await subscribe(`Owner.${owner.id}`);
    const collection = await subscribe("Owner");
    expect(item.status).toBe(200);
    expect(collection.status).toBe(200);

    expect(await patchOwner(owner.id, { name: "FanOut Renamed" })).toBe(200);

    const itemEvent = await item.frames.nextEvent();
    const collectionEvent = await collection.frames.nextEvent();
    expect(itemEvent.event).toBe("patched");
    expect(collectionEvent.event).toBe("patched");
    expect(itemEvent.data["id"]).toBe(collectionEvent.data["id"]);

    await item.frames.cancel();
    await collection.frames.cancel();
  });
});

describe("GET /realtime-test.html — the manual test page, served same-origin", () => {
  it("serves the page with no CORS involved (same origin as /realtime and /owners)", async () => {
    const response = await fetch(`${baseUrl}/realtime-test.html`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Kavo /realtime tester");
  });
});
