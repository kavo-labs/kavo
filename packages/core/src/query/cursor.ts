import type { Filter, FilterExpression, FilterScalar } from "./filter.js";
import type { NormalizedQueryContext } from "./query-context.js";
import type { Sort } from "./sort.js";
import type { FieldMetadata } from "../metadata/entity-metadata.js";
import type { QueryIssueDto } from "../errors/problem-details.js";
import type { FieldPath } from "../types/field-path.js";
import { hasKeyset } from "./pagination.js";
import { ConfigurationException } from "../errors/exceptions.js";

/**
 * Cursor pagination, in one module (ADR-0021).
 *
 * A cursor is the previous page's last row projected onto the effective
 * sort: `[lastRow.createdAt, lastRow.id]` for `sort=-createdAt,id`. It is
 * **opaque, not signed** — base64url-encoded JSON, strictly shape-validated
 * on decode. Core imports nothing outside itself (ADR-0005), which rules out
 * `node:crypto`, and `SubtleCrypto` is async while
 * `PaginationStrategy.normalize` is sync; but the security argument is the
 * real one: the payload is a tuple of comparison values against fields the
 * normalizer has already required to be on the *filterable* allowlist, so a
 * client can inject the same values through `filter[…]` without forging
 * anything. A signature would protect nothing.
 *
 * The base64 codec is hand-rolled for the same reason `packages/core/
 * tsconfig.json` sets `"types": []`: `btoa`/`TextEncoder` are ambient
 * globals of a *host*, and core is meant to run on any of them.
 */

/** The `\u` escape width JSON uses, so the encoder's output stays ASCII. */
const UNICODE_ESCAPE_WIDTH = 4;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Encode one row's sort-key values into an opaque page token.
 *
 * `Date` values round-trip through `JSON.stringify`'s ISO spelling and are
 * revived by {@link decodeCursor} against the field's `kind`, so a
 * `date`-sorted cursor compares as a `Date` on the way back in.
 */
export function encodeCursor(values: readonly FilterScalar[]): string {
  return base64UrlEncode(toAsciiJson(values));
}

/**
 * Decode a page token against the effective sort, or push a query issue and
 * return `null`.
 *
 * Validation is deliberately strict, because an opaque token has no other
 * gate: the payload must be a JSON array whose length matches the effective
 * sort exactly, and whose every element matches the corresponding field's
 * declared `kind` (an `enum` value must be in the declared set; a `date`
 * must parse). Anything else is a client-side bug — a stale token from a
 * different sort, a truncated copy-paste, a hand-forged value — and is
 * rejected the same way a malformed `page[number]` is.
 */
export function decodeCursor<Entity>(
  token: string,
  sort: readonly Sort<Entity>[],
  fields: ReadonlyMap<string, FieldMetadata>,
  issues: QueryIssueDto[],
): readonly FilterScalar[] | null {
  const json = base64UrlDecode(token);
  const payload = json === null ? undefined : parseJson(json);
  if (!Array.isArray(payload)) {
    return invalidCursor(issues, "it is not a valid cursor token");
  }
  if (payload.length !== sort.length) {
    return invalidCursor(
      issues,
      `it carries ${payload.length} value(s) but the effective sort has ${sort.length} — ` +
        `a cursor is only valid for the sort it was issued for`,
    );
  }

  const values: FilterScalar[] = [];
  for (const [index, entry] of sort.entries()) {
    const field = fields.get(entry.field as string);
    // `QueryNormalizer.resolveKeyset` rejects a non-scalar sort key before
    // it ever gets here, but `decodeCursor` is reachable on its own, and a
    // caller that passes a relation path deserves a query issue rather than
    // a `TypeError` out of a non-null assertion.
    if (field === undefined) {
      return invalidCursor(
        issues,
        `the effective sort orders by '${entry.field as string}', which is not a scalar column of this entity`,
      );
    }
    if (payload[index] === null) {
      // A null sort key has no position a keyset predicate can express:
      // `column > NULL` is UNKNOWN in SQL and orders arbitrarily elsewhere.
      // Refusing loudly beats silently skipping or repeating rows.
      return invalidCursor(
        issues,
        `its value for '${field.name}' is null, and cursor pagination cannot resume from a null sort key — ` +
          `sort by a column that is never null`,
      );
    }
    const value = reviveValue(payload[index], field);
    if (value === undefined) {
      return invalidCursor(issues, `its value for '${field.name}' does not match that field's type`);
    }
    values.push(value);
  }
  return values;
}

