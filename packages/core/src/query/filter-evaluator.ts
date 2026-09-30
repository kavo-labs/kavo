import type { FilterCondition, FilterExpression, FilterScalar } from "./filter.js";

/**
 * Evaluates a `FilterExpression` (the same AST `DefaultFilterParser` builds
 * for REST list requests) against one already-serialized item, in memory —
 * no adapter, no query builder, no DB round trip. Built for issue #160's
 * filtered realtime subscriptions (ADR-0024, doc 18 §4): a transport calls this once per
 * candidate subscriber, per publish, against the `RealtimeEventDto.item`
 * the engine already serialized for that write.
 *
 * `root: null` (no filter configured) always matches, mirroring `Filter.
 * root`'s own "match everything" convention.
 *
 * Every operator follows SQL's three-valued-logic convention rather than
 * naive JavaScript comparison: a `null`/`undefined` item value makes every
 * operator **except** `IS_NULL`/`IS_NOT_NULL` evaluate to `false` — the
 * same way `status != 'x'` and `age > 18` both exclude a `NULL` row rather
 * than naive `!(null === 'x')` (`true`) including it. This is the one place
 * this function diverges from "identical to how the adapter would have
 * translated it": there is no SQL engine here to produce UNKNOWN and fold
 * it into WHERE's false-or-unknown-excludes semantics, so the fold happens
 * explicitly, up front, for every operator that isn't itself a null check.
 */
export function evaluateFilter<Entity = unknown>(
  root: FilterExpression<Entity> | null,
  item: Readonly<Record<string, unknown>>,
): boolean {
  if (root === null) {
    return true;
  }
  return evaluateExpression(root, item);
}

function evaluateExpression<Entity>(
  expression: FilterExpression<Entity>,
  item: Readonly<Record<string, unknown>>,
): boolean {
  if (expression.kind === "condition") {
    return evaluateCondition(expression, item);
  }
  switch (expression.operator) {
    case "AND":
      return expression.children.every((child) => evaluateExpression(child, item));
    case "OR":
      return expression.children.some((child) => evaluateExpression(child, item));
    // `NOT` is variadic and means `NOT(AND(children))` (doc 05 §1) — the
    // wire parser only ever builds the unary shape, but a programmatic
    // caller can hand-build a wider one, so this stays consistent with it
    // rather than special-casing arity 1.
    case "NOT":
      return !expression.children.every((child) => evaluateExpression(child, item));
  }
}

function evaluateCondition<Entity>(
  condition: FilterCondition<Entity>,
  item: Readonly<Record<string, unknown>>,
): boolean {
  const itemValue = item[condition.field as string];

  if (condition.operator === "IS_NULL") {
    return itemValue === null || itemValue === undefined;
  }
  if (condition.operator === "IS_NOT_NULL") {
    return itemValue !== null && itemValue !== undefined;
  }

  // Every remaining operator: a missing/null item value can never satisfy
  // it, including `EQ null` — SQL's `NULL = NULL` is itself unknown, not
  // true, which is exactly why `IS_NULL` exists as its own operator.
  if (itemValue === null || itemValue === undefined) {
    return false;
  }

  switch (condition.operator) {
    case "EQ":
      return valuesEqual(itemValue, condition.value as FilterScalar);
    case "NE":
      return !valuesEqual(itemValue, condition.value as FilterScalar);
    case "GT":
      return compareOrdered(itemValue, condition.value as FilterScalar, (a, b) => a > b);
    case "GTE":
      return compareOrdered(itemValue, condition.value as FilterScalar, (a, b) => a >= b);
    case "LT":
      return compareOrdered(itemValue, condition.value as FilterScalar, (a, b) => a < b);
    case "LTE":
      return compareOrdered(itemValue, condition.value as FilterScalar, (a, b) => a <= b);
    case "IN":
      return (condition.value as readonly FilterScalar[]).some((candidate) => valuesEqual(itemValue, candidate));
    case "NOT_IN":
      return !(condition.value as readonly FilterScalar[]).some((candidate) => valuesEqual(itemValue, candidate));
    case "BETWEEN": {
      const [low, high] = condition.value as readonly [FilterScalar, FilterScalar];
      return compareOrdered(itemValue, low, (a, b) => a >= b) && compareOrdered(itemValue, high, (a, b) => a <= b);
    }
    case "LIKE":
      return likeMatches(condition.value as string, String(itemValue), false);
    case "ILIKE":
      return likeMatches(condition.value as string, String(itemValue), true);
  }
}

