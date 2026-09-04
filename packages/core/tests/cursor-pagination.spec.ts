import { describe, expect, it } from "vitest";
import type {
  DeepPartial,
  EntityId,
  EntityMetadata,
  KavoSettings,
  ListMetaDto,
  ListResultDto,
  NormalizedQueryContext,
  RepositoryAdapter,
  ResolvedEntityConfig,
  Sort,
} from "@kavo/core";
import {
  ConfigurationException,
  CursorPaginationStrategy,
  QueryNormalizer,
  WireQuery,
  createKavo,
  cursorValuesOf,
  encodeCursor,
  isCursorPagination,
  readFilter,
} from "@kavo/core";
// Not on the barrel: both are `QueryNormalizer` internals whose contracts
// only hold once the effective sort has been validated (ADR-0010, ADR-0021).
import { decodeCursor, keysetExpression } from "../src/query/cursor.js";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";
import { issuesOf } from "./support/query-issues.js";

/**
 * Cursor (keyset) pagination — ADR-0021.
 *
 * The suite drives the real composition root and the real engine wherever
 * it can: cursor paging is an interaction between the strategy, the
 * normalizer's tiebreaker rules, the built-in handler's `limit + 1`
 * over-fetch, and the engine's `meta.nextCursor`, and testing any one of
 * those alone would pass while the feature was broken.
 */

const SORT_BY_ID: readonly Sort<User>[] = [{ field: "id", direction: "asc" }];

function cursorCrud(overrides: DeepPartial<KavoSettings> = {}) {
  const adapter = new InMemoryUserAdapter();
  const crud = createKavo({
    defaults: {
      ...overrides,
      pagination: { strategy: "cursor", ...overrides.pagination },
      query: { defaultSort: SORT_BY_ID, ...overrides.query },
    },
  } as never).createCrud(User, undefined, { adapter, metadata: userMetadata });
  return { crud, adapter };
}

async function seed(crud: ReturnType<typeof cursorCrud>["crud"], count: number): Promise<void> {
  for (let index = 1; index <= count; index++) {
    await crud.createOne({ name: `user-${index}`, email: `u${index}@x.io`, age: index } as never);
  }
}

/**
 * The `nextCursor` a cursor page carries.
 *
 * `ListResultDto.meta` is optional and absent when nothing contributed to
 * it (#122), but a cursor page always contributes: `nextCursor` is `null`
 * on the last page rather than missing, because "there is no next page" is
 * an answer. Asserting that here is what lets every call site read the
 * token directly, and turns a dropped bag into a failure at the assertion
 * that cared rather than a silent `undefined`.
 */
function nextCursorOf(list: Pick<ListResultDto<unknown>, "meta">): string | null {
  expect(list.meta).toBeDefined();
  return (list.meta as ListMetaDto)["nextCursor"] as string | null;
}

/** The whole match set, walked one page at a time, plus the page count. */
async function walk(
  crud: ReturnType<typeof cursorCrud>["crud"],
  limit: number,
): Promise<{ names: string[]; pages: number }> {
  const names: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page: ListResultDto<unknown> = await crud.findMany({ limit, cursor } as never);
    pages++;
    names.push(...page.items.map((item) => (item as User).name));
    cursor = nextCursorOf(page);
    if (cursor === null) {
      return { names, pages };
    }
    if (pages > 50) {
      throw new Error("cursor paging did not terminate");
    }
  }
}

// ── The codec ─────────────────────────────────────────────────────────

