import { describe, expect, it } from "vitest";
import type { KavoSettings, ResolvedEntityConfig, Sort } from "@kavo/core";
import { QueryNormalizer, encodeCompositeId, encodeCursor, hasKeyset, isSincePagination } from "@kavo/core";
import { issuesOf } from "./support/query-issues.js";
import { compositeMetadata, CompositeEntity } from "./support/composite-fixture.js";

/**
 * `QueryNormalizer`'s composite-key tiebreaker generalization (issue #263):
 * the forced-sort/keyset machinery (`keysetExpression`, `decodeCursor`)
 * already operates over an arbitrary-length effective sort, so the only
 * thing that had to generalize was "what does the tiebreaker require" —
 * covered directly here rather than through the full engine, which
 * `packages/orms/typeorm/tests/composite-primary-key.spec.ts` already does
 * end-to-end against a real database.
 */

const DEFAULT_ALLOWLISTS = {
  filterable: ["userId", "topic", "key"],
  sortable: ["userId", "topic", "key"],
  selectable: ["userId", "topic", "key"],
};

/** `{ field: "key", direction: "desc" }` → `"-key"` — the `defaults.sort` wire shorthand. */
function sortWireToken(entry: Sort<CompositeEntity>): string {
  return entry.direction === "desc" ? `-${entry.field as string}` : (entry.field as string);
}

function configWith(
  defaultSort: readonly Sort<CompositeEntity>[],
  strategy = "cursor",
  sinceField = "key",
  allowed: Partial<typeof DEFAULT_ALLOWLISTS> = {},
): ResolvedEntityConfig<CompositeEntity> {
  const settings = {
    pagination: { defaultLimit: 20, maxLimit: 100, strategy, count: true, since: { field: sinceField } },
    limits: { filterDepth: 5, inValues: 100, likePattern: 200, includeDepth: 3, includedNodes: 20 },
    search: false,
    errors: { exposeInternals: false },
    relations: { edges: {} },
    defaults: { sort: defaultSort.map(sortWireToken), include: [] },
    softDelete: false,
    operations: {},
  } as unknown as KavoSettings;
  return {
    entityName: "CompositeEntity",
    settings,
    settingsFor: () => settings,
    allowed: { ...DEFAULT_ALLOWLISTS, ...allowed },
    softDelete: { strategy: "hard", field: "deletedAt" },
    dto: { resolve: () => null },
    relations: { all: () => [], get: () => undefined },
  } as unknown as ResolvedEntityConfig<CompositeEntity>;
}

describe("QueryNormalizer — cursor pagination's composite-key tiebreaker (issue #263)", () => {
  const normalizer = new QueryNormalizer<CompositeEntity>(compositeMetadata);

  it("accepts a sort ending in the full compositeIdFields tuple, in order", () => {
    const query = normalizer.normalizeWire({ sort: "-key,userId,topic" }, configWith([]));
    expect(hasKeyset(query.pagination)).toBe(true);
  });

  it("rejects a sort ending in only one of the two key columns", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "-key,topic" }, configWith([])));
    expect(issues[0]).toMatchObject({ field: "sort", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
    expect(issues[0]?.detail).toContain("userId,topic");
  });

  it("rejects the key columns out of declaration order", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "topic,userId" }, configWith([])));
    expect(issues[0]).toMatchObject({ field: "sort", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
  });

  it("decodes a cursor carrying all three sort-key values", () => {
    const cursor = encodeCursor(["k1", "u1", "t1"]);
    const query = normalizer.normalizeWire({ sort: "-key,userId,topic", cursor }, configWith([]));
    expect(hasKeyset(query.pagination)).toBe(true);
    if (hasKeyset(query.pagination)) {
      expect(query.pagination.keyset).not.toBeNull();
    }
  });
});

describe("QueryNormalizer — since pagination's composite-key tiebreaker (issue #263)", () => {
  const normalizer = new QueryNormalizer<CompositeEntity>(compositeMetadata);

  it("forces the sort to [since.field, ...compositeIdFields] ascending", () => {
    const query = normalizer.normalizeWire({}, configWith([], "since"));
    expect(query.sort).toEqual([
      { field: "key", direction: "asc" },
      { field: "userId", direction: "asc" },
      { field: "topic", direction: "asc" },
    ]);
  });

  it("decodes a since token whose id half is the ~-delimited composite id", () => {
    const token = `abc|${encodeCompositeId(["u1", "t1"])}`;
    const query = normalizer.normalizeWire({ since: token }, configWith([], "since"));
    expect(isSincePagination(query.pagination)).toBe(true);
    if (isSincePagination(query.pagination)) {
      expect(query.pagination.keyset).not.toBeNull();
    }
  });

  it("rejects a since token whose id half does not decode into two key columns", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ since: "abc|only-one-part" }, configWith([], "since")));
    expect(issues[0]).toMatchObject({ field: "since", code: "KAVO_QUERY_INVALID_VALUE" });
  });
});
