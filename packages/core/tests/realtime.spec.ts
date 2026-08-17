import { describe, expect, it } from "vitest";
import type { RealtimeEventDto, RealtimeTransport } from "@kavo/core";
import { ConfigurationException, createKavo } from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";
import { Account, InMemoryAccountAdapter, accountMetadata } from "./support/account-fixture.js";

/** Captures every event handed to it, in order — the fake transport the acceptance criteria calls for. */
class FakeTransport implements RealtimeTransport {
  readonly name = "fake";
  readonly events: RealtimeEventDto[] = [];
  async publish(event: RealtimeEventDto): Promise<void> {
    this.events.push(event);
  }
}

/** A transport whose every publish rejects, for the "never fails the mutation" guarantee. */
class FailingTransport implements RealtimeTransport {
  readonly name = "failing";
  async publish(): Promise<void> {
    throw new Error("boom");
  }
}

function makeCrud(
  entityConfig?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1],
  transports?: readonly RealtimeTransport[],
) {
  const adapter = new InMemoryUserAdapter();
  const kavo = createKavo({ realtimeTransports: transports });
  const crud = kavo.createCrud(User, entityConfig as never, { adapter, metadata: userMetadata });
  return { crud, adapter };
}

describe("realtime — engine emit hook", () => {
  it("is a true no-op with the default (realtime off) settings", async () => {
    const { crud } = makeCrud();
    // No transport is reachable at all with the built-in defaults — this
    // only proves the write path still behaves normally with realtime
    // untouched, which is what "no additional work" means observably.
    const created = await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    expect(created).toMatchObject({ name: "Ada" });
  });

  it("does not throw when enabled but no transports are registered", async () => {
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, []);
    const created = await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    expect(created).toMatchObject({ name: "Ada" });
  });

  it("does not publish when realtime is disabled even with a transport registered", async () => {
    const transport = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: false, events: {} } } as never, [transport]);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    expect(transport.events).toHaveLength(0);
  });

  it("does not publish for read operations", async () => {
    const transport = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, [transport]);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    transport.events.splice(0, transport.events.length);
    await crud.findOne(1);
    await crud.findMany();
    expect(transport.events).toHaveLength(0);
  });

  it("publishes a 'created' event with the full serialized item after createOne", async () => {
    const transport = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, [transport]);
    const before = Date.now();
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);

    expect(transport.events).toHaveLength(1);
    const event = transport.events[0]!;
    expect(event.event).toBe("created");
    expect(event.entity).toBe("User");
    expect(event.id).toBe(1);
    expect(event.channel).toBe("User.1");
    expect(event.item).toMatchObject({ id: 1, name: "Ada", email: "a@x.io" });
    expect(event.changed).toBeUndefined();
    expect(new Date(event.occurredAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("publishes an 'updated' event naming the changed fields after updateOne", async () => {
    const transport = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, [transport]);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    transport.events.splice(0, transport.events.length);

    await crud.updateOne(1, { name: "Ada Lovelace", email: "a@x.io", age: 36, status: "active" } as never);

    expect(transport.events).toHaveLength(1);
    const event = transport.events[0]!;
    expect(event.event).toBe("updated");
    expect(event.id).toBe(1);
    expect(event.channel).toBe("User.1");
    expect(event.item).toMatchObject({ name: "Ada Lovelace" });
    expect(event.changed).toEqual(["name", "email", "age", "status"]);
  });

  it("publishes a 'patched' event naming only the patched fields after patchOne", async () => {
    const transport = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, [transport]);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    transport.events.splice(0, transport.events.length);

    await crud.patchOne(1, { age: 37 } as never);

    expect(transport.events).toHaveLength(1);
    const event = transport.events[0]!;
    expect(event.event).toBe("patched");
    expect(event.item).toMatchObject({ age: 37 });
    expect(event.changed).toEqual(["age"]);
  });

  it("publishes a 'deleted' event with item: null after deleteOne", async () => {
    const transport = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, [transport]);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    transport.events.splice(0, transport.events.length);

    await crud.deleteOne(1);

    expect(transport.events).toHaveLength(1);
    const event = transport.events[0]!;
    expect(event.event).toBe("deleted");
    expect(event.id).toBe(1);
    expect(event.channel).toBe("User.1");
    expect(event.item).toBeNull();
    expect(event.changed).toBeUndefined();
  });

  it("publishes 'restored' and 'deleted' (for purgeOne) on a soft-deletable entity", async () => {
    const transport = new FakeTransport();
    const adapter = new InMemoryAccountAdapter();
    const crud = createKavo({ realtimeTransports: [transport] }).createCrud(
      Account,
      {
        operations: { restoreOne: true, purgeOne: true },
        realtime: { enabled: true, events: {} },
      } as never,
      { adapter, metadata: accountMetadata },
    );

    await crud.createOne({ name: "Acme" } as never);
    await crud.deleteOne(1);
    await crud.restoreOne(1);
    await crud.deleteOne(1);
    await crud.purgeOne(1);

    const eventIds = transport.events.map((event) => event.event);
    expect(eventIds).toEqual(["created", "deleted", "restored", "deleted", "deleted"]);
    expect(transport.events[2]!.item).toMatchObject({ id: 1, name: "Acme" });
    expect(transport.events[4]!.item).toBeNull();
  });

  it("suppresses one event id via events: { <id>: false } while others still emit", async () => {
    const transport = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: true, events: { patched: false } } } as never, [transport]);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    await crud.patchOne(1, { age: 37 } as never);
    await crud.updateOne(1, { name: "Ada L.", email: "a@x.io", age: 37, status: "active" } as never);

    const eventIds = transport.events.map((event) => event.event);
    expect(eventIds).toEqual(["created", "updated"]);
  });

  it("publishes to every registered transport", async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, [first, second]);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);
    expect(first.events[0]!.id).toBe(second.events[0]!.id);
  });

  it("never fails the mutation when a transport's publish rejects", async () => {
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, [new FailingTransport()]);
    const created = await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    expect(created).toMatchObject({ name: "Ada" });
  });

  it("reports a transport's publish failure through onPublishError, not to the caller", async () => {
    const failures: unknown[] = [];
    const { crud } = makeCrud(
      {
        realtime: {
          enabled: true,
          events: {},
          onPublishError: (error: unknown, transport: RealtimeTransport, event: RealtimeEventDto) => {
            failures.push({ error, transportName: transport.name, event: event.event });
          },
        },
      } as never,
      [new FailingTransport()],
    );
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ transportName: "failing", event: "created" });
  });

  it("never fails the mutation even when onPublishError itself throws", async () => {
    // Regression: onPublishError reports a transport's own failure to
    // report — a throw there must not turn back into the "mutation fails"
    // outcome the whole hook exists to avoid.
    const { crud } = makeCrud(
      {
        realtime: {
          enabled: true,
          events: {},
          onPublishError: () => {
            throw new Error("logging itself failed");
          },
        },
      } as never,
      [new FailingTransport()],
    );
    const created = await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    expect(created).toMatchObject({ name: "Ada" });
  });

  it("honors an entity-scope realtime override over the global default (settings precedence)", async () => {
    const globalTransport = new FakeTransport();
    const adapter = new InMemoryUserAdapter();
    const kavo = createKavo({
      defaults: { realtime: { enabled: true, events: {} } },
      realtimeTransports: [globalTransport],
    } as never);
    const crud = kavo.createCrud(User, { realtime: { events: { created: false } } } as never, {
      adapter,
      metadata: userMetadata,
    });

    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);

    // The entity scope only overrode `events`, so `enabled: true` from the
    // global default is still in force — proving `realtime` participates
    // in the same merge chain every other settings key does (SETTINGS_KEYS).
    expect(globalTransport.events).toHaveLength(0);
    await crud.patchOne(1, { age: 37 } as never);
    expect(globalTransport.events).toHaveLength(1);
    expect(globalTransport.events[0]!.event).toBe("patched");
  });

  it("does not freeze a registered transport's own state (deepFreeze stays shallow on live objects)", async () => {
    const transport = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, [transport]);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    await crud.createOne({ name: "Eve", email: "e@x.io", age: 21 } as never);
    // Two pushes onto the same transport's own array — this only stays
    // possible because bootstrap's deepFreeze of the settings tree does
    // not reach into the transport instance itself.
    expect(transport.events).toHaveLength(2);
    expect(Object.isFrozen(transport)).toBe(false);
    expect(Object.isFrozen(transport.events)).toBe(false);
  });
});

