import { describe, expect, it } from "vitest";
import type { KavoSettings, DeepPartial } from "@kavo/core";
import { BUILT_IN_DEFAULTS, ConfigurationException, mergeSettings, validateSettings } from "@kavo/core";

/**
 * Validate one override merged onto the built-in defaults, returning the
 * `ConfigurationException` it must raise. The final throw is what stops a
 * test from passing vacuously when validation accepts the value
 * (cf. tests/support/query-issues.ts).
 */
function rejectionOf(override: unknown): ConfigurationException {
  try {
    validateSettings("User", mergeSettings(BUILT_IN_DEFAULTS, override as DeepPartial<KavoSettings>));
  } catch (error) {
    if (error instanceof ConfigurationException) {
      return error;
    }
    throw error;
  }
  throw new Error("expected ConfigurationException");
}

/** The error bar: every config error names entity, key path, and offending value. */
function expectRejected(override: unknown, path: string, offending: unknown): void {
  const error = rejectionOf(override);
  expect(error.code).toBe("KAVO_CONFIG_INVALID");
  expect(error.messageParams).toMatchObject({ entity: "User", path });
  expect(String(error.messageParams["problem"])).toContain(JSON.stringify(offending));
}

function accept(override: unknown): void {
  validateSettings("User", mergeSettings(BUILT_IN_DEFAULTS, override as DeepPartial<KavoSettings>));
}

/** Values no positive-integer setting may take. */
const NOT_POSITIVE_INTEGERS = [0, -1, 1.5, "20", null, true];

describe("validateSettings — pagination", () => {
  it("rejects a defaultLimit that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      expectRejected({ pagination: { defaultLimit: value } }, "pagination.defaultLimit", value);
    }
  });

  it("rejects a non-boolean count", () => {
    for (const value of ["true", 1, null]) {
      expectRejected({ pagination: { count: value } }, "pagination.count", value);
    }
  });

  it("rejects a strategy that is not a name", () => {
    for (const value of [1, null, false]) {
      expectRejected({ pagination: { strategy: value } }, "pagination.strategy", value);
    }
  });

  it("accepts a defaultLimit exactly at maxLimit", () => {
    expect(() => accept({ pagination: { defaultLimit: 100, maxLimit: 100 } })).not.toThrow();
  });

  it("accepts the smallest legal limits", () => {
    expect(() => accept({ pagination: { defaultLimit: 1, maxLimit: 1 } })).not.toThrow();
  });

  it("accepts an unrecognized strategy name — resolving it is the normalizer's job", () => {
    // A custom strategy is registered on the root factory
    // (`paginationStrategies`), which this function cannot see; an unknown
    // name surfaces at query time instead.
    expect(() => accept({ pagination: { strategy: "cursor" } })).not.toThrow();
  });
});

describe("validateSettings — query limits", () => {
  it("rejects a maxFilterDepth that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      expectRejected({ query: { maxFilterDepth: value } }, "query.maxFilterDepth", value);
    }
  });

  it("rejects a maxInValues that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      expectRejected({ query: { maxInValues: value } }, "query.maxInValues", value);
    }
  });

  it("accepts a depth and a value cap of 1", () => {
    expect(() => accept({ query: { maxFilterDepth: 1, maxInValues: 1 } })).not.toThrow();
  });

  it("rejects a defaultSort that is not an array", () => {
    for (const value of ["name", null, { field: "name", direction: "asc" }]) {
      expectRejected({ query: { defaultSort: value } }, "query.defaultSort", value);
    }
  });

  it("rejects a defaultSort entry missing a field or with a non-string field", () => {
    for (const entry of [{}, { field: 1, direction: "asc" }, { direction: "asc" }]) {
      expectRejected({ query: { defaultSort: [entry] } }, "query.defaultSort[0]", entry);
    }
  });

  it("rejects a defaultSort entry with an invalid direction", () => {
    expectRejected(
      { query: { defaultSort: [{ field: "name", direction: "up" }] } },
      "query.defaultSort[0].direction",
      "up",
    );
  });

  it("accepts a well-formed defaultSort", () => {
    expect(() =>
      accept({
        query: {
          defaultSort: [
            { field: "createdAt", direction: "desc" },
            { field: "id", direction: "asc" },
          ],
        },
      }),
    ).not.toThrow();
  });
});

