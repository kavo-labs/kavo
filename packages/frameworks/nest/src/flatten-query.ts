import { WireQuery } from "@kavo/core";

/**
 * Normalize a parsed query object back to the flat bracket-key form the
 * query grammar is specified against.
 *
 * Express 5 (Nest 11's default) uses the "simple" query parser, which
 * already yields flat keys (`"filter[age][gte]": "18"`). Express 4 / the
 * "extended" qs parser yields nested objects instead
 * (`{ filter: { age: { gte: "18" } } }`); flattening here makes the
 * binding parser-agnostic.
 *
 * Idempotent against an already-`WireQuery`-wrapped input (issue #25): since
 * `@Kavo` now wires an `@Override`'d read method's `query` param through
 * `WireQueryPipe` automatically, a method still written against the pre-#25
 * contract — calling `new WireQuery(flattenQuery(query))` itself — would
 * otherwise flatten `WireQuery`'s own `params` property one bracket level
 * too deep (`filter[status][eq]` becomes `params[filter[status][eq]]`),
 * which the normalizer then silently drops instead of rejecting. Detecting
 * `WireQuery` here and returning its already-flat `params` unchanged turns
 * that stale call into a no-op instead of a silent loss of filtering,
 * sorting, or field selection.
 */
export function flattenQuery(query: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // Null-prototype throughout: the normalizer reads single params straight
  // off this object (`rawParams["withDeleted"]`, `rawParams["limit"]`), so
  // on an ordinary object a polluted `Object.prototype` would be
  // indistinguishable from a client-supplied param. It also makes
  // `flat["__proto__"] = …` an ordinary assignment rather than a call into
  // the prototype setter.
  const flat = Object.create(null) as Record<string, unknown>;
  if (query instanceof WireQuery) {
    return Object.assign(flat, query.params);
  }
  for (const [key, value] of Object.entries(query)) {
    flattenInto(flat, key, value);
  }
  return flat;
}

function flattenInto(flat: Record<string, unknown>, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    // Repeated keys (`filter[status][in][]=a&…[]=b`) arrive as arrays in
    // both parsers; keep the array under the bracketed key. Top-level
    // scalars repeated by accident (`?limit=1&limit=2`) stay arrays too —
    // the normalizer rejects them with a clean 400.
    flat[key.endsWith("[]") || !key.includes("[") ? key : `${key}[]`] = value;
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, childValue] of Object.entries(value)) {
      flattenInto(flat, `${key}[${childKey}]`, childValue);
    }
    return;
  }
  flat[key] = value;
}
