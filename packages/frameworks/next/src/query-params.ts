/**
 * A `URLSearchParams` already yields flat bracket-notation keys
 * (`"filter[age][gte]"`, `"include[]"`) — the shape the query grammar is
 * specified against (docs/internals/architecture/05-query-grammar.md) —
 * so, unlike `@kavo/nest`'s `flattenQuery`, there is no nested-object form
 * to flatten. The one thing left to normalize is a key repeated in the
 * query string, which `URLSearchParams` does not collapse on its own.
 *
 * Mirrors `@kavo/nest`'s `flattenQuery` repeated-key rule exactly: a key
 * already ending in `"[]"`, or one with no bracket at all (a top-level
 * scalar like `?limit=1&limit=2`, left as a same-named array so the
 * normalizer can reject it with a clean 400), keeps its name; anything else
 * gets `"[]"` appended.
 */
export function parseWireParams(searchParams: URLSearchParams): Record<string, unknown> {
  const flat = Object.create(null) as Record<string, unknown>;
  const seen = new Set<string>();
  for (const key of searchParams.keys()) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const values = searchParams.getAll(key);
    if (values.length > 1) {
      const arrayKey = key.endsWith("[]") || !key.includes("[") ? key : `${key}[]`;
      flat[arrayKey] = values;
    } else {
      flat[key] = values[0];
    }
  }
  return flat;
}