describe("validateSettings — query.search", () => {
  it("defaults to disabled (false)", () => {
    expect(BUILT_IN_DEFAULTS.query.search).toBe(false);
  });

  it("accepts search: false (disabled)", () => {
    expect(() => accept({ query: { search: false } })).not.toThrow();
  });

  it("rejects a search.mode outside substring/words", () => {
    for (const value of ["Substring", "word", 1, null]) {
      expectRejected({ query: { search: { mode: value } } }, "query.search.mode", value);
    }
  });

  it("rejects any search.driver other than 'orm'", () => {
    for (const value of ["postgres", "meilisearch", "", null]) {
      expectRejected({ query: { search: { mode: "substring", driver: value } } }, "query.search.driver", value);
    }
  });

  it("accepts an explicit, well-formed search setting", () => {
    expect(() => accept({ query: { search: { mode: "words", driver: "orm" } } })).not.toThrow();
  });
});

describe("validateSettings — errors", () => {
  it("rejects a non-boolean exposeInternals", () => {
    for (const value of ["false", 0, null]) {
      expectRejected({ errors: { exposeInternals: value } }, "errors.exposeInternals", value);
    }
  });

  it("accepts both booleans", () => {
    expect(() => accept({ errors: { exposeInternals: true } })).not.toThrow();
    expect(() => accept({ errors: { exposeInternals: false } })).not.toThrow();
  });
});

describe("validateSettings — cache", () => {
  it("rejects a cache.etag that is not a boolean", () => {
    for (const value of ["false", 0, null, {}, { enabled: true }]) {
      expectRejected({ cache: { etag: value } }, "cache.etag", value);
    }
  });

  it("accepts the boolean shorthand", () => {
    expect(() => accept({ cache: { etag: true } })).not.toThrow();
    expect(() => accept({ cache: { etag: false } })).not.toThrow();
    expect(() => accept({ cache: false })).not.toThrow();
  });

  it("rejects a cache.ttl that is not a non-negative integer", () => {
    for (const value of [-1, 1.5, "60", null]) {
      const error = rejectionOf({ cache: { ttl: value } });
      expect(error.messageParams).toMatchObject({ entity: "User", path: "cache.ttl" });
    }
    for (const value of [0, 60]) {
      expect(() => accept({ cache: { ttl: value } })).not.toThrow();
    }
  });

  it("rejects a cache that is neither the object nor false", () => {
    for (const value of [true, "yes", 0]) {
      const error = rejectionOf({ cache: value });
      expect(error.messageParams).toMatchObject({ entity: "User", path: "cache" });
    }
  });
});

describe("validateSettings — relation limits", () => {
  it("rejects a maxIncludeDepth that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      expectRejected({ relations: { maxIncludeDepth: value } }, "relations.maxIncludeDepth", value);
    }
  });

  it("rejects a maxIncludedNodes that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      expectRejected({ relations: { maxIncludedNodes: value } }, "relations.maxIncludedNodes", value);
    }
  });

  it("accepts a budget of one node at depth one", () => {
    expect(() => accept({ relations: { maxIncludeDepth: 1, maxIncludedNodes: 1 } })).not.toThrow();
  });
});

