/**
 * Split a bracketed wire key into its path segments:
 * `parseBracketKey("filter[or][0][role][eq]", "filter")` →
 * `["or", "0", "role", "eq"]`. The repeated-key form keeps its empty tail
 * (`"filter[status][in][]"` → `["status", "in", ""]`).
 *
 * Returns `null` when the key is not `<prefix>[...]...` — including the
 * bare prefix itself, which callers treat separately (`filter` alone is
 * the JSON escape hatch; `fields` alone is the root fieldset).
 */
export function parseBracketKey(key: string, prefix: string): readonly string[] | null {
  if (!key.startsWith(prefix + "[") || !key.endsWith("]")) {
    return null;
  }
  const segments: string[] = [];
  let position = prefix.length;
  while (position < key.length) {
    if (key[position] !== "[") {
      return null;
    }
    const close = key.indexOf("]", position);
    if (close === -1) {
      return null;
    }
    segments.push(key.slice(position + 1, close));
    position = close + 1;
  }
  return segments;
}
