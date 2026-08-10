import { describe, expect, it } from "vitest";
import type { KavoContext, StateKey } from "@kavo/core";
import { DefaultKavoContextState, createKavo, createKavoContext } from "@kavo/core";
import { InMemoryUserAdapter, User, unusedRepository, userMetadata } from "./support/user-fixture.js";

/**
 * The per-request state bag (`context.state`), which is public
 * barrel-exported API that core itself never reads. Nothing in the engine
 * touches it: it exists so an overriding or custom handler can thread a
 * value between pipeline stages of one request, which makes the
 * request-scoping guarantee below the whole point of the feature rather
 * than an implementation detail.
 *
 * `StateKey<T>` is a branded symbol, so the keys are declared the way the
 * `KavoContextState` doc comment declares them.
 */
const StartedAt = Symbol("startedAt") as StateKey<Date>;
const Attempts = Symbol("attempts") as StateKey<number>;
const Absent = Symbol("absent") as StateKey<string>;

function makeCrud(config?: Parameters<ReturnType<typeof createKavo>["createCrud"]>[1]) {
  const adapter = new InMemoryUserAdapter();
  const crud = createKavo().createCrud(User, config as never, { adapter, metadata: userMetadata });
  return { crud, adapter };
}

const ADA = { name: "Ada", email: "ada@example.com", age: 36, status: "active" as const };

describe("DefaultKavoContextState", () => {
  it("round-trips a value under its own key", () => {
    const state = new DefaultKavoContextState();
    const at = new Date("2024-01-01T00:00:00.000Z");

    state.set(StartedAt, at);

    expect(state.get(StartedAt)).toBe(at);
  });

  it("keeps two distinct symbol keys from colliding, even with equal descriptions", () => {
    const state = new DefaultKavoContextState();
    const left = Symbol("shared") as StateKey<string>;
    const right = Symbol("shared") as StateKey<string>;

    state.set(left, "left");
    state.set(right, "right");

    expect(state.get(left)).toBe("left");
    expect(state.get(right)).toBe("right");
  });

  it("answers undefined for a key that was never set", () => {
    const state = new DefaultKavoContextState();

    expect(state.get(Absent)).toBeUndefined();
    expect(state.has(Absent)).toBe(false);
  });

  it("distinguishes a key stored as undefined from one never stored", () => {
    const state = new DefaultKavoContextState();
    state.set(Absent, undefined as never);

    // `get` cannot tell these apart; `has` is the reason the method exists.
    expect(state.get(Absent)).toBeUndefined();
    expect(state.has(Absent)).toBe(true);
  });

  it("overwrites in place rather than accumulating", () => {
    const state = new DefaultKavoContextState();

    state.set(Attempts, 1);
    state.set(Attempts, 2);

    expect(state.get(Attempts)).toBe(2);
  });
});

describe("createKavoContext — state is per request", () => {
  it("hands every context its own bag", () => {
    const config = { entityName: "User" } as never;
    const repository = unusedRepository();
    const first = createKavoContext({ operation: "findOne", config, repository });
    const second = createKavoContext({ operation: "findOne", config, repository });

    first.state.set(Attempts, 1);

    expect(first.state.get(Attempts)).toBe(1);
    expect(second.state.has(Attempts)).toBe(false);
  });

  it("generates a correlation id when the caller supplies none, and keeps one that is supplied", () => {
    const config = { entityName: "User" } as never;
    const repository = unusedRepository();

    const generated = createKavoContext({ operation: "findOne", config, repository });
    const forwarded = createKavoContext({ operation: "findOne", config, repository, correlationId: "upstream-42" });

    expect(generated.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(forwarded.correlationId).toBe("upstream-42");
  });
});

describe("KavoContext.state through the engine", () => {
  it("carries a value a handler wrote for the rest of that request", async () => {
    let readBack: number | undefined;
    const { crud } = makeCrud({
      operations: {
        findOne: {
          handler: {
            async execute(_input: unknown, context: KavoContext<User>) {
              context.state.set(Attempts, 1);
              // Same request, later in the same handler: the bag is live,
              // not a write-only sink.
              readBack = context.state.get(Attempts);
              return Object.assign(new User(), { id: 1, name: "Ada" });
            },
          },
        },
      },
    } as never);

    await crud.findOne(1);

    expect(readBack).toBe(1);
  });

  it("gives the next request a fresh bag", async () => {
    const seen: boolean[] = [];
    const { crud } = makeCrud({
      operations: {
        findOne: {
          handler: {
            async execute(_input: unknown, context: KavoContext<User>) {
              seen.push(context.state.has(Attempts));
              context.state.set(Attempts, 1);
              return Object.assign(new User(), { id: 1, name: "Ada" });
            },
          },
        },
      },
    } as never);

    await crud.findOne(1);
    await crud.findOne(1);

    // Never `[false, true]`: leaking state across requests is exactly what
    // a per-request bag must not do.
    expect(seen).toEqual([false, false]);
  });

  it("is reachable from a write operation's handler too, not only reads", async () => {
    let sawKey = false;
    const { crud } = makeCrud({
      operations: {
        createOne: {
          handler: {
            async execute(input: unknown, context: KavoContext<User>) {
              context.state.set(StartedAt, new Date(0));
              sawKey = context.state.has(StartedAt);
              return Object.assign(new User(), input as object, { id: 1 });
            },
          },
        },
      },
    } as never);

    await crud.createOne(ADA as never);

    expect(sawKey).toBe(true);
  });
});