describe("validateSettings — relation edges", () => {
  it("rejects an edge that is not an object, naming the relation", () => {
    for (const value of [true, 5, "posts", null]) {
      expectRejected({ relations: { edges: { posts: value } } }, "relations.edges.posts", value);
    }
  });

  it("rejects a non-boolean defaultInclude", () => {
    expectRejected(
      { relations: { edges: { posts: { defaultInclude: 1 } } } },
      "relations.edges.posts.defaultInclude",
      1,
    );
  });

  it("rejects a maxDepth that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      expectRejected({ relations: { edges: { posts: { maxDepth: value } } } }, "relations.edges.posts.maxDepth", value);
    }
  });

  it("rejects a load strategy outside join, batch, key, and auto", () => {
    for (const value of ["eager", "JOIN", "KEY", 1]) {
      expectRejected({ relations: { edges: { posts: { strategy: value } } } }, "relations.edges.posts.strategy", value);
    }
  });

  // `defaultInclude` vs. permission (`allowlists.includable`) is no longer
  // checkable by `validateSettings` alone — permission moved to entity-typed
  // `EntityConfig.allowlists` (ADR-0028), outside the `KavoSettings` shape
  // this file exercises. See `config.spec.ts`'s
  // "resolveEntityConfig — allowlists.includable" describe block for that
  // cross-check, now performed by `validateIncludableRelations`.

  it("accepts an edge that configures nothing — every sub-key is optional", () => {
    expect(() => accept({ relations: { edges: { posts: {} } } })).not.toThrow();
  });

  it("accepts each documented load strategy", () => {
    for (const strategy of ["join", "batch", "key", "auto"]) {
      expect(() => accept({ relations: { edges: { posts: { strategy } } } })).not.toThrow();
    }
  });

  it("accepts defaultInclude/maxDepth shape regardless of includable permission", () => {
    // `validateSettings` only checks shape now — whether `posts` is actually
    // includable is `resolveEntityConfig`'s `allowlists`-aware cross-check.
    expect(() => accept({ relations: { edges: { posts: { defaultInclude: true, maxDepth: 1 } } } })).not.toThrow();
  });
});

describe("validateSettings — soft delete", () => {
  it("rejects a softDelete that names no delete-marker field", () => {
    for (const softDelete of [true, 1, "deletedAt", { field: "" }, { field: 5 }]) {
      const error = rejectionOf({ softDelete });
      expect(error.messageParams).toMatchObject({ entity: "User", path: "softDelete" });
    }
    expect(String(rejectionOf({ softDelete: true }).messageParams["problem"])).toContain("true");
  });

  it("rejects a strategy outside auto, soft, and hard", () => {
    for (const value of ["off", "SOFT", 1, null]) {
      expectRejected({ softDelete: { strategy: value } }, "softDelete.strategy", value);
    }
  });

  it("accepts `false` — the documented way to disable the feature entirely", () => {
    expect(() => accept({ softDelete: false })).not.toThrow();
  });

  it("accepts each documented strategy on a named field", () => {
    for (const strategy of ["auto", "soft", "hard"]) {
      expect(() => accept({ softDelete: { field: "removedAt", strategy } })).not.toThrow();
    }
  });
});

describe("validateSettings — realtime", () => {
  it("defaults to `false` — no separate `enabled` key (issue #247)", () => {
    expect(BUILT_IN_DEFAULTS.realtime).toBe(false);
  });

  it("accepts `false` — the documented way to disable the feature entirely", () => {
    expect(() => accept({ realtime: false })).not.toThrow();
  });

  it("accepts a realtime override that omits `events` entirely, even against the `false` base (issue #247)", () => {
    // `mergeSettings` replaces a non-object base wholesale, so a first-time
    // partial override has no complete `{ events: {} }` object to merge
    // against — `events` must tolerate being entirely absent, not just `{}`.
    expect(() => accept({ realtime: { subscribableFields: ["title"] } })).not.toThrow();
    expect(() => accept({ realtime: {} })).not.toThrow();
  });

  it("rejects a realtime setting that is neither an object nor false", () => {
    for (const value of ["on", 1, true, null]) {
      expectRejected({ realtime: value }, "realtime", value);
    }
  });

  it("rejects a realtime.events that is not an object", () => {
    for (const value of ["created", 1, true, null]) {
      expectRejected({ realtime: { events: value } }, "realtime.events", value);
    }
  });

  it("rejects an unknown realtime event id", () => {
    const error = rejectionOf({ realtime: { events: { archived: true } } });
    expect(error.code).toBe("KAVO_CONFIG_INVALID");
    expect(error.messageParams).toMatchObject({ entity: "User", path: "realtime.events.archived" });
  });

  it("rejects a non-boolean value for a known realtime event id", () => {
    for (const value of ["off", 1, null]) {
      expectRejected({ realtime: { events: { patched: value } } }, "realtime.events.patched", value);
    }
  });

  it("accepts every documented event id set to a boolean", () => {
    expect(() =>
      accept({
        realtime: {
          events: { created: true, updated: true, patched: false, deleted: true, restored: false },
        },
      }),
    ).not.toThrow();
  });

  it("accepts subscribableFields as an explicit array", () => {
    expect(() => accept({ realtime: { events: {}, subscribableFields: ["title", "status"] } })).not.toThrow();
  });

  it("accepts subscribableFields as an exclude selector", () => {
    expect(() =>
      accept({ realtime: { events: {}, subscribableFields: { exclude: ["internalNotes"] } } }),
    ).not.toThrow();
  });

  it("rejects a subscribableFields shape that is neither an array nor { exclude }", () => {
    for (const value of ["title", 1, { includes: ["title"] }, { exclude: "title" }]) {
      expectRejected({ realtime: { events: {}, subscribableFields: value } }, "realtime.subscribableFields", value);
    }
  });

  it("rejects a non-function onPublishError", () => {
    for (const value of ["log", 1, {}]) {
      expectRejected({ realtime: { events: {}, onPublishError: value } }, "realtime.onPublishError", value);
    }
  });
});

