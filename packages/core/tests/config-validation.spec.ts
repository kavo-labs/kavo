import { describe, expect, it } from "vitest";
import type { KavoSettings, DeepPartial } from "@kavo/core";
import { BUILT_IN_DEFAULTS, ConfigurationException, mergeSettings, resolveEntityConfig, validateSettings } from "@kavo/core";
import { userMetadata } from "./support/user-fixture.js";

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

/**
 * `filter.limits`/`sort.default`/`select.default`/`include.default`/`search`
 * (issue #386) are entity-scope field-group config, not `KavoSettings` —
 * validated by `resolveEntityConfig` (`resolve-entity-config.ts`), not
 * `validateSettings`. These blocks exercise that resolver directly instead.
 */
function rejectedEntityConfig(config: unknown): ConfigurationException {
  try {
    resolveEntityConfig(userMetadata, config as never, undefined);
  } catch (error) {
    if (error instanceof ConfigurationException) {
      return error;
    }
    throw error;
  }
  throw new Error("expected ConfigurationException");
}

describe("resolveEntityConfig — filter.limits", () => {
  it("rejects a maxDepth that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      const error = rejectedEntityConfig({ filter: { limits: { maxDepth: value } } });
      expect(error.code).toBe("KAVO_CONFIG_INVALID");
      expect(error.messageParams).toMatchObject({ path: "filter.limits.maxDepth" });
    }
  });

  it("rejects a maxInValues that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      const error = rejectedEntityConfig({ filter: { limits: { maxInValues: value } } });
      expect(error.messageParams).toMatchObject({ path: "filter.limits.maxInValues" });
    }
  });

  it("rejects a maxLikePatternLength that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      const error = rejectedEntityConfig({ filter: { limits: { maxLikePatternLength: value } } });
      expect(error.messageParams).toMatchObject({ path: "filter.limits.maxLikePatternLength" });
    }
  });

  it("accepts a depth, value cap, and like-pattern cap of 1", () => {
    expect(() =>
      resolveEntityConfig(
        userMetadata,
        { filter: { limits: { maxDepth: 1, maxInValues: 1, maxLikePatternLength: 1 } } },
        undefined,
      ),
    ).not.toThrow();
  });
});

describe("resolveEntityConfig — sort/select/include defaults", () => {
  it("rejects a sort.default that is not an array", () => {
    const error = rejectedEntityConfig({ sort: { default: "name" } });
    expect(error.messageParams).toMatchObject({ path: "sort.default" });
  });

  it("rejects a sort.default entry outside sort.fields", () => {
    const error = rejectedEntityConfig({ sort: { fields: ["name"], default: ["email"] } });
    expect(error.messageParams).toMatchObject({ path: "sort.default" });
  });

  it("rejects a select.default entry outside select.fields", () => {
    const error = rejectedEntityConfig({ select: { fields: ["name"], default: ["email"] } });
    expect(error.messageParams).toMatchObject({ path: "select.default" });
  });

  it("accepts a well-formed sort.default/select.default", () => {
    expect(() =>
      resolveEntityConfig(
        userMetadata,
        {
          sort: { default: ["-createdAt", "id"] },
          select: { default: ["id", "name"] },
        },
        undefined,
      ),
    ).not.toThrow();
  });
});

describe("resolveEntityConfig — search", () => {
  it("defaults to disabled (false)", () => {
    const config = resolveEntityConfig(userMetadata, undefined, undefined);
    expect(config.search).toBe(false);
  });

  it("accepts search: false (disabled)", () => {
    expect(() => resolveEntityConfig(userMetadata, { search: false }, undefined)).not.toThrow();
  });

  it("rejects a search.mode outside substring/words", () => {
    for (const value of ["Substring", "word", 1, null]) {
      expect(() => resolveEntityConfig(userMetadata, { search: { mode: value } } as never, undefined)).toThrow();
    }
  });

  it("accepts an explicit, well-formed search setting", () => {
    const config = resolveEntityConfig(userMetadata, { search: { mode: "words", driver: "orm" } }, undefined);
    expect(config.search).toMatchObject({ mode: "words", driver: "orm" });
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

  it("rejects a cache.ttl that is not a positive integer, false, or omitted", () => {
    for (const value of [0, -1, 1.5, "60", null]) {
      const error = rejectionOf({ cache: { ttl: value } });
      expect(error.messageParams).toMatchObject({ entity: "User", path: "cache.ttl" });
    }
    for (const value of [60, false]) {
      expect(() => accept({ cache: { ttl: value } })).not.toThrow();
    }
    expect(() => accept({ cache: { etag: true } })).not.toThrow();
  });

  it("bootstrap rejects 'cache: { ttl: 0 }' — omit 'ttl' or use 'ttl: false' instead", () => {
    const error = rejectionOf({ cache: { ttl: 0 } });
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error.messageParams).toMatchObject({ entity: "User", path: "cache.ttl" });
  });

  it("rejects a cache that is neither the object nor false", () => {
    for (const value of [true, "yes", 0]) {
      const error = rejectionOf({ cache: value });
      expect(error.messageParams).toMatchObject({ entity: "User", path: "cache" });
    }
  });
});

describe("resolveEntityConfig — include.limits", () => {
  it("rejects a maxDepth that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      const error = rejectedEntityConfig({ include: { limits: { maxDepth: value } } });
      expect(error.messageParams).toMatchObject({ path: "include.limits.maxDepth" });
    }
  });

  it("rejects a maxNodes that is not a positive integer", () => {
    for (const value of NOT_POSITIVE_INTEGERS) {
      const error = rejectedEntityConfig({ include: { limits: { maxNodes: value } } });
      expect(error.messageParams).toMatchObject({ path: "include.limits.maxNodes" });
    }
  });

  it("accepts a budget of one node at depth one", () => {
    expect(() =>
      resolveEntityConfig(userMetadata, { include: { limits: { maxDepth: 1, maxNodes: 1 } } }, undefined),
    ).not.toThrow();
  });
});

describe("validateSettings — relation edges", () => {
  it("rejects an edge that is not an object, naming the relation", () => {
    for (const value of [true, 5, "posts", null]) {
      expectRejected({ relations: { edges: { posts: value } } }, "relations.edges.posts", value);
    }
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

  // `defaults.include` vs. permission (`allowed.includable`) is no longer
  // checkable by `validateSettings` alone — permission moved to entity-typed
  // `EntityConfig.allowed` (ADR-0028), outside the `KavoSettings` shape
  // this file exercises. See `config.spec.ts`'s
  // "resolveEntityConfig — allowed.includable" describe block for that
  // cross-check, now performed by `validateDefaults`.

  it("accepts an edge that configures nothing — every sub-key is optional", () => {
    expect(() => accept({ relations: { edges: { posts: {} } } })).not.toThrow();
  });

  it("accepts each documented load strategy", () => {
    for (const strategy of ["join", "batch", "key", "auto"]) {
      expect(() => accept({ relations: { edges: { posts: { strategy } } } })).not.toThrow();
    }
  });

  it("accepts maxDepth shape regardless of includable permission", () => {
    // `validateSettings` only checks shape now — whether `posts` is actually
    // includable is `resolveEntityConfig`'s `allowed`-aware cross-check.
    expect(() => accept({ relations: { edges: { posts: { maxDepth: 1 } } } })).not.toThrow();
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
      validateSettings("User (per-call)", mergeSettings(BUILT_IN_DEFAULTS, { pagination: { maxLimit: -1 } }));
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "User (per-call)",
        path: "pagination.maxLimit",
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