describe("cursor codec — opaque, not signed", () => {
  const fields = new Map(userMetadata.fields.map((field) => [field.name, field]));

  function roundTrip(values: readonly (string | number | boolean | Date)[], sort: readonly Sort<User>[]) {
    const issues: never[] = [];
    return decodeCursor(encodeCursor(values), sort, fields, issues as never);
  }

  it("round-trips the sort-key tuple", () => {
    expect(roundTrip([7], SORT_BY_ID)).toEqual([7]);
  });

  it("round-trips strings, numbers and enums together", () => {
    const sort: readonly Sort<User>[] = [
      { field: "name", direction: "asc" },
      { field: "status", direction: "desc" },
      { field: "id", direction: "asc" },
    ];
    expect(roundTrip(["Ada", "active", 3], sort)).toEqual(["Ada", "active", 3]);
  });

  it("revives a date value as a Date, so it compares as one", () => {
    const sort: readonly Sort<User>[] = [
      { field: "createdAt", direction: "desc" },
      { field: "id", direction: "asc" },
    ];
    const when = new Date("2024-03-01T10:00:00.000Z");
    const revived = roundTrip([when, 1], sort);
    const first = (revived ?? [])[0];
    expect(first).toBeInstanceOf(Date);
    expect((first as Date).toISOString()).toBe(when.toISOString());
  });

  it("survives non-ASCII values — the payload is escaped before base64", () => {
    const sort: readonly Sort<User>[] = [
      { field: "name", direction: "asc" },
      { field: "id", direction: "asc" },
    ];
    for (const name of ["Zoë", "田中", "a🙂b", " edge"]) {
      expect(roundTrip([name, 1], sort)).toEqual([name, 1]);
    }
  });

  it("emits URL-safe characters only, so a token needs no escaping", () => {
    const token = encodeCursor(["a/b+c?d=e", 1]);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects a token carrying a character outside the base64url alphabet", () => {
    // 10 characters, so `length % 4 === 2` and the *length* guard passes —
    // it is the alphabet check that has to reject this one.
    const issues: { field: string; code: string }[] = [];
    expect(decodeCursor("tampered!!", SORT_BY_ID, fields, issues as never)).toBeNull();
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("rejects a truncated token — a trailing group of one character encodes nothing", () => {
    // Every character is in the alphabet; only `length % 4 === 1` is wrong.
    const issues: { field: string; code: string }[] = [];
    expect(decodeCursor("AAAAA", SORT_BY_ID, fields, issues as never)).toBeNull();
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("rejects a well-formed token whose decoded bytes are not JSON", () => {
    const issues: { field: string; code: string }[] = [];
    expect(decodeCursor("AAAA", SORT_BY_ID, fields, issues as never)).toBeNull();
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("round-trips a boolean key", () => {
    const withFlag = new Map(fields);
    withFlag.set("verified", { name: "verified", kind: "boolean", nullable: false, generated: false });
    const sort = [{ field: "verified", direction: "asc" }, ...SORT_BY_ID] as readonly Sort<User>[];
    expect(decodeCursor(encodeCursor([true, 4]), sort, withFlag, [] as never)).toEqual([true, 4]);
  });

  it("rejects a non-boolean value for a boolean key", () => {
    const withFlag = new Map(fields);
    withFlag.set("verified", { name: "verified", kind: "boolean", nullable: false, generated: false });
    const sort = [{ field: "verified", direction: "asc" }, ...SORT_BY_ID] as readonly Sort<User>[];
    const issues: { detail: string }[] = [];
    expect(decodeCursor(encodeCursor(["yes" as never, 4]), sort, withFlag, issues as never)).toBeNull();
    expect(issues[0]?.detail).toContain("'verified'");
  });

  it("refuses a json key outright — it has no portable ordering to revive against", () => {
    // Unreachable through the normalizer, which rejects a `json` sort key
    // first; pinned here because `reviveValue`'s default arm is what makes
    // the codec fail *closed* rather than passing an object straight through.
    const withJson = new Map(fields);
    withJson.set("profile", { name: "profile", kind: "json", nullable: false, generated: false });
    const sort = [{ field: "profile", direction: "asc" }, ...SORT_BY_ID] as readonly Sort<User>[];
    const issues: { detail: string }[] = [];
    expect(decodeCursor(encodeCursor(["{}" as never, 4]), sort, withJson, issues as never)).toBeNull();
    expect(issues[0]?.detail).toContain("'profile'");
  });

  it("reports a query issue, not a TypeError, for a sort key that is not a column", () => {
    // `decodeCursor` is reachable on its own; `resolveKeyset`'s guard is not
    // its guard.
    const sort = [{ field: "posts.title", direction: "asc" }] as unknown as readonly Sort<User>[];
    const issues: { field: string; code: string; detail: string }[] = [];
    expect(decodeCursor(encodeCursor(["x"]), sort, fields, issues as never)).toBeNull();
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
    expect(issues[0]?.detail).toContain("posts.title");
  });

  it("rejects a well-formed token whose payload is not an array", () => {
    const issues: { field: string; code: string }[] = [];
    expect(decodeCursor(encodeCursor({ id: 1 } as never), SORT_BY_ID, fields, issues as never)).toBeNull();
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("rejects a cursor whose arity does not match the effective sort", () => {
    // The stale-cursor case: the client changed `sort` but kept the token.
    const issues: { detail: string }[] = [];
    expect(decodeCursor(encodeCursor([1, 2]), SORT_BY_ID, fields, issues as never)).toBeNull();
    expect(issues[0]?.detail).toContain("2 value(s) but the effective sort has 1");
  });

  it("rejects a value whose type does not match the column", () => {
    const issues: { field: string; code: string; detail: string }[] = [];
    expect(decodeCursor(encodeCursor(["seven" as never]), SORT_BY_ID, fields, issues as never)).toBeNull();
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
    expect(issues[0]?.detail).toContain("'id'");
  });

  it("rejects an enum value outside the declared set", () => {
    const sort: readonly Sort<User>[] = [
      { field: "status", direction: "asc" },
      { field: "id", direction: "asc" },
    ];
    const issues: { field: string; code: string; detail: string }[] = [];
    expect(decodeCursor(encodeCursor(["superuser", 1]), sort, fields, issues as never)).toBeNull();
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
    expect(issues[0]?.detail).toContain("'status'");
  });

  it("rejects a null sort-key value — a keyset predicate cannot position one", () => {
    const issues: { field: string; code: string; detail: string }[] = [];
    expect(decodeCursor(encodeCursor([null]), SORT_BY_ID, fields, issues as never)).toBeNull();
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
    expect(issues[0]?.detail).toContain("'id'");
    expect(issues[0]?.detail).toContain("null sort key");
  });

  it("rejects an unparseable date", () => {
    const sort: readonly Sort<User>[] = [
      { field: "createdAt", direction: "asc" },
      { field: "id", direction: "asc" },
    ];
    const issues: { field: string; code: string; detail: string }[] = [];
    expect(decodeCursor(encodeCursor(["not-a-date", 1]), sort, fields, issues as never)).toBeNull();
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
    expect(issues[0]?.detail).toContain("'createdAt'");
  });
});

// ── Encoding a row: the declared kind must match the runtime value ─────

describe("cursorValuesOf — a cursor key's runtime type must match its declared kind", () => {
  const fields = new Map(userMetadata.fields.map((field) => [field.name, field]));

  it("projects a row onto the effective sort", () => {
    const when = new Date("2024-05-05T00:00:00.000Z");
    const sort: readonly Sort<User>[] = [
      { field: "createdAt", direction: "desc" },
      { field: "id", direction: "asc" },
    ];
    expect(cursorValuesOf({ ...new User(), id: 9, createdAt: when }, sort, fields, "User")).toEqual([when, 9]);
  });

  it("degrades an absent property to null rather than inventing a position", () => {
    expect(cursorValuesOf({} as User, SORT_BY_ID, fields, "User")).toEqual([null]);
  });

  it("refuses a bigint id — JSON.stringify would throw, and a 500 names nothing", () => {
    // Every adapter declares a `bigint` primary key as `kind: "number"`;
    // MikroORM v7 and Prisma hand back a JS `bigint` at runtime. Without
    // this check the first page is an opaque 500 out of `JSON.stringify`.
    expect(() => cursorValuesOf({ id: 1n } as unknown as User, SORT_BY_ID, fields, "User")).toThrow(
      ConfigurationException,
    );
    expect(() => cursorValuesOf({ id: 1n } as unknown as User, SORT_BY_ID, fields, "User")).toThrow(/bigint/);
  });

  it("refuses a stringified numeric id — TypeORM returns bigint columns as strings", () => {
    // This one round-trips silently into a *page-two* 400 blaming the
    // field's type, which points the adopter at the wrong thing.
    expect(() => cursorValuesOf({ id: "1" } as unknown as User, SORT_BY_ID, fields, "User")).toThrow(
      /declared 'number'.*runtime value is a string/s,
    );
  });

  it("refuses a Decimal-like object for a numeric key", () => {
    class Decimal {}
    expect(() => cursorValuesOf({ id: new Decimal() } as unknown as User, SORT_BY_ID, fields, "User")).toThrow(
      /Decimal object/,
    );
  });

  it("names the entity and the column it could not encode", () => {
    expect(() => cursorValuesOf({ id: 1n } as unknown as User, SORT_BY_ID, fields, "User")).toThrow(/'id'/);
  });
});

// ── The keyset predicate ──────────────────────────────────────────────

describe("keysetExpression — row-wise comparison as an ordinary filter AST", () => {
  it("is a single condition for a one-key sort", () => {
    expect(keysetExpression(SORT_BY_ID, [7])).toEqual({
      kind: "condition",
      field: "id",
      operator: "GT",
      value: 7,
    });
  });

  it("flips the comparison for a descending key", () => {
    expect(keysetExpression([{ field: "id", direction: "desc" }] as readonly Sort<User>[], [7])).toMatchObject({
      operator: "LT",
    });
  });

  it("builds an OR of AND chains that honours mixed directions", () => {
    const sort: readonly Sort<User>[] = [
      { field: "age", direction: "desc" },
      { field: "id", direction: "asc" },
    ];
    expect(keysetExpression(sort, [30, 5])).toEqual({
      kind: "group",
      operator: "AND",
      children: [
        // The redundant leading bound — logically implied by every branch
        // below it, and the only part of this shape a btree can *start* on.
        { kind: "condition", field: "age", operator: "LTE", value: 30 },
        {
          kind: "group",
          operator: "OR",
          children: [
            { kind: "condition", field: "age", operator: "LT", value: 30 },
            {
              kind: "group",
              operator: "AND",
              children: [
                { kind: "condition", field: "age", operator: "EQ", value: 30 },
                { kind: "condition", field: "id", operator: "GT", value: 5 },
              ],
            },
          ],
        },
      ],
    });
  });

  it("uses a non-strict GTE bound when the leading key ascends", () => {
    const sort: readonly Sort<User>[] = [
      { field: "name", direction: "asc" },
      { field: "id", direction: "asc" },
    ];
    expect(keysetExpression(sort, ["Ada", 5])).toMatchObject({
      operator: "AND",
      children: [{ field: "name", operator: "GTE", value: "Ada" }, { operator: "OR" }],
    });
  });

  it("chains three keys, the deepest branch being the full AND of equalities", () => {
    const sort: readonly Sort<User>[] = [
      { field: "status", direction: "asc" },
      { field: "age", direction: "desc" },
      { field: "id", direction: "asc" },
    ];
    expect(keysetExpression(sort, ["active", 30, 5])).toEqual({
      kind: "group",
      operator: "AND",
      children: [
        { kind: "condition", field: "status", operator: "GTE", value: "active" },
        {
          kind: "group",
          operator: "OR",
          children: [
            { kind: "condition", field: "status", operator: "GT", value: "active" },
            {
              kind: "group",
              operator: "AND",
              children: [
                { kind: "condition", field: "status", operator: "EQ", value: "active" },
                { kind: "condition", field: "age", operator: "LT", value: 30 },
              ],
            },
            {
              kind: "group",
              operator: "AND",
              children: [
                { kind: "condition", field: "status", operator: "EQ", value: "active" },
                { kind: "condition", field: "age", operator: "EQ", value: 30 },
                { kind: "condition", field: "id", operator: "GT", value: 5 },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe("readFilter — the keyset composes with the client filter", () => {
  const filter = { root: { kind: "condition", field: "age", operator: "GTE", value: 18 } } as never;

  it("returns the client filter untouched under offset pagination", () => {
    const query = { filter, pagination: { limit: 10, offset: 0 } } as never;
    expect(readFilter(query)).toBe(filter);
  });

  it("returns the client filter untouched on the first cursor page", () => {
    const query = { filter, pagination: { limit: 10, cursor: null, keyset: null } } as never;
    expect(readFilter(query)).toBe(filter);
  });

  it("ANDs the keyset onto the client filter, never replacing it", () => {
    const keyset = keysetExpression(SORT_BY_ID, [7]);
    const query = { filter, pagination: { limit: 10, cursor: "t", keyset } } as never;
    expect(readFilter(query)).toEqual({
      root: { kind: "group", operator: "AND", children: [(filter as { root: unknown }).root, keyset] },
    });
  });

  it("uses the keyset alone when the client sent no filter", () => {
    const keyset = keysetExpression(SORT_BY_ID, [7]);
    const query = { filter: { root: null }, pagination: { limit: 10, cursor: "t", keyset } } as never;
    expect(readFilter(query)).toEqual({ root: keyset });
  });
});

// ── The strategy ──────────────────────────────────────────────────────

describe("CursorPaginationStrategy", () => {
  const strategy = new CursorPaginationStrategy();
  const limits = { defaultLimit: 20, maxLimit: 100 };

  it("carries the token through and leaves the keyset for the normalizer", () => {
    expect(strategy.normalize({ cursor: "abc", limit: "5" }, limits)).toEqual({
      limit: 5,
      cursor: "abc",
      keyset: null,
    });
  });

  it("reports no cursor at all for the first page", () => {
    expect(strategy.normalize({}, limits)).toEqual({ limit: 20, cursor: null, keyset: null });
  });

  it("produces no offset, so an adapter cannot read a meaningless one", () => {
    expect(strategy.normalize({}, limits)).not.toHaveProperty("offset");
  });

  it("clamps limit to maxLimit and rejects a malformed one, exactly like offset paging", () => {
    expect(strategy.normalize({ limit: "9999" }, limits).limit).toBe(100);
    expect(issuesOf(() => strategy.normalize({ limit: "0" }, limits))[0]).toMatchObject({
      field: "limit",
      code: "KAVO_QUERY_INVALID_VALUE",
    });
  });

  it("rejects a repeated cursor param rather than picking one arbitrarily", () => {
    expect(issuesOf(() => strategy.normalize({ cursor: ["a", "b"] }, limits))[0]).toMatchObject({
      field: "cursor",
      code: "KAVO_QUERY_INVALID_VALUE",
    });
  });
});

// ── Normalization: the tiebreaker rules ───────────────────────────────

describe("QueryNormalizer — cursor pagination requires a total order", () => {
  const normalizer = new QueryNormalizer<User>(userMetadata);

  const DEFAULT_ALLOWLISTS = {
    filterable: ["id", "name", "age", "status", "createdAt"],
    sortable: ["id", "name", "age", "status", "createdAt"],
    selectable: ["id", "name", "email", "age", "status", "createdAt"],
  };

  function configWith(
    defaultSort: readonly Sort<User>[],
    strategy = "cursor",
    allowed: Partial<typeof DEFAULT_ALLOWLISTS> = {},
  ): ResolvedEntityConfig<User> {
    const settings = {
      pagination: { defaultLimit: 20, maxLimit: 100, strategy, count: true },
      query: { maxFilterDepth: 5, maxInValues: 100, defaultSort },
      errors: { exposeInternals: false },
      relations: { maxIncludeDepth: 3, maxIncludedNodes: 20, edges: {} },
      softDelete: false,
      operations: {},
    } as unknown as KavoSettings;
    return {
      entityName: "User",
      settings,
      settingsFor: () => settings,
      allowed: { ...DEFAULT_ALLOWLISTS, ...allowed },
      softDelete: { strategy: "hard", field: "deletedAt" },
      dto: { resolve: () => null },
      relations: { all: () => [], get: () => undefined },
    } as unknown as ResolvedEntityConfig<User>;
  }

  it("accepts a sort ending in the id field", () => {
    const query = normalizer.normalizeWire({ sort: "-age,id" }, configWith([]));
    expect(isCursorPagination(query.pagination)).toBe(true);
    expect(query.pagination).toMatchObject({ limit: 20, cursor: null, keyset: null });
  });

  it("rejects a sort that does not end in the unique tiebreaker", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "-age" }, configWith([])));
    expect(issues[0]).toMatchObject({ field: "sort", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
    expect(issues[0]?.detail).toContain("'id'");
  });

  it("rejects id in a non-final position — only the last key breaks ties", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "id,-age" }, configWith([])));
    expect(issues[0]).toMatchObject({ field: "sort", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
  });

  it("rejects an empty effective sort and names the missing defaultSort", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({}, configWith([])));
    expect(issues[0]?.detail).toContain("defaultSort");
  });

  it("falls back to a conforming defaultSort without the client sending sort", () => {
    const query = normalizer.normalizeWire({}, configWith(SORT_BY_ID));
    expect(query.sort).toEqual(SORT_BY_ID);
    expect(isCursorPagination(query.pagination)).toBe(true);
  });

  it("decodes a valid cursor into a keyset predicate over the effective sort", () => {
    const token = encodeCursor([30, 5]);
    const query = normalizer.normalizeWire({ sort: "-age,id", cursor: token }, configWith([]));
    expect(isCursorPagination(query.pagination) && query.pagination.keyset).toEqual(
      keysetExpression(
        [
          { field: "age", direction: "desc" },
          { field: "id", direction: "asc" },
        ] as readonly Sort<User>[],
        [30, 5],
      ),
    );
  });

  it("rejects a tampered cursor as a query validation issue, not a crash", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "id", cursor: "!!!!" }, configWith([])));
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("reports the sort problem alone when both the sort and the cursor are wrong", () => {
    // A cursor decoded against a rejected sort would add a misleading
    // second issue about arity.
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "-age", cursor: "!!!!" }, configWith([])));
    expect(issues.map((issue) => issue.field)).toEqual(["sort"]);
  });

  it("applies the same rules on the programmatic path", () => {
    const good = normalizer.normalizeInput({ sort: SORT_BY_ID, cursor: encodeCursor([3]) }, configWith([]));
    expect(isCursorPagination(good.pagination) && good.pagination.keyset).not.toBeNull();

    const issues = issuesOf(() =>
      normalizer.normalizeInput({ sort: [{ field: "age", direction: "asc" }] } as never, configWith([])),
    );
    expect(issues[0]).toMatchObject({ field: "sort", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
  });

  it("treats an empty cursor as the first page, the same rule the strategy applies to wire params", () => {
    const query = normalizer.normalizeInput({ sort: SORT_BY_ID, cursor: "" }, configWith([]));
    expect(isCursorPagination(query.pagination) && query.pagination.keyset).toBeNull();
  });

  it("rejects a programmatic cursor under a non-cursor strategy rather than ignoring it", () => {
    const issues = issuesOf(() =>
      normalizer.normalizeInput({ cursor: encodeCursor([3]) }, configWith(SORT_BY_ID, "offset")),
    );
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });

  it("rejects a wire cursor under a non-cursor strategy too — both paths share the check", () => {
    // Silently dropping `?cursor=` would hand back page 1 forever while the
    // client believed it was paging.
    const issues = issuesOf(() =>
      normalizer.normalizeWire({ cursor: encodeCursor([3]) }, configWith(SORT_BY_ID, "offset")),
    );
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
    expect(issues[0]?.detail).toContain("'offset'");
  });

  it("leaves an empty wire cursor alone under a non-cursor strategy — it means 'first page'", () => {
    expect(() => normalizer.normalizeWire({ cursor: "" }, configWith(SORT_BY_ID, "offset"))).not.toThrow();
  });

  // ── The allowlists a cursor sort key must clear ─────────────────────

  it("rejects a cursor sort key that is not on the filterable allowlist", () => {
    // `keysetExpression` mints EQ/GT/LT nodes over every sort key and
    // `readFilter` ANDs them in *after* the filter parser has run, so
    // without this gate `?sort=email,id&cursor=…` is a comparison oracle
    // over a field `?filter[email][gt]=…` is a 400 for.
    const config = configWith([], "cursor", {
      sortable: ["id", "email"],
      filterable: ["id", "status"],
      selectable: ["id", "email", "status"],
    });
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "email,id" }, config));
    expect(issues[0]).toMatchObject({ field: "email", code: "KAVO_QUERY_INVALID_FIELD" });
    expect(issues[0]?.detail).toContain("filtering");
  });

  it("rejects a cursor sort key that is not on the selectable allowlist", () => {
    // `cursorValuesOf` reads the raw entity and `meta` never passes through
    // the serializer, so a non-selectable key would land in
    // `meta.nextCursor` base64-encoded regardless of the item DTO.
    const config = configWith([], "cursor", {
      sortable: ["id", "email"],
      filterable: ["id", "email"],
      selectable: ["id", "status"],
    });
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "email,id" }, config));
    expect(issues[0]).toMatchObject({ field: "email", code: "KAVO_QUERY_INVALID_FIELD" });
    expect(issues[0]?.detail).toContain("selection");
  });

  it("rejects rather than omits — dropping the key would break the total order", () => {
    const config = configWith([], "cursor", {
      sortable: ["id", "email"],
      filterable: ["id"],
      selectable: ["id"],
    });
    expect(() => normalizer.normalizeWire({ sort: "email,id" }, config)).toThrow();
  });

  it("applies the same three allowlists on the programmatic path", () => {
    const config = configWith([], "cursor", {
      sortable: ["id", "email"],
      filterable: ["id", "status"],
      selectable: ["id", "email", "status"],
    });
    const issues = issuesOf(() =>
      normalizer.normalizeInput({ sort: [{ field: "email", direction: "asc" }, ...SORT_BY_ID] } as never, config),
    );
    expect(issues.map((issue) => issue.field)).toContain("email");
  });

  it("accepts a sort key that clears sortable, filterable and selectable alike", () => {
    const config = configWith([], "cursor", {
      sortable: ["id", "name"],
      filterable: ["id", "name"],
      selectable: ["id", "name"],
    });
    expect(() => normalizer.normalizeWire({ sort: "name,id" }, config)).not.toThrow();
  });

  // ── The two `cursorSortIssue` branches ──────────────────────────────

  it("rejects a sort key that is not a scalar column of the entity", () => {
    const config = configWith([], "cursor", { sortable: ["id", "posts"], filterable: ["id", "posts"] });
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "posts,id" }, config));
    expect(issues[0]).toMatchObject({ field: "sort", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
    expect(issues[0]?.detail).toContain("not a scalar column");
  });

  it("rejects a json sort key — no portable ordering", () => {
    const withJson: EntityMetadata<User> = {
      ...userMetadata,
      fields: [...userMetadata.fields, { name: "profile", kind: "json", nullable: false, generated: false }],
    };
    const jsonNormalizer = new QueryNormalizer<User>(withJson);
    const config = configWith([], "cursor", {
      sortable: ["id", "profile"],
      filterable: ["id", "profile"],
      selectable: ["id", "profile"],
    });
    const issues = issuesOf(() => jsonNormalizer.normalizeWire({ sort: "profile,id" }, config));
    expect(issues[0]).toMatchObject({ field: "sort", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
    expect(issues[0]?.detail).toContain("'json'");
  });
});

// ── End to end, through the engine ────────────────────────────────────

describe("cursor pagination end to end", () => {
  it("walks every row exactly once, in order, across pages", async () => {
    const { crud } = cursorCrud();
    await seed(crud, 7);

    const { names, pages } = await walk(crud, 3);
    expect(names).toEqual(["user-1", "user-2", "user-3", "user-4", "user-5", "user-6", "user-7"]);
    expect(pages).toBe(3);
  });

  it("reports a nextCursor on a full page and null on the last", async () => {
    const { crud } = cursorCrud();
    await seed(crud, 4);

    const first = await crud.findMany({ limit: 2 } as never);
    expect(first.items).toHaveLength(2);
    expect(typeof nextCursorOf(first)).toBe("string");

    const second = await crud.findMany({ limit: 2, cursor: nextCursorOf(first) } as never);
    expect((second.items as User[]).map((user) => user.name)).toEqual(["user-3", "user-4"]);
    expect(nextCursorOf(second)).toBeNull();
  });

  it("reports nextCursor: null when the page exactly exhausts the match set", async () => {
    // The boundary the `limit + 1` over-fetch exists to get right: 4 rows,
    // limit 4, is the *last* page, not a full page with more behind it.
    const { crud } = cursorCrud();
    await seed(crud, 4);

    const page = await crud.findMany({ limit: 4 } as never);
    expect(page.items).toHaveLength(4);
    expect(nextCursorOf(page)).toBeNull();
  });

  it("never leaks the over-fetched sentinel row into the response", async () => {
    const { crud } = cursorCrud();
    await seed(crud, 10);

    const page = await crud.findMany({ limit: 3 } as never);
    expect(page.items).toHaveLength(3);
    expect(page.limit).toBe(3);
    expect((page.items as User[]).map((user) => user.name)).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("still drops the sentinel when limit lands exactly on maxLimit", async () => {
    // The `limit + 1` over-fetch asks for `maxLimit + 1`; the response must
    // still be capped at the page size the client was granted.
    const { crud } = cursorCrud({ pagination: { maxLimit: 3, defaultLimit: 3 } });
    await seed(crud, 8);

    const page = await crud.findMany({ limit: 3 } as never);
    expect(page.items).toHaveLength(3);
    expect(page.limit).toBe(3);
    expect(typeof nextCursorOf(page)).toBe("string");
  });

  it("returns an empty page with no cursor for an empty match set", async () => {
    const { crud } = cursorCrud();

    const page = await crud.findMany({ limit: 5 } as never);
    expect(page.items).toEqual([]);
    expect(nextCursorOf(page)).toBeNull();
    expect(page.total).toBe(0);
  });

  it("reports offset 0 on every cursor page — a keyset page has no absolute position", async () => {
    const { crud } = cursorCrud();
    await seed(crud, 5);

    const first = await crud.findMany({ limit: 2 } as never);
    const second = await crud.findMany({ limit: 2, cursor: nextCursorOf(first) } as never);
    expect(first.offset).toBe(0);
    expect(second.offset).toBe(0);
  });

  it("keeps total the size of the whole match set, not of what is left", async () => {
    const { crud } = cursorCrud();
    await seed(crud, 5);

    const first = await crud.findMany({ limit: 2 } as never);
    const second = await crud.findMany({ limit: 2, cursor: nextCursorOf(first) } as never);
    expect(first.total).toBe(5);
    expect(second.total).toBe(5);
  });

  it("still reports total: null when counting is disabled", async () => {
    const { crud } = cursorCrud({ pagination: { count: false } });
    await seed(crud, 3);

    const page = await crud.findMany({ limit: 2 } as never);
    expect(page.total).toBeNull();
    expect(typeof nextCursorOf(page)).toBe("string");
  });

  it("pages a descending sort correctly", async () => {
    const { crud } = cursorCrud({
      query: {
        defaultSort: [
          { field: "age", direction: "desc" },
          { field: "id", direction: "asc" },
        ],
      },
    });
    await seed(crud, 5);

    const { names } = await walk(crud, 2);
    expect(names).toEqual(["user-5", "user-4", "user-3", "user-2", "user-1"]);
  });

  it("pages a mixed asc/desc sort correctly", async () => {
    const { crud, adapter } = cursorCrud({
      query: {
        defaultSort: [
          { field: "status", direction: "asc" },
          { field: "age", direction: "desc" },
          { field: "id", direction: "asc" },
        ],
      },
    });
    await seed(crud, 6);
    // Two status buckets, so the leading key really has ties to break.
    for (const row of adapter.rows) {
      row.status = row.age % 2 === 0 ? "active" : "pending";
    }

    const { names } = await walk(crud, 2);
    expect(names).toEqual(["user-6", "user-4", "user-2", "user-5", "user-3", "user-1"]);
  });

  it("composes with a client filter — the keyset narrows it, never replaces it", async () => {
    const { crud } = cursorCrud();
    await seed(crud, 8);
    const gteFive = { filter: { kind: "condition", field: "age", operator: "GTE", value: 5 } };

    const first = await crud.findMany({ ...gteFive, limit: 2 } as never);
    expect((first.items as User[]).map((user) => user.name)).toEqual(["user-5", "user-6"]);
    expect(first.total).toBe(4);

    const second = await crud.findMany({ ...gteFive, limit: 2, cursor: nextCursorOf(first) } as never);
    expect((second.items as User[]).map((user) => user.name)).toEqual(["user-7", "user-8"]);
    expect(nextCursorOf(second)).toBeNull();
  });

  it("builds the cursor from the entity, so field selection cannot break paging", async () => {
    // `fields` strips `id` from the wire shape; the cursor is computed from
    // the entity, before serialization, so paging still works.
    const { crud } = cursorCrud();
    await seed(crud, 4);

    const first = await crud.findMany({ limit: 2, select: { root: ["name"] } } as never);
    expect(first.items[0]).not.toHaveProperty("id");
    const second = await crud.findMany({
      limit: 2,
      select: { root: ["name"] },
      cursor: nextCursorOf(first),
    } as never);
    expect(second.items.map((item) => (item as { name: string }).name)).toEqual(["user-3", "user-4"]);
  });

  it("rejects a tampered cursor over the wire with a 400-shaped query error", async () => {
    const { crud } = cursorCrud();
    await seed(crud, 3);

    await expect(
      crud.engine.execute({ operation: "findMany", query: new WireQuery({ cursor: "tampered!!" }) } as never),
    ).rejects.toMatchObject({ code: "KAVO_QUERY_INVALID", status: 400 });
  });

  it("does not shift or repeat rows when one is inserted before the cursor", async () => {
    // The whole selling point over offset paging: with `?offset=2` the
    // insert would push `user-2` down into page 2 and the client would see
    // it twice.
    const { crud, adapter } = cursorCrud();
    await seed(crud, 4);

    const first = await crud.findMany({ limit: 2 } as never);
    expect((first.items as User[]).map((user) => user.name)).toEqual(["user-1", "user-2"]);
    adapter.rows.unshift({ ...new User(), id: 0, name: "user-0", age: 0 });

    const second = await crud.findMany({ limit: 2, cursor: nextCursorOf(first) } as never);
    expect((second.items as User[]).map((user) => user.name)).toEqual(["user-3", "user-4"]);
  });

  it("resumes correctly when the row the cursor names is deleted between pages", async () => {
    // A keyset is a *value* comparison, not a row reference, so the boundary
    // row disappearing costs nothing.
    const { crud } = cursorCrud();
    await seed(crud, 5);

    const first = await crud.findMany({ limit: 2 } as never);
    await crud.deleteOne((first.items[1] as User).id);

    const second = await crud.findMany({ limit: 2, cursor: nextCursorOf(first) } as never);
    expect((second.items as User[]).map((user) => user.name)).toEqual(["user-3", "user-4"]);
  });

  it("emits a cursor carrying null for a null sort key, and 400s naming the column on replay", async () => {
    // `cursorValuesOf` degrades an absent/null key to `null`; the *next*
    // request is where that becomes an error. This is the loud half of the
    // null story — ADR-0021 §4 records the quiet half (a NULLS-LAST
    // ordering omits the null-keyed rows entirely, with no error at all).
    const { crud, adapter } = cursorCrud({
      query: {
        defaultSort: [
          { field: "name", direction: "asc" },
          { field: "id", direction: "asc" },
        ],
      },
    });
    await seed(crud, 4);
    // sqlite-style NULLS FIRST: the null-named row sorts to the front and
    // lands on the page-1 boundary.
    adapter.rows[0]!.name = null as never;
    adapter.rows[1]!.name = null as never;

    const first = await crud.findMany({ limit: 2 } as never);
    const token = nextCursorOf(first);
    expect(typeof token).toBe("string");

    await expect(crud.findMany({ limit: 2, cursor: token } as never)).rejects.toMatchObject({
      code: "KAVO_QUERY_INVALID",
      status: 400,
      issues: [{ field: "cursor", code: "KAVO_QUERY_INVALID_VALUE" }],
    });
    await expect(crud.findMany({ limit: 2, cursor: token } as never)).rejects.toMatchObject({
      issues: [{ detail: expect.stringContaining("'name'") as unknown as string }],
    });
  });

  it("reports nextCursor: null when a replacement findMany handler omits hasMore", async () => {
    // The engine takes a handler at its word: no has-more signal, no next
    // page. A handler that forgets `hasMore` degrades to one page rather
    // than looping.
    const adapter = new InMemoryUserAdapter();
    const crud = createKavo({
      defaults: {
        pagination: { strategy: "cursor" },
        query: { defaultSort: SORT_BY_ID },
      },
    } as never).createCrud(
      User,
      {
        operations: {
          createOne: true,
          findMany: {
            enabled: true,
            handler: {
              async execute(_input: unknown, context: { query: { pagination: { limit: number } } }) {
                return { entities: adapter.rows.slice(0, context.query.pagination.limit), total: adapter.rows.length };
              },
            },
          },
        },
      } as never,
      { adapter, metadata: userMetadata },
    );
    await seed(crud as never, 5);

    const page = await (crud as never as ReturnType<typeof cursorCrud>["crud"]).findMany({ limit: 2 } as never);
    expect(page.items).toHaveLength(2);
    expect(nextCursorOf(page)).toBeNull();
  });

  it("accepts the wire spelling of a cursor page", async () => {
    const { crud } = cursorCrud();
    await seed(crud, 5);

    const first = await crud.engine.execute({
      operation: "findMany",
      query: new WireQuery({ limit: "2" }),
    } as never);
    const token = nextCursorOf(first.list ?? {});
    const second = await crud.engine.execute({
      operation: "findMany",
      query: new WireQuery({ limit: "2", cursor: token }),
    } as never);
    const items = (second.list?.items ?? []) as readonly User[];
    expect(items.map((user) => user.name)).toEqual(["user-3", "user-4"]);
  });
});

/**
 * An adapter that honours the `limit + 1` over-fetch but reads
 * `query.filter` instead of `readFilter(query)`, so the keyset predicate
 * never reaches the rows. Every page is page 1, `hasMore` never goes
 * false, and the token the engine derives from the last row is the token
 * it was handed. This is the exact defect ADR-0021's guard exists to
 * catch, so the fixture reproduces the defect rather than mocking the
 * symptom.
 */
class KeysetIgnoringAdapter implements RepositoryAdapter<User> {
  constructor(private readonly inner: InMemoryUserAdapter = new InMemoryUserAdapter()) {}

  get rows(): User[] {
    return this.inner.rows;
  }

  async findMany(query: NormalizedQueryContext<User>): Promise<readonly User[]> {
    const ordered = [...this.inner.rows].sort((left, right) => left.id - right.id);
    return ordered.slice(0, query.pagination.limit);
  }

  async findOneById(id: EntityId) {
    return this.inner.findOneById(id);
  }
  async findOne(query: NormalizedQueryContext<User>) {
    return this.inner.findOne(query);
  }
  async count(query: NormalizedQueryContext<User>) {
    return this.inner.count(query);
  }
  async create(data: Partial<User>) {
    return this.inner.create(data);
  }
  async update(id: EntityId, data: Partial<User>) {
    return this.inner.update(id, data);
  }
  async patch(id: EntityId, data: Partial<User>) {
    return this.inner.patch(id, data);
  }
  async delete(id: EntityId) {
    return this.inner.delete(id);
  }
  async restore() {
    return this.inner.restore();
  }
  async purge(id: EntityId) {
    return this.inner.purge(id);
  }
}

describe("cursor pagination fails loudly when a page does not advance (ADR-0021)", () => {
  function ignoringCrud() {
    const adapter = new KeysetIgnoringAdapter();
    const crud = createKavo({
      defaults: {
        pagination: { strategy: "cursor" },
        query: { defaultSort: SORT_BY_ID },
      },
    } as never).createCrud(User, undefined, { adapter, metadata: userMetadata });
    return { crud, adapter };
  }

  it("throws ConfigurationException instead of handing back the token it was given", async () => {
    const { crud } = ignoringCrud();
    await seed(crud as never, 5);

    // Page 1 is well-formed even from a broken adapter: there is no
    // previous token to compare against, so the guard cannot fire yet.
    const first = await (crud as never as ReturnType<typeof cursorCrud>["crud"]).findMany({ limit: 2 } as never);
    const token = nextCursorOf(first);
    expect(typeof token).toBe("string");

    // Page 2 re-derives the same boundary row, which is where a client
    // following `nextCursor` would begin looping.
    await expect(
      (crud as never as ReturnType<typeof cursorCrud>["crud"]).findMany({ limit: 2, cursor: token } as never),
    ).rejects.toBeInstanceOf(ConfigurationException);
  });

  it("names the adapter contract that was broken, so the message is actionable", async () => {
    const { crud } = ignoringCrud();
    await seed(crud as never, 5);

    const client = crud as never as ReturnType<typeof cursorCrud>["crud"];
    const token = nextCursorOf(await client.findMany({ limit: 2 } as never));

    await expect(client.findMany({ limit: 2, cursor: token } as never)).rejects.toThrow(
      /did not advance.*readFilter\(query\)/s,
    );
  });

  it("names the sort-column cause too, not only the adapter one", async () => {
    // The guard fires for two unrelated reasons and an adapter that is
    // already correct is the more confusing of the two: #185 was diagnosed
    // by reading `TypeOrmRepositoryAdapter.findMany` first, on the message's
    // instruction, and finding it did call `readFilter(query)`. The real
    // cause was a date column holding two textual spellings of one instant.
    const { crud } = ignoringCrud();
    await seed(crud as never, 5);

    const client = crud as never as ReturnType<typeof cursorCrud>["crud"];
    const token = nextCursorOf(await client.findMany({ limit: 2 } as never));

    const error = await client.findMany({ limit: 2, cursor: token } as never).catch((thrown: unknown) => thrown);
    const message = (error as ConfigurationException).message;
    expect(message).toMatch(/ORDER BY/);
    expect(message).toMatch(/sort column/);
  });

  it("still reports the entity and the config path the failure belongs to", async () => {
    const { crud } = ignoringCrud();
    await seed(crud as never, 5);

    const client = crud as never as ReturnType<typeof cursorCrud>["crud"];
    const token = nextCursorOf(await client.findMany({ limit: 2 } as never));

    const error = await client.findMany({ limit: 2, cursor: token } as never).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ConfigurationException);
    expect((error as ConfigurationException).message).toContain("User");
    expect((error as ConfigurationException).message).toContain("pagination.strategy");
  });
});