describe("validateSettings — arrayMutation", () => {
  it("accepts `false` — the documented way to disable the feature entirely", () => {
    expect(() => accept({ arrayMutation: false })).not.toThrow();
  });

  it("rejects an arrayMutation setting that is neither an object nor false", () => {
    for (const value of ["replace", 1, true, null]) {
      expectRejected({ arrayMutation: value }, "arrayMutation", value);
    }
  });

  it("rejects a strategy outside replace, resource, and jsonPatch", () => {
    for (const value of ["splice", 1, null]) {
      expectRejected({ arrayMutation: { strategy: value } }, "arrayMutation.strategy", value);
    }
  });

  it("accepts each documented strategy", () => {
    for (const strategy of ["replace", "resource", "jsonPatch"]) {
      expect(() => accept({ arrayMutation: { strategy } })).not.toThrow();
    }
  });
});

describe("validateSettings — global operations default (issue #38)", () => {
  it("rejects an unknown operation id", () => {
    const error = rejectionOf({ operations: { notAnOperation: false } });
    expect(error.code).toBe("KAVO_CONFIG_INVALID");
    expect(error.messageParams).toMatchObject({ entity: "User", path: "operations.notAnOperation" });
  });

  it("rejects a non-boolean value for a known operation id", () => {
    for (const value of ["off", 1, null]) {
      expectRejected({ operations: { deleteOne: value } }, "operations.deleteOne", value);
    }
  });

  it("accepts a boolean map over known operation ids", () => {
    expect(() => accept({ operations: { deleteOne: false, patchOne: false, restoreOne: true } })).not.toThrow();
  });

  it("accepts an empty map — the zero-config default", () => {
    expect(() => accept({ operations: {} })).not.toThrow();
  });
});

describe("validateSettings — the base of the precedence chain", () => {
  it("accepts the built-in defaults unchanged", () => {
    // Everything merges onto these, so a schema change that leaves them
    // invalid would break the zero-config path first.
    expect(() => validateSettings("User", BUILT_IN_DEFAULTS)).not.toThrow();
  });

  it("names whichever scope label the caller passed", () => {
    // The engine validates per-call overrides under a derived label, so
    // the entity name is a parameter, not a lookup.
    try {
      validateSettings("User (per-call)", mergeSettings(BUILT_IN_DEFAULTS, { query: { maxInValues: 0 } }));
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User (per-call)",
        path: "query.maxInValues",
      });
    }
  });
});

describe("validateSettings — pagination.since.field", () => {
  // The since boundary column is a field *name*, and it is read back off a
  // row to build `meta.nextSince`. An empty or non-string name would fail
  // deep inside normalization on the first request instead of at bootstrap.
  it.each(["", null, 1, false])("rejects %o as a since field name", (value) => {
    expectRejected({ pagination: { since: { field: value } } }, "pagination.since.field", value);
  });

  it("accepts a non-empty field name", () => {
    accept({ pagination: { since: { field: "updatedAt" } } });
  });
});