/**
 * Project a row onto the effective sort — the payload
 * {@link encodeCursor} turns into the next page's token.
 *
 * Reads the **entity**, before serialization and field selection, because a
 * client selecting `fields=title` still needs `id` in its cursor. That is
 * also why the normalizer requires every cursor sort key to be *selectable*:
 * `meta` never passes through the serializer, so a value read here reaches
 * the wire base64-encoded whether or not the DTO would have carried it
 * (ADR-0021).
 *
 * An absent property degrades to `null`, which {@link decodeCursor} then
 * rejects on the next request: a loud 400 beats silently paging from the
 * wrong place.
 *
 * Every non-null value is checked against the column's declared
 * {@link FieldMetadata.kind} using the same predicate {@link decodeCursor}
 * revives with. The mismatch this catches is real and otherwise silent: a
 * `bigint` primary key is declared `kind: "number"` by every adapter, but
 * arrives as a JS `bigint` (MikroORM v7, Prisma) — which `JSON.stringify`
 * throws on — or as a `string` (TypeORM), which round-trips into a
 * permanent 400 on page 2 blaming the wrong thing. Failing here names the
 * column and says what is actually wrong.
 */
export function cursorValuesOf<Entity>(
  entity: Entity,
  sort: readonly Sort<Entity>[],
  fields: ReadonlyMap<string, FieldMetadata>,
  entityName: string,
): readonly FilterScalar[] {
  return sort.map((entry) => {
    const name = entry.field as string;
    const value = (entity as Record<string, unknown>)[name];
    if (value === undefined || value === null) {
      return null;
    }
    const field = fields.get(name);
    if (field === undefined || !isEncodable(value, field)) {
      throw new ConfigurationException(
        entityName,
        "pagination.strategy",
        `cursor pagination cannot encode a page token for '${name}': the column is declared ` +
          `'${field?.kind ?? "unknown"}' but its runtime value is a ${describeRuntimeType(value)}. ` +
          `Cursor sort keys must be string, finite number, boolean, or Date at runtime — ` +
          `bigint and decimal columns are not supported as cursor keys`,
      );
    }
    return value as FilterScalar;
  });
}

/**
 * The row-wise "strictly after this row, in this order" predicate, as an
 * ordinary filter AST node:
 *
 * ```
 * (a >= va) AND ( (a > va) OR (a = va AND b < vb) OR (a = va AND b = vb AND id > vid) )
 * ```
 *
 * for `sort=a,-b,id`. Building it in core rather than per adapter is what
 * makes mixed `asc`/`desc` sorts work everywhere at once, and what makes the
 * predicate compose with the client filter, includes, and soft-delete scope
 * for free — every adapter already translates this AST.
 *
 * The `OR` of `AND` chains is the part that is *correct*; the leading
 * non-strict range is the part that is *fast*. A bare disjunction is not a
 * btree start condition, so PostgreSQL and MySQL take an ordered index scan
 * with the `OR` as a filter — reading and discarding every row before the
 * cursor, which is exactly the offset cost keyset paging exists to remove —
 * or a bitmap OR that loses the ordering and forces a sort. AND-ing the
 * leading key's non-strict bound (`>=` ascending, `<=` descending) hands the
 * planner a real range qualification. It is logically implied by every
 * branch of the disjunction, so it narrows nothing and changes no result;
 * it only lets the scan *start* at the cursor. Single-key sorts already emit
 * a bare range condition and need no help (ADR-0021).
 */
export function keysetExpression<Entity>(
  sort: readonly Sort<Entity>[],
  values: readonly FilterScalar[],
): FilterExpression<Entity> {
  const branches: FilterExpression<Entity>[] = [];
  for (let boundary = 0; boundary < sort.length; boundary++) {
    const chain: FilterExpression<Entity>[] = [];
    for (let index = 0; index < boundary; index++) {
      chain.push(condition(sort[index]!.field, "EQ", values[index]!));
    }
    const entry = sort[boundary]!;
    chain.push(condition(entry.field, entry.direction === "desc" ? "LT" : "GT", values[boundary]!));
    branches.push(chain.length === 1 ? chain[0]! : { kind: "group", operator: "AND", children: chain });
  }
  if (branches.length === 1) {
    return branches[0]!;
  }
  const lead = sort[0]!;
  const startable = condition(lead.field, lead.direction === "desc" ? "LTE" : "GTE", values[0]!);
  return {
    kind: "group",
    operator: "AND",
    children: [startable, { kind: "group", operator: "OR", children: branches }],
  };
}