/** `Date` compares by instant; everything else compares by strict equality after normalizing one side to a `Date` if the other is one. */
function valuesEqual(itemValue: unknown, filterValue: FilterScalar): boolean {
  const [a, b] = normalizeForDateCompare(itemValue, filterValue);
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

function compareOrdered(
  itemValue: unknown,
  filterValue: FilterScalar,
  compare: (a: number | string, b: number | string) => boolean,
): boolean {
  const [a, b] = normalizeForDateCompare(itemValue, filterValue);
  const left = orderable(a);
  const right = orderable(b);
  if (left === null || right === null) {
    return false;
  }
  return compare(left, right);
}

function orderable(value: unknown): number | string | null {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  return null;
}

/**
 * `coerceScalar` turns a date column's wire value into a `Date` (value-
 * coercion.ts), and `KavoEngine`'s serializer never re-stringifies the row
 * it just wrote before handing it to `emitRealtimeEvent` — but an ORM
 * adapter's own item representation isn't guaranteed to agree, and a
 * hand-built `RealtimeTransport` test fixture even less so. When the
 * filter's own value is a `Date` and the item's is a parseable string,
 * parse it once here rather than let every comparator re-derive it.
 */
function normalizeForDateCompare(itemValue: unknown, filterValue: FilterScalar): [unknown, FilterScalar] {
  if (filterValue instanceof Date && typeof itemValue === "string") {
    const parsed = new Date(itemValue);
    if (!Number.isNaN(parsed.getTime())) {
      return [parsed, filterValue];
    }
  }
  return [itemValue, filterValue];
}

type LikeToken =
  { readonly kind: "any" } | { readonly kind: "one" } | { readonly kind: "literal"; readonly char: string };

/**
 * `LIKE`/`ILIKE` matching without `RegExp`. The parser passes the pattern
 * through unmodified (doc 05 §3: callers spell `%`/`_` themselves, and escape
 * a literal one with a backslash). A regex translation (`%` → `.*`) let a
 * pattern such as `%a%a%a%a%b` backtrack exponentially against a long value,
 * and both the pattern (a subscriber's filter) and the value (a row's field)
 * are client-controlled — while this runs once per candidate subscriber, per
 * publish, on the event loop. The two-pointer wildcard match below only ever
 * backtracks to the most recent `%`, so it is `O(pattern × value)` at worst.
 * Characters are compared per code point, as SQL compares characters.
 */
function likeMatches(pattern: string, value: string, caseInsensitive: boolean): boolean {
  const tokens = likeTokens(caseInsensitive ? pattern.toLowerCase() : pattern);
  const chars = Array.from(caseInsensitive ? value.toLowerCase() : value);
  let t = 0;
  let c = 0;
  let starToken = -1;
  let starChar = 0;
  while (c < chars.length) {
    const token = tokens[t];
    if (token !== undefined && token.kind === "any") {
      starToken = t++;
      starChar = c;
    } else if (token !== undefined && (token.kind === "one" || token.char === chars[c])) {
      t++;
      c++;
    } else if (starToken !== -1) {
      t = starToken + 1;
      c = ++starChar;
    } else {
      return false;
    }
  }
  while (tokens[t]?.kind === "any") {
    t++;
  }
  return t === tokens.length;
}

function likeTokens(pattern: string): readonly LikeToken[] {
  const chars = Array.from(pattern);
  const tokens: LikeToken[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (ch === "\\" && i + 1 < chars.length) {
      const next = chars[i + 1] as string;
      if (next === "%" || next === "_" || next === "\\") {
        tokens.push({ kind: "literal", char: next });
        i++;
        continue;
      }
    }
    if (ch === "%") {
      // Consecutive `%`s mean the same as one; collapsing them keeps the
      // backtracking bookkeeping to one star per run.
      if (tokens[tokens.length - 1]?.kind !== "any") {
        tokens.push({ kind: "any" });
      }
      continue;
    }
    tokens.push(ch === "_" ? { kind: "one" } : { kind: "literal", char: ch });
  }
  return tokens;
}
