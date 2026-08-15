import type {
  CursorPagination,
  OffsetPagination,
  PaginationLimits,
  PaginationStrategy,
  SincePagination,
} from "./pagination.js";
import type { QueryIssueDto } from "../errors/problem-details.js";
import { QueryValidationException } from "../errors/exceptions.js";

/**
 * The default strategy: flat `limit`/`offset` wire params —
 * the exact field names the `ListResultDto` envelope reports back, so a
 * request and its response read symmetrically.
 *
 * Missing `limit` falls back to `defaultLimit`; a `limit` above
 * `maxLimit` is clamped (the server never over-serves, and clamping is
 * kinder than rejecting for a shared-link use case); a malformed or
 * negative value is rejected — it's a client bug, not a preference.
 */
export class OffsetPaginationStrategy implements PaginationStrategy {
  readonly name = "offset";

  normalize(rawParams: Readonly<Record<string, unknown>>, limits: PaginationLimits): OffsetPagination {
    const limit = readBoundedInt(rawParams["limit"], "limit", 1);
    const offset = readBoundedInt(rawParams["offset"], "offset", 0);
    return {
      limit: Math.min(limit ?? limits.defaultLimit, limits.maxLimit),
      offset: offset ?? 0,
    };
  }
}

/**
 * Built-in alternative: `page[number]`/`page[size]`, 1-indexed, normalized
 * internally to the same `limit`/`offset` form (the envelope still
 * reports `limit`/`offset` — the internal form is the contract).
 */
export class PagePaginationStrategy implements PaginationStrategy {
  readonly name = "page";

  normalize(rawParams: Readonly<Record<string, unknown>>, limits: PaginationLimits): OffsetPagination {
    const number = readBoundedInt(rawParams["page[number]"], "page[number]", 1);
    const size = readBoundedInt(rawParams["page[size]"], "page[size]", 1);
    const limit = Math.min(size ?? limits.defaultLimit, limits.maxLimit);
    return {
      limit,
      offset: ((number ?? 1) - 1) * limit,
    };
  }
}

/**
 * Keyset pagination: flat `limit` plus an opaque `cursor` token naming the
 * previous page's last row (ADR-0021). `O(limit)` regardless of how deep the
 * page is, and stable under concurrent writes — the two things `offset`
 * cannot give.
 *
 * This is the whole of what the strategy can decide on its own: the token is
 * carried through verbatim and `keyset` left `null`, because decoding it
 * needs the effective sort and the entity metadata, neither of which
 * `normalize(rawParams, limits)` is handed. `QueryNormalizer` fills `keyset`
 * (and enforces the unique-tiebreaker requirement) immediately afterwards —
 * an adapter never sees a `CursorPagination` in this half-built state.
 */
export class CursorPaginationStrategy implements PaginationStrategy {
  readonly name = "cursor";

  normalize(rawParams: Readonly<Record<string, unknown>>, limits: PaginationLimits): CursorPagination {
    const limit = readBoundedInt(rawParams["limit"], "limit", 1);
    return {
      limit: Math.min(limit ?? limits.defaultLimit, limits.maxLimit),
      cursor: readToken(rawParams["cursor"], "cursor"),
      keyset: null,
    };
  }
}

/**
 * Seek-by-timestamp pagination: flat `limit` plus a plain `since` value
 * naming the previous poll's boundary (ADR-0022). `O(limit)` and,
 * unlike `cursor`, meant for polling — "give me everything that changed
 * since T" — rather than page-by-page traversal.
 *
 * Like {@link CursorPaginationStrategy}, this is the whole of what the
 * strategy can decide on its own: the raw wire value is carried through
 * undecoded (as a string) and `keyset` left `null`. `QueryNormalizer` forces
 * the effective sort to `[sinceField, idField]`, decodes `since` against
 * `sinceField`'s declared kind, and fills `keyset`.
 */
export class SincePaginationStrategy implements PaginationStrategy {
  readonly name = "since";

  normalize(rawParams: Readonly<Record<string, unknown>>, limits: PaginationLimits): SincePagination {
    const limit = readBoundedInt(rawParams["limit"], "limit", 1);
    return {
      limit: Math.min(limit ?? limits.defaultLimit, limits.maxLimit),
      since: readToken(rawParams["since"], "since"),
      keyset: null,
    };
  }
}

