import { describe, expect, it } from "vitest";
import type { ClassRef, EntityMetadata } from "@kavo/core";
import {
  ConfigurationException,
  DefaultEntityCatalog,
  DefaultIncludeResolver,
  NONE_PAGINATION_LIMIT,
  QueryNormalizer,
  QueryValidationException,
  resolveEntityConfig,
} from "@kavo/core";
import { userMetadata } from "./support/user-fixture.js";
import { accountMetadata } from "./support/account-fixture.js";
import type { Post } from "./support/blog-fixture.js";
import { Author, Comment, authorMetadata, commentMetadata, postMetadata } from "./support/blog-fixture.js";
import { issuesOf } from "./support/query-issues.js";

const config = resolveEntityConfig(userMetadata, undefined, undefined);
const normalizer = new QueryNormalizer(userMetadata);

const softDeletableConfig = resolveEntityConfig(accountMetadata, undefined, undefined);
const softDeletableNormalizer = new QueryNormalizer(accountMetadata);

/**
 * `Post` is the one fixture that is both soft-deletable (`deletedAt`) and
 * relation-bearing, so it is the only place the whole grammar — filter,
 * sort, pagination, root and relation fieldsets, includes, and the
 * soft-delete flags — can meet in a single normalized request.
 */
const postCatalog = new DefaultEntityCatalog((entity: ClassRef) => {
  if (entity === Comment) {
    return commentMetadata as unknown as EntityMetadata<object>;
  }
  if (entity === Author) {
    return authorMetadata as unknown as EntityMetadata<object>;
  }
  return undefined;
});
const postConfig = resolveEntityConfig(postMetadata, { include: { fields: ["comments"] } }, undefined);
const postNormalizer = new QueryNormalizer<Post>(postMetadata, [], new DefaultIncludeResolver<Post>(postCatalog));

describe("QueryNormalizer — wire params", () => {
  it("normalizes the full reference query", () => {
    const query = normalizer.normalizeWire(
      {
        "filter[age][gte]": "18",
        sort: "-createdAt,name",
        limit: "20",
        offset: "20",
        select: "id,name,email",
      },
      config,
    );
    expect(query.filter.root).toMatchObject({ operator: "GTE", value: 18 });
    expect(query.sort).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "name", direction: "asc" },
    ]);
    expect(query.pagination).toEqual({ limit: 20, offset: 20 });
    expect(query.select.root).toEqual(["id", "name", "email"]);
    expect(query.include).toEqual({});
    expect(query.withDeleted).toBe(false);
    expect(query.count).toBe(true);
  });

  it("applies defaultLimit and clamps to maxLimit", () => {
    const defaulted = normalizer.normalizeWire({}, config);
    expect(defaulted.pagination).toEqual({ limit: 20, offset: 0 });
    const clamped = normalizer.normalizeWire({ limit: "9999" }, config);
    expect(clamped.pagination.limit).toBe(100);
  });

  it("issues no sort at all when neither the client nor config supplies one", () => {
    expect(normalizer.normalizeWire({}, config).sort).toEqual([]);
  });

  it("rejects malformed pagination values", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ limit: "abc" }, config));
    expect(issues[0]).toMatchObject({
      field: "limit",
      code: "KAVO_QUERY_INVALID_VALUE",
    });
  });

  it("rejects non-sortable fields", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "-password" }, config));
    expect(issues[0]).toMatchObject({
      field: "password",
      code: "KAVO_QUERY_INVALID_FIELD",
    });
  });

  // Both features ship; this normalizer is built without an include
  // resolver and against a config that does not declare soft delete, so
  // asking for either is unsupported *here* rather than unimplemented.
  it("rejects include and withDeleted=true when neither is configured", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ include: "posts", withDeleted: "true" }, config));
    const codes = issues.map((issue) => issue.code);
    expect(codes).toEqual(["KAVO_QUERY_UNSUPPORTED_PARAM", "KAVO_QUERY_UNSUPPORTED_PARAM"]);
  });

  it("accepts withDeleted=false (the default) without complaint", () => {
    const query = normalizer.normalizeWire({ withDeleted: "false" }, config);
    expect(query.withDeleted).toBe(false);
  });

  it("collects issues across sections in one exception", () => {
    const issues = issuesOf(() =>
      normalizer.normalizeWire(
        {
          "filter[password][eq]": "x",
          sort: "-password",
          select: "password",
        },
        config,
      ),
    );
    expect(issues).toHaveLength(3);
  });

  it("honors the page strategy when configured", () => {
    const paged = resolveEntityConfig(userMetadata, { pagination: { strategy: "page" } }, undefined);
    const query = normalizer.normalizeWire({ "page[number]": "3", "page[size]": "10" }, paged);
    expect(query.pagination).toEqual({ limit: 10, offset: 20 });
  });

  it("honors pagination.count=false", () => {
    const uncounted = resolveEntityConfig(userMetadata, { pagination: { count: false } }, undefined);
    expect(normalizer.normalizeWire({}, uncounted).count).toBe(false);
  });

  it("serves the whole match set under strategy 'none', ignoring configured defaultLimit/maxLimit", () => {
    const unpaginated = resolveEntityConfig(userMetadata, { pagination: { strategy: "none" } }, undefined);
    const query = normalizer.normalizeWire({}, unpaginated);
    expect(query.pagination).toEqual({ limit: NONE_PAGINATION_LIMIT, offset: 0 });
  });

  it("rejects an explicit limit/offset under strategy 'none' instead of silently narrowing", () => {
    const unpaginated = resolveEntityConfig(userMetadata, { pagination: { strategy: "none" } }, undefined);
    const limitIssues = issuesOf(() => normalizer.normalizeWire({ limit: "5" }, unpaginated));
    expect(limitIssues).toEqual([expect.objectContaining({ field: "limit", code: "KAVO_QUERY_UNSUPPORTED_PARAM" })]);
    const offsetIssues = issuesOf(() => normalizer.normalizeWire({ offset: "5" }, unpaginated));
    expect(offsetIssues).toEqual([expect.objectContaining({ field: "offset", code: "KAVO_QUERY_UNSUPPORTED_PARAM" })]);
  });

  it("collects both limit and offset into one exception under strategy 'none', not one round trip each", () => {
    const unpaginated = resolveEntityConfig(userMetadata, { pagination: { strategy: "none" } }, undefined);
    const issues = issuesOf(() => normalizer.normalizeWire({ limit: "5", offset: "10" }, unpaginated));
    expect(issues).toEqual([
      expect.objectContaining({ field: "limit", code: "KAVO_QUERY_UNSUPPORTED_PARAM" }),
      expect.objectContaining({ field: "offset", code: "KAVO_QUERY_UNSUPPORTED_PARAM" }),
    ]);
  });

  it("falls back to the configured defaults.sort when the client supplies no sort", () => {
    const defaulted = resolveEntityConfig(userMetadata, { sort: { default: ["-createdAt"] } }, undefined);
    expect(normalizer.normalizeWire({}, defaulted).sort).toEqual([{ field: "createdAt", direction: "desc" }]);
  });

  it("applies a multi-field defaults.sort in priority order", () => {
    const defaulted = resolveEntityConfig(
      userMetadata,
      {
        sort: { default: ["-createdAt", "id"] },
      },
      undefined,
    );
    expect(normalizer.normalizeWire({}, defaulted).sort).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "id", direction: "asc" },
    ]);
  });

  it("lets a client-supplied sort override the configured defaults.sort outright", () => {
    const defaulted = resolveEntityConfig(userMetadata, { sort: { default: ["-createdAt"] } }, undefined);
    expect(normalizer.normalizeWire({ sort: "name" }, defaulted).sort).toEqual([{ field: "name", direction: "asc" }]);
  });
});

