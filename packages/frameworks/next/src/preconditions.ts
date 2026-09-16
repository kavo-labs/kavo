import type { RequestPreconditions } from "@kavo/core";

/**
 * One entity-tag: a quoted opaque tag (optionally weak), the wildcard, or
 * — as a forgiving last resort — a bare unquoted token. Identical to
 * `@kavo/nest`'s `ConditionalRequest` decorator's parser (ADR-0020) — the
 * two bindings must agree on what counts as a precondition match.
 */
const ENTITY_TAG = /(?:W\/)?"[^"]*"|\*|[^\s,]+/g;

/**
 * `'"a", W/"b"'` → `['"a"', 'W/"b"']`; an absent header stays `undefined`.
 * A header that is *present* but yields no tags returns `[]`, not
 * `undefined` — see `@kavo/nest`'s `parseEntityTags` for why that
 * distinction is load-bearing (RFC 9110 §13.1.1: a guard that names
 * nothing matchable evaluates false, not "no guard").
 */
export function parseEntityTags(raw: string | null): readonly string[] | undefined {
  if (raw === null) {
    return undefined;
  }
  return raw.match(ENTITY_TAG) ?? [];
}

/** `If-Match` / `If-None-Match` off a `Request`'s headers, as a `RequestPreconditions` (ADR-0020). */
export function readPreconditions(headers: Headers): RequestPreconditions | null {
  const ifMatch = parseEntityTags(headers.get("if-match"));
  const ifNoneMatch = parseEntityTags(headers.get("if-none-match"));
  if (ifMatch === undefined && ifNoneMatch === undefined) {
    return null;
  }
  return {
    ...(ifMatch === undefined ? {} : { ifMatch }),
    ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
  };
}