/**
 * The `limit` this strategy reports for an unbounded page, and every
 * adapter's numeric limit call (`.take()`, `.limit()`, …) then receives
 * unchanged. `Number.MAX_SAFE_INTEGER` would overflow a signed 32-bit
 * integer — which is what `@kavo/graphql`'s `GraphQLInt` envelope field is,
 * and what MongoDB's wire protocol uses for a query's `limit` — so this is
 * `2^31 - 1` instead: the largest value every consumer in the workspace
 * (every SQL `LIMIT`, `GraphQLInt`, MongoDB's int32 limit) can carry without
 * a second, adapter-specific ceiling. It is not a real limit for any table
 * this strategy is a reasonable fit for.
 */
export const NONE_PAGINATION_LIMIT = 2147483647;

/**
 * "none" (ADR-0030): opts a resource out of pagination altogether — every
 * `findMany` call serves the whole match set, for a resource that genuinely never
 * wants a page boundary (a small lookup/reference table, say). `limit`/
 * `offset` are rejected outright if the client sends either, the same
 * "wrong strategy, told, not silently ignored" treatment `cursor`/`since`
 * params get under any other strategy (`QueryNormalizer`'s
 * `keysetParamUnsupportedIssue`) — accepting a client-sent `limit` and then
 * ignoring it would leave the client believing paging took effect when it
 * didn't. Both are collected into one exception when both are sent, the
 * same "every issue in one round trip" contract `QueryNormalizer` documents
 * for itself — a strategy raising its own exception is not exempt from it.
 *
 * The response envelope still reports `limit`/`offset` — its shape is
 * fixed, the same reason a keyset page's envelope always reports
 * `offset: 0` — so this strategy reports {@link NONE_PAGINATION_LIMIT}
 * rather than inventing a sentinel the envelope has no field for.
 */
export class NonePaginationStrategy implements PaginationStrategy {
  readonly name = "none";

  // `_limits` (`defaultLimit`/`maxLimit`) is part of the interface but goes
  // unused here — the whole point of "none" is that neither applies.
  normalize(rawParams: Readonly<Record<string, unknown>>, _limits: PaginationLimits): OffsetPagination {
    const issues: QueryIssueDto[] = [];
    if (hasValue(rawParams["limit"])) issues.push(noneParamUnsupportedIssue("limit"));
    if (hasValue(rawParams["offset"])) issues.push(noneParamUnsupportedIssue("offset"));
    if (issues.length > 0) throw new QueryValidationException(issues);
    return { limit: NONE_PAGINATION_LIMIT, offset: 0 };
  }
}

function hasValue(raw: unknown): boolean {
  return raw !== undefined && raw !== null && raw !== "";
}

function noneParamUnsupportedIssue(param: "limit" | "offset"): QueryIssueDto {
  return {
    field: param,
    code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    detail:
      `Query parameter '${param}' is not supported: this entity does not paginate ` +
      `('pagination.strategy' is 'none'), so every request serves the whole match set.`,
  };
}

/** Built-in strategies, keyed by the `pagination.strategy` config value. */
export function builtInPaginationStrategies(): ReadonlyMap<string, PaginationStrategy> {
  const strategies = [
    new OffsetPaginationStrategy(),
    new PagePaginationStrategy(),
    new CursorPaginationStrategy(),
    new SincePaginationStrategy(),
    new NonePaginationStrategy(),
  ];
  return new Map(strategies.map((strategy) => [strategy.name, strategy]));
}

/**
 * Absent/empty means "first page". Anything that is not a string is a
 * malformed request — a repeated `?cursor=a&cursor=b` (or `?since=a&since=b`)
 * arrives as an array, and picking one of the two silently would page from
 * an arbitrary place.
 */
function readToken(raw: unknown, param: "cursor" | "since"): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw QueryValidationException.single({
      field: param,
      code: "KAVO_QUERY_INVALID_VALUE",
      detail:
        param === "cursor"
          ? "'cursor' must be a single opaque token, passed back from the previous page's 'meta.nextCursor'."
          : "'since' must be a single value, passed back from the previous poll's 'meta.nextSince'.",
    });
  }
  return raw;
}

function readBoundedInt(raw: unknown, param: string, minimum: number): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(String(raw));
  if (!Number.isInteger(value) || value < minimum) {
    throw QueryValidationException.single({
      field: param,
      code: "KAVO_QUERY_INVALID_VALUE",
      detail: `'${param}' must be an integer ≥ ${minimum}, got '${String(raw)}'.`,
    });
  }
  return value;
}
