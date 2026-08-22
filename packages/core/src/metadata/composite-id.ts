/**
 * Wire encoding for a composite primary key (issue #261): every
 * `compositeIdFields`-bearing entity's route id is one path segment, its
 * key columns joined in declaration order by `~`. A literal `~` inside a
 * value is doubled (`~~`) so the splitter can always tell a delimiter from
 * data — this has to survive URL decoding, so it cannot rely on percent
 * escaping (Express/Nest already decode the segment before core sees it).
 */
const SEPARATOR = "~";

/** `["a", "b~c"]` → `"a~b~~c"`. */
export function encodeCompositeId(values: readonly (string | number)[]): string {
  return values.map((value) => String(value).replaceAll(SEPARATOR, SEPARATOR + SEPARATOR)).join(SEPARATOR);
}

/**
 * The inverse of {@link encodeCompositeId}. `null` when `id` does not
 * decode into exactly `count` parts — a malformed or truncated route id,
 * which the caller turns into a clean 400 rather than a driver error.
 */
export function decodeCompositeId(id: string, count: number): readonly string[] | null {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < id.length; i++) {
    const char = id[i];
    if (char !== SEPARATOR) {
      current += char;
      continue;
    }
    if (id[i + 1] === SEPARATOR) {
      current += SEPARATOR;
      i++;
      continue;
    }
    parts.push(current);
    current = "";
  }
  parts.push(current);
  return parts.length === count ? parts : null;
}
