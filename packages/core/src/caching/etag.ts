/**
 * ETag computation and conditional-request matching (RFC 9110 §8.8, §13.1).
 *
 * The tag is a **content hash of the serialized representation**, not a
 * version column read from the database — which is what keeps the whole
 * feature inside core plus the framework layer, with nothing asked of any
 * ORM adapter. The cost of that choice is stated plainly in ADR-0020: an
 * `If-Match` check is application-level check-then-write, never an atomic
 * compare-and-swap.
 */

import type { CacheSettings } from "../config/settings.js";

/**
 * Whether the conditional-request machinery is on for a resolved `cache`
 * subtree (ADR-0031). `cache: false` turns etags off with the whole
 * subtree; otherwise `etag` answers directly, independent of `cache.ttl`,
 * so an entity with result caching off still serves ETags. The engine and
 * the framework layer both need this resolved answer, which is why it
 * lives here rather than in either.
 */
export function isEtagEnabled(cache: CacheSettings | false): boolean {
  if (cache === false) {
    return false;
  }
  return cache.etag;
}

/**
 * Incoming conditional-request tokens, transport-agnostic. Each entry is a
 * whole entity-tag as it appeared on the wire — `"abc"` (quotes included),
 * `W/"abc"`, or the wildcard `*` — because that is what the comparison
 * rules below are defined over. `@kavo/nest` parses these out of
 * `If-Match`/`If-None-Match`; a programmatic caller may pass them directly
 * on `KavoRequest.preconditions` or `KavoCallOptions.preconditions`.
 */
export interface RequestPreconditions {
  readonly ifMatch?: readonly string[];
  readonly ifNoneMatch?: readonly string[];
}

/**
 * `If-Match: *` / `If-None-Match: *` — "any current representation".
 * Exported for the engine, which short-circuits the `If-Match` pre-read on
 * it: `strongMatch` answers the wildcard without looking at the tag, so
 * computing one is provably wasted work.
 */
export const WILDCARD = "*";

const WEAK_PREFIX = "W/";

/**
 * Web Crypto and `TextEncoder` are runtime globals on every supported
 * platform (Node ≥ 20, browsers, workers), but `@kavo/core` compiles
 * against pure ES lib types with zero imports (ADR-0005) — so they are
 * reached through a typed accessor, exactly the way `randomUuid` reaches
 * `crypto.randomUUID`. A `node:crypto` import would fail `pnpm depcruise`,
 * not merely bend a convention.
 */
interface WebGlobals {
  readonly crypto: {
    readonly subtle: {
      digest(algorithm: string, data: ArrayBufferView): Promise<ArrayBuffer>;
    };
  };
  readonly TextEncoder: new () => { encode(input: string): Uint8Array };
}

const webGlobals = globalThis as unknown as WebGlobals;

/**
 * One encoder for the process: `TextEncoder` is stateless (`encode` reads
 * no instance state and returns a fresh array), so allocating one per
 * response was pure garbage on the hot path.
 */
const textEncoder = new webGlobals.TextEncoder();

/**
 * The strong entity-tag for one serialized representation — quoted, so the
 * value is what an `ETag` header carries verbatim and what an `If-Match`
 * token is compared against without re-parsing.
 *
 * SHA-256 rather than a cheap non-cryptographic hash on purpose: for
 * `If-Match` a collision is a silently lost update, which is the one
 * failure mode this feature exists to prevent.
 */
export async function computeEtag(representation: unknown): Promise<string> {
  const bytes = textEncoder.encode(canonicalize(representation));
  const digest = new Uint8Array(await webGlobals.crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (let index = 0; index < digest.length; index++) {
    hex += (digest[index] as number).toString(16).padStart(2, "0");
  }
  return `"${hex}"`;
}

/**
 * A canonical string form of a serialized representation: **object keys
 * sorted**, so the tag depends on the representation's content and not on
 * the key insertion order the DTO projection happened to produce. Plain
 * `JSON.stringify` would make an ETag change when a DTO's field order
 * changed, which is a spurious cache miss and a spurious 412.
 *
 * Otherwise it follows `JSON.stringify`'s conventions — `toJSON` is
 * honored, `undefined` object members are dropped, `undefined` array
 * members become `null`, dates render as ISO strings — because the
 * representation being hashed is the one about to be JSON-encoded onto the
 * wire. `toJSON` is not a nicety: a value type whose `toJSON` distinguishes
 * states its own enumerable keys do not (a `Decimal` renders as `"12.50"`
 * but carries `{ d, e, s }`) would otherwise hash two different wire forms
 * to the same tag — an ETag collision, which for `If-Match` is a lost
 * update.
 *
 * A reference cycle (or absurdly deep nesting) throws a `RangeError` with
 * an actionable message at `MAX_DEPTH` rather than recursing to an opaque
 * stack overflow. No real DTO or `KavoAppContext` comes near that depth;
 * hitting it means a cyclic object reached the ETag/cache-key path.
 */
const MAX_DEPTH = 512;

export function canonicalize(input: unknown): string {
  return canonicalizeAt(input, 0);
}

function canonicalizeAt(input: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new RangeError(
      `canonicalize: value nested past ${MAX_DEPTH} levels — a reference cycle, or an object too deep to hash. ` +
        "A KavoAppContext used with the result cache must be plain, shallow, acyclic data.",
    );
  }
  const value = unwrapToJson(input);
  if (value === null || value === undefined) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(value.toString());
    case "object":
      break;
    default:
      // Functions and symbols never survive JSON encoding either.
      return "null";
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalizeAt(element, depth + 1)).join(",")}]`;
  }
  const source = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(source).sort()) {
    const member = source[key];
    if (member === undefined) {
      continue;
    }
    members.push(`${JSON.stringify(key)}:${canonicalizeAt(member, depth + 1)}`);
  }
  return `{${members.join(",")}}`;
}

/**
 * `JSON.stringify`'s first step on every node: call `toJSON()` when the
 * value has one. Applied **once per node** — a `toJSON` that returns the
 * receiver is then canonicalized by its own keys rather than looping,
 * which is stricter than `JSON.stringify`, and the members it yields are
 * unwrapped by their own `canonicalize` call.
 */
function unwrapToJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const candidate = (value as { toJSON?: unknown }).toJSON;
  if (typeof candidate !== "function") {
    return value;
  }
  return (candidate as (this: unknown) => unknown).call(value);
}

/**
 * `If-Match` uses the **strong** comparison function (RFC 9110 §8.8.3.2):
 * a weak tag never matches, because the client is about to overwrite the
 * resource and a weak tag only promises semantic equivalence.
 */
export function strongMatch(candidates: readonly string[], etag: string): boolean {
  return candidates.some((candidate) => candidate === WILDCARD || (!isWeak(candidate) && candidate === etag));
}

/**
 * `If-None-Match` uses the **weak** comparison function: the client is
 * asking "is my cached copy still good enough", so a `W/` prefix on either
 * side is ignored.
 */
export function weakMatch(candidates: readonly string[], etag: string): boolean {
  return candidates.some((candidate) => candidate === WILDCARD || opaqueTag(candidate) === opaqueTag(etag));
}

function isWeak(tag: string): boolean {
  return tag.startsWith(WEAK_PREFIX);
}

function opaqueTag(tag: string): string {
  return isWeak(tag) ? tag.slice(WEAK_PREFIX.length) : tag;
}