describe("QueryNormalizer — search[...]", () => {
  const searchEnabled = resolveEntityConfig(userMetadata, { search: {} }, undefined);

  it("rejects search[query] when search is false (the default)", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ "search[query]": "ada" }, config));
    expect(issues[0]).toMatchObject({ field: "search[query]", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });

  it("rejects search[query] when searchable resolves empty (explicit searchable: [])", () => {
    const emptySearchable = resolveEntityConfig(userMetadata, { search: { fields: [] } }, undefined);
    const issues = issuesOf(() => normalizer.normalizeWire({ "search[query]": "ada" }, emptySearchable));
    expect(issues[0]).toMatchObject({ field: "search[query]", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });

  it("synthesizes an OR group of ILIKE conditions across the searchable allowlist (substring, default)", () => {
    const query = normalizer.normalizeWire({ "search[query]": "ada" }, searchEnabled);
    expect(query.filter.root).toEqual({
      kind: "group",
      operator: "OR",
      children: [
        { kind: "condition", field: "name", operator: "ILIKE", value: "%ada%" },
        { kind: "condition", field: "email", operator: "ILIKE", value: "%ada%" },
      ],
    });
  });

  it("splits on whitespace and ANDs one OR group per word in words mode", () => {
    const query = normalizer.normalizeWire({ "search[query]": "blue iphone", "search[mode]": "words" }, searchEnabled);
    expect(query.filter.root).toEqual({
      kind: "group",
      operator: "AND",
      children: [
        {
          kind: "group",
          operator: "OR",
          children: [
            { kind: "condition", field: "name", operator: "ILIKE", value: "%blue%" },
            { kind: "condition", field: "email", operator: "ILIKE", value: "%blue%" },
          ],
        },
        {
          kind: "group",
          operator: "OR",
          children: [
            { kind: "condition", field: "name", operator: "ILIKE", value: "%iphone%" },
            { kind: "condition", field: "email", operator: "ILIKE", value: "%iphone%" },
          ],
        },
      ],
    });
  });

  it("narrows to search[fields], a subset of the searchable allowlist", () => {
    const query = normalizer.normalizeWire({ "search[query]": "ada", "search[fields]": "name" }, searchEnabled);
    expect(query.filter.root).toEqual({ kind: "condition", field: "name", operator: "ILIKE", value: "%ada%" });
  });

  it("rejects a search[fields] entry outside the searchable allowlist", () => {
    const issues = issuesOf(() =>
      normalizer.normalizeWire({ "search[query]": "ada", "search[fields]": "name,age" }, searchEnabled),
    );
    expect(issues[0]).toMatchObject({ field: "age", code: "KAVO_QUERY_INVALID_FIELD" });
  });

  it("rejects an invalid search[mode] value", () => {
    const issues = issuesOf(() =>
      normalizer.normalizeWire({ "search[query]": "ada", "search[mode]": "fuzzy" }, searchEnabled),
    );
    expect(issues[0]).toMatchObject({ field: "search[mode]", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("rejects search[mode] without search[query]", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ "search[mode]": "words" }, searchEnabled));
    expect(issues[0]).toMatchObject({ field: "search", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
  });

  it("rejects search[fields] without search[query]", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ "search[fields]": "name" }, searchEnabled));
    expect(issues[0]).toMatchObject({ field: "search", code: "KAVO_QUERY_CONFLICTING_PARAMS" });
  });

  it("escapes a literal '%' and '_' in the search term rather than treating them as wildcards", () => {
    const query = normalizer.normalizeWire({ "search[query]": "50%_off", "search[fields]": "name" }, searchEnabled);
    expect(query.filter.root).toMatchObject({ operator: "ILIKE", value: "%50\\%\\_off%" });
  });

  it("caps the number of words in words mode at filter.limits.maxInValues", () => {
    const tightCap = resolveEntityConfig(
      userMetadata,
      { search: {}, filter: { limits: { maxInValues: 2 } } },
      undefined,
    );
    const issues = issuesOf(() =>
      normalizer.normalizeWire({ "search[query]": "a b c", "search[mode]": "words" }, tightCap),
    );
    expect(issues[0]).toMatchObject({ field: "search[query]", code: "KAVO_QUERY_LIMIT_EXCEEDED" });
  });

  it("caps the *product* of word count and searched-field count, not just word count alone", () => {
    // `userMetadata` has two searchable fields by default (name, email).
    // Two words × two fields = 4 synthesized conditions — over a cap of 3 —
    // even though the word count alone (2) is under it. A cap that only
    // checked `terms.length` would let this through.
    const tightCap = resolveEntityConfig(
      userMetadata,
      { search: {}, filter: { limits: { maxInValues: 3 } } },
      undefined,
    );
    const issues = issuesOf(() =>
      normalizer.normalizeWire({ "search[query]": "blue iphone", "search[mode]": "words" }, tightCap),
    );
    expect(issues[0]).toMatchObject({ field: "search[query]", code: "KAVO_QUERY_LIMIT_EXCEEDED" });
  });

  it("lets the same product through once search[fields] narrows it under the cap", () => {
    const tightCap = resolveEntityConfig(
      userMetadata,
      { search: {}, filter: { limits: { maxInValues: 3 } } },
      undefined,
    );
    // Same two words, narrowed to one field: 2 × 1 = 2, under the cap of 3.
    const query = normalizer.normalizeWire(
      { "search[query]": "blue iphone", "search[mode]": "words", "search[fields]": "name" },
      tightCap,
    );
    expect(query.filter.root).toMatchObject({ kind: "group", operator: "AND" });
  });

  it("still 400s on an unrelated filter issue without also raising a spurious search issue", () => {
    const issues = issuesOf(() =>
      normalizer.normalizeWire({ "filter[nope][eq]": "1", "search[query]": "ada" }, searchEnabled),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: "nope", code: "KAVO_QUERY_INVALID_FIELD" });
  });

  it("ANDs the synthesized search fragment with an existing filter[...] condition", () => {
    const query = normalizer.normalizeWire(
      { "search[query]": "ada", "search[fields]": "name", "filter[age][gte]": "18" },
      searchEnabled,
    );
    expect(query.filter.root).toEqual({
      kind: "group",
      operator: "AND",
      children: [
        { kind: "condition", field: "age", operator: "GTE", value: 18 },
        { kind: "condition", field: "name", operator: "ILIKE", value: "%ada%" },
      ],
    });
  });

  it("rejects search[query] arriving as a repeated-key array rather than a scalar", () => {
    // The wire binding flattens a repeated `?search[query]=a&search[query]=b`
    // into an array before the normalizer ever sees it (the same shape a
    // repeated `limit=` arrives as) — this must reject it, not stringify or
    // silently take the first value.
    const issues = issuesOf(() => normalizer.normalizeWire({ "search[query]": ["a", "b"] }, searchEnabled));
    expect(issues[0]).toMatchObject({ field: "search[query]", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("rejects search[fields] arriving as a non-string value", () => {
    const issues = issuesOf(() =>
      normalizer.normalizeWire({ "search[query]": "ada", "search[fields]": ["name"] }, searchEnabled),
    );
    expect(issues[0]).toMatchObject({ field: "search[fields]", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("synthesizes a relation-path ILIKE condition when searchable names one", () => {
    const relationSearchable = resolveEntityConfig(
      authorMetadata,
      { search: { fields: ["name", "posts.title" as never] } },
      undefined,
    );
    const authorNormalizer = new QueryNormalizer(authorMetadata);
    const query = authorNormalizer.normalizeWire({ "search[query]": "ada" }, relationSearchable);
    expect(query.filter.root).toEqual({
      kind: "group",
      operator: "OR",
      children: [
        { kind: "condition", field: "name", operator: "ILIKE", value: "%ada%" },
        { kind: "condition", field: "posts.title", operator: "ILIKE", value: "%ada%" },
      ],
    });
  });

  it("searches a field excluded from filterable — searchable is an independent allowlist", () => {
    const independent = resolveEntityConfig(
      userMetadata,
      { filter: { fields: [] }, search: { fields: ["name"] } },
      undefined,
    );
    const query = normalizer.normalizeWire({ "search[query]": "ada" }, independent);
    expect(query.filter.root).toEqual({ kind: "condition", field: "name", operator: "ILIKE", value: "%ada%" });
  });

  // `search` (issue #386) is entity-scope-only — a structural field-group
  // block, resolved directly from `EntityConfig`, not part of `KavoSettings`
  // — so there is no global default and no per-operation override to test
  // here, unlike the old top-level `KavoSettings.search`.
  it("backfills mode/driver when only one is named", () => {
    const config = resolveEntityConfig(userMetadata, { search: { mode: "words" } }, undefined);
    expect(config.search).toEqual({ fields: ["name", "email"], default: null, mode: "words", driver: "orm" });
  });
});

describe("QueryNormalizer — onlyDeleted", () => {
  it("rejects onlyDeleted=true when the entity is not soft-deletable (wire)", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ onlyDeleted: "true" }, config));
    expect(issues[0]).toMatchObject({ field: "onlyDeleted", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });

  it("rejects onlyDeleted=true when the entity is not soft-deletable (programmatic)", () => {
    const issues = issuesOf(() => normalizer.normalizeInput({ onlyDeleted: true }, config));
    expect(issues[0]).toMatchObject({ field: "onlyDeleted", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });

  it("accepts onlyDeleted=true on a soft-deletable entity (wire)", () => {
    const query = softDeletableNormalizer.normalizeWire({ onlyDeleted: "true" }, softDeletableConfig);
    expect(query.onlyDeleted).toBe(true);
    expect(query.withDeleted).toBe(false);
  });

  it("accepts onlyDeleted=true on a soft-deletable entity (programmatic)", () => {
    const query = softDeletableNormalizer.normalizeInput({ onlyDeleted: true }, softDeletableConfig);
    expect(query.onlyDeleted).toBe(true);
    expect(query.withDeleted).toBe(false);
  });

  it("rejects withDeleted and onlyDeleted set together (wire)", () => {
    const issues = issuesOf(() =>
      softDeletableNormalizer.normalizeWire({ withDeleted: "true", onlyDeleted: "true" }, softDeletableConfig),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ field: "onlyDeleted", code: "KAVO_QUERY_CONFLICTING_PARAMS" }),
    );
  });

  it("rejects withDeleted and onlyDeleted set together (programmatic)", () => {
    const issues = issuesOf(() =>
      softDeletableNormalizer.normalizeInput({ withDeleted: true, onlyDeleted: true }, softDeletableConfig),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ field: "onlyDeleted", code: "KAVO_QUERY_CONFLICTING_PARAMS" }),
    );
  });

  it("rejects a non-boolean onlyDeleted value", () => {
    const issues = issuesOf(() => softDeletableNormalizer.normalizeWire({ onlyDeleted: "yes" }, softDeletableConfig));
    expect(issues[0]).toMatchObject({ field: "onlyDeleted", code: "KAVO_QUERY_INVALID_VALUE" });
  });
});

/**
 * Every feature below is individually covered above; what these pin down is
 * that they compose. Each section of the pipeline writes into one shared
 * issue list and one shared result, so a regression that lets one section
 * clobber another's output — or short-circuit the sections after it — is
 * invisible to any single-feature test.
 */
describe("QueryNormalizer — the whole grammar in one request", () => {
  const wire = {
    "filter[title][like]": "%draft%",
    "filter[authorId][eq]": "7",
    sort: "-id,title",
    limit: "5",
    offset: "10",
    select: "id,title",
    "select[comments]": "id,body",
    include: "comments",
    onlyDeleted: "true",
  };

  it("normalizes filter, sort, pagination, fields, include and onlyDeleted together", () => {
    const query = postNormalizer.normalizeWire(wire, postConfig);

    expect(query.filter.root).toMatchObject({
      kind: "group",
      operator: "AND",
      children: [
        { field: "title", operator: "LIKE", value: "%draft%" },
        { field: "authorId", operator: "EQ", value: 7 },
      ],
    });
    expect(query.sort).toEqual([
      { field: "id", direction: "desc" },
      { field: "title", direction: "asc" },
    ]);
    expect(query.pagination).toEqual({ limit: 5, offset: 10 });
    expect(query.select).toEqual({ root: ["id", "title"], relations: { comments: ["id", "body"] } });
    expect(query.onlyDeleted).toBe(true);
    expect(query.withDeleted).toBe(false);
    expect(query.count).toBe(true);
  });

  it("resolves the include tree in the same pass, fieldset attached", () => {
    const query = postNormalizer.normalizeWire(wire, postConfig);
    expect(Object.keys(query.include)).toEqual(["comments"]);
    expect(query.include["comments"]).toMatchObject({
      path: "comments",
      fields: ["id", "body"],
      strategy: "batch",
    });
  });

  it("still collects issues from every section when they are combined", () => {
    // Distinct bad names per section on purpose: with one shared name the
    // three `KAVO_QUERY_INVALID_FIELD` issues are indistinguishable, so a
    // regression where one section double-reported while another stopped
    // reporting would produce the same multiset and pass.
    const issues = issuesOf(() =>
      postNormalizer.normalizeWire(
        { ...wire, "filter[secretA][eq]": "x", sort: "-secretB", select: "secretC", limit: "abc" },
        postConfig,
      ),
    );
    expect(issues).toEqual([
      expect.objectContaining({ field: "secretA", code: "KAVO_QUERY_INVALID_FIELD" }),
      expect.objectContaining({ field: "secretB", code: "KAVO_QUERY_INVALID_FIELD" }),
      expect.objectContaining({ field: "secretC", code: "KAVO_QUERY_INVALID_FIELD" }),
      expect.objectContaining({ field: "limit", code: "KAVO_QUERY_INVALID_VALUE" }),
    ]);
  });
});

/**
 * A trash view is still a read: narrowing the root to soft-deleted rows must
 * not change what `include=` resolves to. The flags and the include resolver
 * are separate branches of `normalizeWire`, and the include branch runs
 * before pagination — so a flag that short-circuited would silently strip
 * relations from exactly the view that needs them most.
 */
describe("QueryNormalizer — include under the soft-delete flags", () => {
  it("resolves the same include tree for a live, withDeleted, and onlyDeleted read", () => {
    const live = postNormalizer.normalizeWire({ include: "comments" }, postConfig);
    const withDeleted = postNormalizer.normalizeWire({ include: "comments", withDeleted: "true" }, postConfig);
    const onlyDeleted = postNormalizer.normalizeWire({ include: "comments", onlyDeleted: "true" }, postConfig);

    expect(Object.keys(live.include)).toEqual(["comments"]);
    expect(withDeleted.include).toEqual(live.include);
    expect(onlyDeleted.include).toEqual(live.include);
    expect([live.withDeleted, live.onlyDeleted]).toEqual([false, false]);
    expect([withDeleted.withDeleted, withDeleted.onlyDeleted]).toEqual([true, false]);
    expect([onlyDeleted.withDeleted, onlyDeleted.onlyDeleted]).toEqual([false, true]);
  });

  it("reports the include failure and the flag conflict in one exception", () => {
    const issues = issuesOf(() =>
      postNormalizer.normalizeWire({ include: "ghosts", withDeleted: "true", onlyDeleted: "true" }, postConfig),
    );
    expect(issues).toContainEqual(expect.objectContaining({ field: "ghosts", code: "KAVO_QUERY_INVALID_FIELD" }));
    expect(issues).toContainEqual(
      expect.objectContaining({ field: "onlyDeleted", code: "KAVO_QUERY_CONFLICTING_PARAMS" }),
    );
  });
});

describe("QueryNormalizer — programmatic input", () => {
  it("normalizes typed QueryContext input without coercion", () => {
    const query = normalizer.normalizeInput(
      {
        filter: { kind: "condition", field: "age", operator: "GTE", value: 18 },
        sort: [{ field: "name", direction: "asc" }],
        limit: 5,
      },
      config,
    );
    expect(query.filter.root).toMatchObject({ value: 18 });
    expect(query.pagination).toEqual({ limit: 5, offset: 0 });
  });

  it("issues no sort at all when neither the caller nor config supplies one", () => {
    expect(normalizer.normalizeInput({}, config).sort).toEqual([]);
  });

  it("enforces allowlists identically to the wire path", () => {
    const issues = issuesOf(() =>
      normalizer.normalizeInput(
        {
          filter: {
            kind: "condition",
            // Runtime strings can defeat FieldPath typing; the allowlist
            // must still hold.
            field: "password" as never,
            operator: "EQ",
            value: "x",
          },
        },
        config,
      ),
    );
    expect(issues[0]?.code).toBe("KAVO_QUERY_INVALID_FIELD");
  });

  it("falls back to the configured defaults.sort when no sort is given", () => {
    const defaulted = resolveEntityConfig(userMetadata, { sort: { default: ["-createdAt"] } }, undefined);
    expect(normalizer.normalizeInput({}, defaulted).sort).toEqual([{ field: "createdAt", direction: "desc" }]);
  });

  it("lets a caller-supplied sort override the configured defaults.sort outright", () => {
    const defaulted = resolveEntityConfig(userMetadata, { sort: { default: ["-createdAt"] } }, undefined);
    const query = normalizer.normalizeInput({ sort: [{ field: "name", direction: "asc" }] }, defaulted);
    expect(query.sort).toEqual([{ field: "name", direction: "asc" }]);
  });

  it("serves the whole match set under strategy 'none', the same as the wire path", () => {
    const unpaginated = resolveEntityConfig(userMetadata, { pagination: { strategy: "none" } }, undefined);
    const query = normalizer.normalizeInput({}, unpaginated);
    expect(query.pagination).toEqual({ limit: NONE_PAGINATION_LIMIT, offset: 0 });
  });

  it("rejects an explicit limit/offset under strategy 'none' rather than silently clamping it", () => {
    const unpaginated = resolveEntityConfig(userMetadata, { pagination: { strategy: "none" } }, undefined);
    const limitIssues = issuesOf(() => normalizer.normalizeInput({ limit: 5 }, unpaginated));
    expect(limitIssues).toEqual([expect.objectContaining({ field: "limit", code: "KAVO_QUERY_UNSUPPORTED_PARAM" })]);
    const offsetIssues = issuesOf(() => normalizer.normalizeInput({ offset: 5 }, unpaginated));
    expect(offsetIssues).toEqual([expect.objectContaining({ field: "offset", code: "KAVO_QUERY_UNSUPPORTED_PARAM" })]);
  });

  it("collects both limit and offset into one exception under strategy 'none', not one round trip each", () => {
    const unpaginated = resolveEntityConfig(userMetadata, { pagination: { strategy: "none" } }, undefined);
    const issues = issuesOf(() => normalizer.normalizeInput({ limit: 5, offset: 10 }, unpaginated));
    expect(issues).toEqual([
      expect.objectContaining({ field: "limit", code: "KAVO_QUERY_UNSUPPORTED_PARAM" }),
      expect.objectContaining({ field: "offset", code: "KAVO_QUERY_UNSUPPORTED_PARAM" }),
    ]);
  });
});

/**
 * `FieldSelectionInput` accepts three spellings so programmatic callers can
 * write what the wire format looks like. They are sugar and nothing more:
 * each must collapse to the *same* `NormalizedQueryContext` before the
 * engine or any adapter sees it, and each must face the same validation.
 */
describe("QueryNormalizer — the three select spellings", () => {
  it("collapses root-only sugar and the structured form to one selection", () => {
    const sugar = normalizer.normalizeInput({ select: ["id", "name"] }, config);
    const structured = normalizer.normalizeInput({ select: { root: ["id", "name"] } }, config);

    expect(sugar.select).toEqual({ root: ["id", "name"], relations: {} });
    expect(sugar).toEqual(structured);
  });

  it("treats an omitted and an empty selection alike", () => {
    const omitted = normalizer.normalizeInput({}, config);
    expect(omitted.select).toEqual({ root: null, relations: {} });
    expect(normalizer.normalizeInput({ select: {} }, config)).toEqual(omitted);
  });

  it("reads a relation-keyed selection as relations, not as root fields", () => {
    // No include resolver here, so a relation fieldset is *unsupported* —
    // which is exactly the tell that `{ posts: [...] }` was routed to
    // `relations` rather than misread as a root field list.
    const relationKeyed = issuesOf(() => normalizer.normalizeInput({ select: { posts: ["title"] } }, config));
    const structured = issuesOf(() =>
      normalizer.normalizeInput({ select: { relations: { posts: ["title"] } } }, config),
    );

    expect(relationKeyed).toEqual(structured);
    expect(relationKeyed[0]).toMatchObject({
      field: "include",
      code: "KAVO_QUERY_UNSUPPORTED_PARAM",
    });
  });

  it("rejects a non-allowlisted root field in either root spelling", () => {
    for (const fields of [["password"], { root: ["password"] }] as const) {
      const issues = issuesOf(() => normalizer.normalizeInput({ select: fields } as never, config));
      expect(issues[0]).toMatchObject({
        field: "password",
        code: "KAVO_QUERY_INVALID_FIELD",
      });
    }
  });

  // Runtime strings can defeat every one of these; the type system is not
  // the only gate, and a malformed `select` value must never throw — that
  // would surface as a 500, not a 400.
  it("reports a non-object select value as a query issue rather than throwing", () => {
    for (const bad of [null, "id,name", 42, true]) {
      const issues = issuesOf(() => normalizer.normalizeInput({ select: bad } as never, config));
      expect(issues[0]).toMatchObject({
        field: "select",
        code: "KAVO_QUERY_INVALID_VALUE",
      });
    }
  });

  it("rejects mixing the structured and relation-keyed spellings rather than dropping the relation fieldset", () => {
    const issues = issuesOf(() =>
      normalizer.normalizeInput({ select: { root: ["id"], posts: ["title"] } } as never, config),
    );
    expect(issues[0]).toMatchObject({
      field: "select.posts",
      code: "KAVO_QUERY_INVALID_VALUE",
    });
  });
});

/**
 * Issue #7: an allowlist rejection named what was refused and stopped
 * there, leaving the developer to guess which config key would permit it.
 * The leading sentence is unchanged; everything actionable is appended, so
 * these assert the appended clause and never the whole string.
 */
describe("allowlist rejection messages", () => {
  it("names the near miss, the permitted set, and the config key for a filter field", () => {
    const detail = issuesOf(() => normalizer.normalizeWire({ "filter[emial][eq]": "a" }, config))[0]!.detail;
    expect(detail).toContain("Field 'emial' cannot be used for filtering.");
    expect(detail).toContain("Did you mean 'email'?");
    expect(detail).toContain("Filterable fields on User:");
    expect(detail).toContain("add it to filter.fields on the User config to permit it.");
  });

  it("stops appending the hint once a request is past a handful of problems", () => {
    // `?select=a1,…,a5000` is a legal query string, and the hint is not
    // free: it walks the whole allowlist per rejected name and adds a few
    // hundred bytes per issue. Uncapped, one request becomes a megabyte of
    // prose and an O(names × allowlist) sweep. The leading sentence — the
    // part that says what was refused — is never dropped.
    const many = Array.from({ length: 200 }, (_unused, index) => `bad${index}`).join(",");
    const issues = issuesOf(() => normalizer.normalizeWire({ select: many }, config));
    expect(issues).toHaveLength(200);
    expect(issues.every((issue) => issue.detail.includes("cannot be used for selection"))).toBe(true);
    expect(issues.filter((issue) => issue.detail.includes("select.fields"))).toHaveLength(5);
    expect(issues[199]!.detail).toBe("Field 'bad199' cannot be used for selection.");
  });

  it("names sort.fields for a sort field", () => {
    const detail = issuesOf(() => normalizer.normalizeWire({ sort: "-emial" }, config))[0]!.detail;
    expect(detail).toContain("Did you mean 'email'?");
    expect(detail).toContain("sort.fields on the User config");
  });

  it("names select.fields for a selected field", () => {
    const detail = issuesOf(() => normalizer.normalizeWire({ select: "emial" }, config))[0]!.detail;
    expect(detail).toContain("Did you mean 'email'?");
    expect(detail).toContain("select.fields on the User config");
  });

  it("names the same key for a programmatic filter expression", () => {
    const detail = issuesOf(() =>
      normalizer.normalizeInput(
        { filter: { kind: "condition", field: "emial", operator: "EQ", value: "a" } } as never,
        config,
      ),
    )[0]!.detail;
    expect(detail).toContain("Did you mean 'email'?");
    expect(detail).toContain("filter.fields on the User config");
  });

  it("says the same thing through the programmatic entry point", () => {
    // The two entry points share one gate, so the security posture and the
    // message quality cannot diverge between them.
    const wire = issuesOf(() => normalizer.normalizeWire({ sort: "emial" }, config))[0]!.detail;
    const programmatic = issuesOf(() =>
      normalizer.normalizeInput({ sort: [{ field: "emial", direction: "asc" }] } as never, config),
    )[0]!.detail;
    expect(programmatic).toBe(wire);
  });

  it("offers no suggestion when nothing is close, and still names the fix", () => {
    const detail = issuesOf(() => normalizer.normalizeWire({ sort: "passwordHash" }, config))[0]!.detail;
    expect(detail).not.toContain("Did you mean");
    expect(detail).toContain("sort.fields");
  });

  it("collects every rejection into one round trip", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: "emial", select: "nmae" }, config));
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.detail.includes("Did you mean"))).toBe(true);
  });
});