/**
 * The filter a **paged read** applies: the client's own filter, AND-ed with
 * the keyset predicate when the query is cursor- or since-paginated
 * (ADR-0022 generalizes this from cursor-only via {@link hasKeyset}).
 *
 * Adapters call this in `findMany` instead of reading `query.filter`
 * directly. `count` deliberately keeps using `query.filter`: `total` is the
 * size of the whole match set, not of what is left after the cursor/since
 * boundary (`pagination.count` semantics are strategy-independent).
 */
export function readFilter<Entity>(query: NormalizedQueryContext<Entity>): Filter<Entity> {
  const { pagination, filter } = query;
  if (!hasKeyset(pagination) || pagination.keyset === null) {
    return filter;
  }
  if (filter.root === null) {
    return { root: pagination.keyset };
  }
  return { root: { kind: "group", operator: "AND", children: [filter.root, pagination.keyset] } };
}

function condition<Entity>(
  field: FieldPath<Entity>,
  operator: "EQ" | "GT" | "LT" | "GTE" | "LTE",
  value: FilterScalar,
): FilterExpression<Entity> {
  return { kind: "condition", field, operator, value };
}

/**
 * Whether a runtime value can be encoded as this column's cursor key — the
 * encode-side mirror of {@link reviveValue}, minus the `enum` membership
 * check (a value already in the database is not the encoder's to second-guess).
 */
function isEncodable(value: unknown, field: FieldMetadata): boolean {
  switch (field.kind) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
    case "enum":
      return typeof value === "string";
    case "date":
      return value instanceof Date && !Number.isNaN(value.getTime());
    default:
      // `json` — the normalizer rejects it as a cursor sort key already.
      return false;
  }
}

/** The runtime type of a rejected cursor value, for the error message. */
function describeRuntimeType(value: unknown): string {
  if (value instanceof Date) {
    return "Date";
  }
  const type = typeof value;
  if (type !== "object") {
    return type;
  }
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name === undefined || name === "" ? "object" : `${name} object`;
}

/**
 * One decoded payload element, or `undefined` when it does not match the
 * column. `null` never reaches here — {@link decodeCursor} rejects it first,
 * with a message about null sort keys rather than about types.
 */
function reviveValue(raw: unknown, field: FieldMetadata): FilterScalar | undefined {
  switch (field.kind) {
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "string":
      return typeof raw === "string" ? raw : undefined;
    case "enum":
      return typeof raw === "string" && (field.enumValues ?? []).includes(raw) ? raw : undefined;
    case "date": {
      if (typeof raw !== "string") {
        return undefined;
      }
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? undefined : date;
    }
    default:
      // `json` — not orderable, and the normalizer rejects it as a cursor
      // sort field before decoding ever runs.
      return undefined;
  }
}

function invalidCursor(issues: QueryIssueDto[], reason: string): null {
  issues.push({
    field: "cursor",
    code: "KAVO_QUERY_INVALID_VALUE",
    detail: `The 'cursor' parameter was rejected: ${reason}. Cursors are opaque — pass back 'meta.nextCursor' from the previous page verbatim.`,
  });
  return null;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `JSON.stringify`, with every non-ASCII character escaped to `\uXXXX`, so
 * the base64 layer below only ever sees single-byte code units and needs no
 * UTF-8 encoder.
 */
function toAsciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(UNICODE_ESCAPE_WIDTH, "0")}`;
  });
}

/** Unpadded base64url (RFC 4648 §5) over an ASCII string. */
function base64UrlEncode(ascii: string): string {
  let out = "";
  for (let index = 0; index < ascii.length; index += 3) {
    const first = ascii.charCodeAt(index);
    const hasSecond = index + 1 < ascii.length;
    const hasThird = index + 2 < ascii.length;
    const second = hasSecond ? ascii.charCodeAt(index + 1) : 0;
    const third = hasThird ? ascii.charCodeAt(index + 2) : 0;
    out += BASE64URL_ALPHABET[first >> 2];
    out += BASE64URL_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    if (!hasSecond) {
      break;
    }
    out += BASE64URL_ALPHABET[((second & 0x0f) << 2) | (third >> 6)];
    if (!hasThird) {
      break;
    }
    out += BASE64URL_ALPHABET[third & 0x3f];
  }
  return out;
}

/** The inverse; `null` on any character outside the alphabet. */
function base64UrlDecode(token: string): string | null {
  // A 4-character base64 group carries 3 bytes, so a trailing group of one
  // character encodes nothing — the token is malformed, not merely padded.
  if (token.length % 4 === 1) {
    return null;
  }
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const char of token) {
    const index = BASE64URL_ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return out;
}