describe("realtime — collection-channel support (issue #160)", () => {
  it("exposes the entity metadata a transport needs to parse a subscribe-time filter", () => {
    // `event.entity` already doubles as the collection-channel name a
    // transport routes to — no new `RealtimeEventDto` field — so the only
    // new core surface issue #160 needs is a way for a transport to build a
    // `DefaultFilterParser` for the same entity a `RealtimeTransport`
    // publishes for.
    const { crud } = makeCrud();
    expect(crud.engine.metadata).toBe(userMetadata);
  });

  it("publishes an event whose 'entity' a transport can use as the collection-channel name, unchanged by any per-item channel", async () => {
    const transport = new FakeTransport();
    const { crud } = makeCrud({ realtime: { enabled: true, events: {} } } as never, [transport]);
    await crud.createOne({ name: "Ada", email: "a@x.io", age: 36 } as never);
    await crud.createOne({ name: "Grace", email: "g@x.io", age: 40 } as never);

    // Two different item channels (`User.1`, `User.2`), the same
    // collection channel (`entity: "User"`) — exactly what lets one
    // transport instance route a single event to both kinds of subscriber.
    expect(transport.events.map((event) => event.channel)).toEqual(["User.1", "User.2"]);
    expect(transport.events.every((event) => event.entity === "User")).toBe(true);
  });
});

describe("realtime — createKavo(options).realtimeTransports validation", () => {
  it("rejects a transport with no publish function", () => {
    expect(() => createKavo({ realtimeTransports: [{ name: "bad" }] } as never)).toThrowError(/publish/);
  });

  it("rejects a transport with no name", () => {
    expect(() => createKavo({ realtimeTransports: [{ publish: async () => {} }] } as never)).toThrowError(/name/);
  });

  it("rejects a transport that is not an object — a scalar or null is never a transport", () => {
    for (const transport of [42, "hub", null]) {
      expect(() => createKavo({ realtimeTransports: [transport] } as never)).toThrowError(ConfigurationException);
    }
  });
});
