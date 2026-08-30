import { describe, expect, it } from "vitest";
import { canonicalize, computeEtag, strongMatch, weakMatch } from "../src/caching/etag.js";

/**
 * The hash primitive on its own. The engine-level behavior it feeds
 * (which responses carry a tag, which requests are refused) lives in
 * `caching.spec.ts`; this file pins the properties that file relies on.
 */
describe("canonicalize", () => {
  it("is insensitive to object key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("sorts nested keys too", () => {
    expect(canonicalize({ outer: { a: 1, b: 2 } })).toBe(canonicalize({ outer: { b: 2, a: 1 } }));
  });

  it("keeps array order significant", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("distinguishes a missing key from a null one", () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 1, b: null }));
  });

  it("drops undefined members the way JSON encoding does", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it("renders dates as their ISO string", () => {
    expect(canonicalize(new Date("2020-01-01T00:00:00.000Z"))).toBe('"2020-01-01T00:00:00.000Z"');
  });

  it("renders non-finite numbers as null, like JSON.stringify", () => {
    expect(canonicalize({ a: Number.NaN })).toBe(canonicalize({ a: null }));
  });

  it("honors toJSON, so the tag follows the wire form and not the internals", () => {
    // The shape a Prisma `Decimal` has: two values that render identically
    // on the wire but carry different enumerable keys, and two that render
    // differently but share them. Hashing the keys would tag the second
    // pair alike — an ETag collision, which for `If-Match` is a lost
    // update.
    class Decimal {
      constructor(
        private readonly digits: readonly number[],
        private readonly text: string,
      ) {}
      toJSON(): string {
        return this.text;
      }
    }
    expect(canonicalize(new Decimal([1, 2], "12.50"))).toBe('"12.50"');
    expect(canonicalize({ price: new Decimal([1], "12.50") })).toBe(
      canonicalize({ price: new Decimal([9, 9, 9], "12.50") }),
    );
    expect(canonicalize({ price: new Decimal([1], "12.50") })).not.toBe(
      canonicalize({ price: new Decimal([1], "12.51") }),
    );
  });

  it("canonicalizes a toJSON result that is itself an object, keys sorted", () => {
    const wrapped = { toJSON: () => ({ b: 2, a: 1 }) };
    expect(canonicalize(wrapped)).toBe(canonicalize({ a: 1, b: 2 }));
  });

  it("throws an actionable RangeError on a reference cycle instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(RangeError);
    expect(() => canonicalize(cyclic)).toThrow(/nested past 512 levels/);
  });

  it("still handles genuinely deep-but-finite data (well under the limit)", () => {
    let nested: unknown = 1;
    for (let i = 0; i < 100; i++) {
      nested = { inner: nested };
    }
    expect(() => canonicalize(nested)).not.toThrow();
  });
});

describe("computeEtag", () => {
  it("produces a quoted strong entity-tag", async () => {
    const etag = await computeEtag({ id: 1 });
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("is stable for the same representation", async () => {
    expect(await computeEtag({ id: 1, name: "Ada" })).toBe(await computeEtag({ id: 1, name: "Ada" }));
  });

  it("ignores key order, so a DTO field reorder is not a cache miss", async () => {
    expect(await computeEtag({ id: 1, name: "Ada" })).toBe(await computeEtag({ name: "Ada", id: 1 }));
  });

  it("changes when any value changes", async () => {
    expect(await computeEtag({ id: 1, name: "Ada" })).not.toBe(await computeEtag({ id: 1, name: "Grace" }));
  });
});

describe("entity-tag comparison (RFC 9110 §8.8.3)", () => {
  it("strong comparison matches an identical strong tag", () => {
    expect(strongMatch(['"a"'], '"a"')).toBe(true);
  });

  it("strong comparison never matches a weak candidate", () => {
    expect(strongMatch(['W/"a"'], '"a"')).toBe(false);
  });

  it("strong comparison accepts the wildcard", () => {
    expect(strongMatch(["*"], '"a"')).toBe(true);
  });

  it("strong comparison scans every candidate in the list", () => {
    expect(strongMatch(['"x"', '"a"'], '"a"')).toBe(true);
    expect(strongMatch(['"x"', '"y"'], '"a"')).toBe(false);
  });

  it("weak comparison ignores the W/ prefix on either side", () => {
    expect(weakMatch(['W/"a"'], '"a"')).toBe(true);
    expect(weakMatch(['"a"'], 'W/"a"')).toBe(true);
  });

  it("weak comparison accepts the wildcard and rejects a different tag", () => {
    expect(weakMatch(["*"], '"a"')).toBe(true);
    expect(weakMatch(['"b"'], '"a"')).toBe(false);
  });

  it("an empty candidate list never matches", () => {
    expect(strongMatch([], '"a"')).toBe(false);
    expect(weakMatch([], '"a"')).toBe(false);
  });
});

describe("canonicalize — values JSON.stringify cannot encode", () => {
  // `canonicalize` exists because `JSON.stringify` is not a usable hash
  // input: it throws on bigint and drops keys non-deterministically. These
  // are the cases where it has to answer where `JSON.stringify` would not.
  it("renders a bigint as its quoted decimal string instead of throwing", () => {
    expect(canonicalize(10n)).toBe('"10"');
    expect(() => JSON.stringify(10n)).toThrow(TypeError);
  });

  it("keeps a bigint distinct from the same-valued number, so the tags differ", () => {
    expect(canonicalize({ n: 10n })).not.toBe(canonicalize({ n: 10 }));
  });

  it("renders a function or a symbol as null, matching JSON's array behavior", () => {
    expect(canonicalize([() => undefined])).toBe(canonicalize([null]));
    expect(canonicalize([Symbol("s")])).toBe(canonicalize([null]));
  });

  it("still produces a stable tag for a payload carrying one", async () => {
    const left = await computeEtag({ id: 1, at: 9n });
    const right = await computeEtag({ at: 9n, id: 1 });
    expect(left).toBe(right);
  });
});