/**
 * The programmatic path does not run `DefaultFilterParser` or any
 * pagination strategy: its input is already typed, so there is nothing to
 * parse. That makes `normalizeInput` the *sole* gate for a hand-built
 * request, and every limit the wire path enforces has to be enforced here
 * independently. The wire equivalents of these live in
 * `filter-parser.spec.ts` and `pagination-strategies.spec.ts`, neither of
 * which this code path shares.
 */
describe("QueryNormalizer — programmatic input is bounded, not trusted", () => {
  it.each([
    ["a limit below one", { limit: 0 }, "limit"],
    ["a fractional limit", { limit: 1.5 }, "limit"],
    ["a negative offset", { offset: -1 }, "offset"],
    ["a fractional offset", { offset: 2.5 }, "offset"],
  ])("rejects %s, naming the parameter at fault", (_label, input, field) => {
    const issues = issuesOf(() => normalizer.normalizeInput(input as never, config));
    expect(issues[0]).toMatchObject({ field, code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("accepts the boundary values either side of those rejections", () => {
    expect(normalizer.normalizeInput({ limit: 1, offset: 0 }, config).pagination).toEqual({ limit: 1, offset: 0 });
  });

  it("enforces limits.filterDepth on a hand-built AST", () => {
    // Four levels of nesting against the default budget of three. Without
    // this gate a programmatic caller could hand the adapter an
    // arbitrarily deep tree that the wire path would have refused.
    const nest = (child: unknown) => ({ kind: "group", operator: "AND", children: [child] });
    const deep = nest(nest(nest({ kind: "condition", field: "age", operator: "EQ", value: 1 })));

    const issues = issuesOf(() => normalizer.normalizeInput({ filter: deep } as never, config));
    expect(issues[0]).toMatchObject({ field: "filter", code: "KAVO_QUERY_LIMIT_EXCEEDED" });
  });

  it("enforces limits.inValues on a hand-built IN condition, naming the field and operator", () => {
    const issues = issuesOf(() =>
      normalizer.normalizeInput(
        {
          filter: {
            kind: "condition",
            field: "age",
            operator: "IN",
            value: Array.from({ length: 101 }, (_unused, index) => index),
          },
        } as never,
        config,
      ),
    );
    expect(issues[0]).toMatchObject({ field: "age", code: "KAVO_QUERY_LIMIT_EXCEEDED" });
    expect(issues[0]?.detail).toContain("IN");
  });

  it.each(["LIKE", "ILIKE"])(
    "enforces limits.likePattern on a hand-built %s condition (issue #367 finding 4)",
    (operator) => {
      // The wire path's own `limits.likePattern` cap only runs inside
      // `DefaultFilterParser`, which a programmatic `QueryContext` caller
      // never goes through — without this gate here too, that caller could
      // hand the adapter a pattern long enough to force an expensive scan
      // that the wire path would have refused.
      const issues = issuesOf(() =>
        normalizer.normalizeInput(
          {
            filter: {
              kind: "condition",
              field: "name",
              operator,
              value: `%${"a".repeat(201)}%`,
            },
          } as never,
          config,
        ),
      );
      expect(issues[0]).toMatchObject({ field: "name", code: "KAVO_QUERY_LIMIT_EXCEEDED" });
    },
  );

  it("accepts a hand-built LIKE condition at exactly limits.likePattern", () => {
    const pattern = "a".repeat(200);
    expect(() =>
      normalizer.normalizeInput(
        { filter: { kind: "condition", field: "name", operator: "LIKE", value: pattern } } as never,
        config,
      ),
    ).not.toThrow();
  });

  it("accepts an IN list exactly at the budget", () => {
    const query = normalizer.normalizeInput(
      {
        filter: {
          kind: "condition",
          field: "age",
          operator: "IN",
          value: Array.from({ length: 100 }, (_unused, index) => index),
        },
      } as never,
      config,
    );
    expect(query.filter.root).toMatchObject({ operator: "IN" });
  });
});

/**
 * `pagination.strategy` is validated as a *string* at bootstrap, never
 * probed against the registry, so a typo survives `createCrud` and
 * surfaces on the first request instead. That is a deliberate trade (the
 * registry is per-normalizer, the config is not), which makes the failure
 * mode worth pinning: a `ConfigurationException` naming both the typo and
 * the registered alternatives, not a `TypeError` on `undefined`.
 */
describe("QueryNormalizer — an unregistered pagination strategy", () => {
  const typoed = resolveEntityConfig(userMetadata, { pagination: { strategy: "ofset" } } as never, undefined);

  it("throws ConfigurationException rather than collecting a query issue", () => {
    expect(() => normalizer.normalizeWire({}, typoed)).toThrow(ConfigurationException);
  });

  it("names the unknown strategy and lists the registered ones", () => {
    let message = "";
    try {
      normalizer.normalizeWire({}, typoed);
    } catch (thrown) {
      message = (thrown as Error).message;
    }
    expect(message).toContain("'ofset'");
    expect(message).toMatch(/offset/);
    expect(message).toMatch(/cursor/);
    expect(message).toMatch(/since/);
  });

  it("propagates out of the programmatic path too", () => {
    // `collectIssues` re-throws anything that is not a
    // `QueryValidationException`, so a misconfiguration surfaces as a 500
    // rather than being flattened into a 400 the client cannot act on.
    expect(() => normalizer.normalizeInput({}, typoed)).toThrow(ConfigurationException);
  });
});

/**
 * A third-party strategy decides the *shape* the programmatic path
 * normalizes to, which `paginationShape` discovers by probing it with an
 * empty request. Both arms of that probe's catch matter: a strategy that
 * rejects an empty request pages as offset (its real issues surface on the
 * wire, where its params exist), while anything else is a bug and must not
 * be swallowed.
 */
describe("QueryNormalizer — probing a custom pagination strategy", () => {
  class RejectsEmpty {
    readonly name = "demanding";
    normalize() {
      throw new QueryValidationException([
        { field: "token", code: "KAVO_QUERY_INVALID_VALUE", detail: "token is required" },
      ]);
    }
  }

  class ThrowsOutright {
    readonly name = "broken";
    normalize(): never {
      throw new Error("boom");
    }
  }

  it("treats a strategy that refuses an empty request as offset-shaped", () => {
    const normalizerWith = new QueryNormalizer(userMetadata, [new RejectsEmpty() as never]);
    const demanding = resolveEntityConfig(userMetadata, { pagination: { strategy: "demanding" } } as never, undefined);

    expect(normalizerWith.normalizeInput({}, demanding).pagination).toEqual({ limit: 20, offset: 0 });
  });

  it("rejects a programmatic cursor against that offset shape rather than paging silently", () => {
    const normalizerWith = new QueryNormalizer(userMetadata, [new RejectsEmpty() as never]);
    const demanding = resolveEntityConfig(userMetadata, { pagination: { strategy: "demanding" } } as never, undefined);

    const issues = issuesOf(() => normalizerWith.normalizeInput({ cursor: "abc" } as never, demanding));
    expect(issues[0]).toMatchObject({ field: "cursor", code: "KAVO_QUERY_UNSUPPORTED_PARAM" });
  });

  it("lets a non-validation throw escape, so a broken strategy is not mistaken for offset paging", () => {
    const normalizerWith = new QueryNormalizer(userMetadata, [new ThrowsOutright() as never]);
    const broken = resolveEntityConfig(userMetadata, { pagination: { strategy: "broken" } } as never, undefined);

    expect(() => normalizerWith.normalizeInput({}, broken)).toThrow(/boom/);
  });
});

/**
 * A query string can spell the same parameter twice (`?sort=a&sort=b`),
 * which every mainstream parser hands over as an array rather than a
 * string. None of these are reachable from the programmatic path, which
 * reads its input already typed, so the wire path owns the whole burden of
 * not trusting the shape it is given.
 */
describe("QueryNormalizer — repeated-key and malformed wire spellings", () => {
  it("accepts the repeated-key array form of include", () => {
    const query = postNormalizer.normalizeWire({ include: ["comments"] } as never, postConfig);
    expect(Object.keys(query.include)).toEqual(["comments"]);
  });

  it("reports a non-string include token instead of throwing", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ include: 42 } as never, config));
    expect(issues[0]).toMatchObject({ field: "include", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("reports a repeated-key sort instead of throwing", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ sort: ["name", "email"] } as never, config));
    expect(issues[0]).toMatchObject({ field: "sort", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("skips an empty token inside sort rather than rejecting it as an empty field name", () => {
    const query = normalizer.normalizeWire({ sort: "name,,email" }, config);
    expect(query.sort).toEqual([
      { field: "name", direction: "asc" },
      { field: "email", direction: "asc" },
    ]);
  });

  it("reports a repeated-key root fields instead of throwing, and selects nothing", () => {
    const issues = issuesOf(() => normalizer.normalizeWire({ select: ["id", "name"] } as never, config));
    expect(issues[0]).toMatchObject({ field: "select", code: "KAVO_QUERY_INVALID_VALUE" });
  });

  it("skips an empty token inside fields", () => {
    const query = normalizer.normalizeWire({ select: "id,,name" }, config);
    expect(query.select.root).toEqual(["id", "name"]);
  });

  it("reports a non-string relation fieldset under its raw wire key", () => {
    // The key is echoed verbatim (`select[comments]`, not `comments`) so
    // the client can find the parameter it actually sent.
    const issues = issuesOf(() =>
      postNormalizer.normalizeWire({ include: "comments", "select[comments]": ["id"] } as never, postConfig),
    );
    expect(issues[0]).toMatchObject({ field: "select[comments]", code: "KAVO_QUERY_INVALID_VALUE" });
  });
});
