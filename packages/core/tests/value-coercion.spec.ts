import { describe, expect, it } from "vitest";
import type { FieldKind, FieldMetadata, IncludeRequest, IncludeResolver, IncludeTree } from "@kavo/core";
import { QueryNormalizer, parseBracketKey, resolveEntityConfig } from "@kavo/core";
// `coerceScalar`/`isIssue` are internal to the query pipeline and not on the
// public barrel (ADR-0010), so the unit test reaches into its own package's
// source — the one place that import is legal.
import { coerceScalar, isIssue } from "../src/query/value-coercion.js";
import type { QueryIssueDto } from "../src/errors/problem-details.js";
import type { User } from "./support/user-fixture.js";
import { userMetadata } from "./support/user-fixture.js";

function column(kind: FieldKind, extra: Partial<FieldMetadata> = {}): FieldMetadata {
  return { name: "probe", kind, nullable: false, generated: false, ...extra };
}

function coerce(kind: FieldKind, raw: unknown, extra: Partial<FieldMetadata> = {}) {
  return coerceScalar(raw, "probe", column(kind, extra));
}

/**
 * Narrow to the failure branch, throwing when coercion unexpectedly
 * succeeded — a negative-path test must not pass vacuously.
 */
function issueOf(result: ReturnType<typeof coerceScalar>): QueryIssueDto {
  if (!isIssue(result)) {
    throw new Error(`expected a query issue, got ${String(result)}`);
  }
  return result;
}

describe("coerceScalar — locale-independent wire coercion", () => {
  it("returns string columns as text, stringifying non-string wire values", () => {
    expect(coerce("string", "john")).toBe("john");
    expect(coerce("string", 42)).toBe("42");
  });

  it("coerces JavaScript number syntax, integral and fractional", () => {
    expect(coerce("number", "42")).toBe(42);
    expect(coerce("number", "-3.5")).toBe(-3.5);
  });

  it("rejects a non-numeric value rather than yielding NaN", () => {
    expect(issueOf(coerce("number", "abc")).code).toBe("KAVO_QUERY_INVALID_VALUE");
    expect(Number.isNaN(coerce("number", "abc") as number)).toBe(false);
  });

  it("rejects blank and locale-formatted numbers — no separators are honored", () => {
    for (const raw of ["", "   ", "1,5", "1 000"]) {
      expect(issueOf(coerce("number", raw)).code).toBe("KAVO_QUERY_INVALID_VALUE");
    }
  });

  it("accepts exactly true/false/1/0 for booleans", () => {
    expect(coerce("boolean", "true")).toBe(true);
    expect(coerce("boolean", "1")).toBe(true);
    expect(coerce("boolean", "false")).toBe(false);
    expect(coerce("boolean", "0")).toBe(false);
  });

  it("rejects any other boolean spelling, including case variants", () => {
    for (const raw of ["TRUE", "False", "yes", "on", ""]) {
      expect(issueOf(coerce("boolean", raw)).code).toBe("KAVO_QUERY_INVALID_VALUE");
    }
  });

  it("parses ISO 8601 dates and date-times to the same instant everywhere", () => {
    expect((coerce("date", "2026-01-01") as Date).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect((coerce("date", "2026-01-01T10:00:00Z") as Date).toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });

  it("rejects an unparseable date rather than yielding Invalid Date", () => {
    const result = coerce("date", "not-a-date");
    expect(issueOf(result).code).toBe("KAVO_QUERY_INVALID_VALUE");
    expect(result).not.toBeInstanceOf(Date);
  });

  it("accepts enum members by exact match only", () => {
    const members = { enumValues: ["active", "pending"] as const };
    expect(coerce("enum", "active", members)).toBe("active");
    expect(issueOf(coerce("enum", "Active", members)).code).toBe("KAVO_QUERY_INVALID_VALUE");
    expect(issueOf(coerce("enum", "vip", members)).code).toBe("KAVO_QUERY_INVALID_VALUE");
  });

  it("accepts nothing for an enum column that declares no members", () => {
    expect(issueOf(coerce("enum", "active")).code).toBe("KAVO_QUERY_INVALID_VALUE");
  });

  it("refuses to compare json columns at all", () => {
    expect(issueOf(coerce("json", "{}")).code).toBe("KAVO_QUERY_INVALID_VALUE");
  });

  it("coerces null and the literal 'null' to SQL NULL on a nullable column", () => {
    expect(coerce("string", null, { nullable: true })).toBeNull();
    expect(coerce("string", "null", { nullable: true })).toBeNull();
    expect(coerce("number", "null", { nullable: true })).toBeNull();
  });

  it("rejects null on a column that is not nullable", () => {
    expect(issueOf(coerce("string", null)).code).toBe("KAVO_QUERY_INVALID_VALUE");
    expect(issueOf(coerce("string", "null")).code).toBe("KAVO_QUERY_INVALID_VALUE");
  });

  it("passes a value with no column metadata through as a string", () => {
    // Relation paths have no entry in the root entity's column map; the
    // database compares them (doc 05 §5 records the open gap).
    expect(coerceScalar("Helsinki", "profile.city", undefined)).toBe("Helsinki");
    expect(coerceScalar(42, "profile.rating", undefined)).toBe("42");
  });

  it("reports failures as a field-level issue naming the field the caller passed", () => {
    const issue = issueOf(coerceScalar("abc", "age", column("number", { name: "age" })));
    expect(Object.keys(issue).sort()).toEqual(["code", "detail", "field"]);
    expect(issue.field).toBe("age");
    expect(issue.code).toBe("KAVO_QUERY_INVALID_VALUE");
  });
});

describe("isIssue — the parser's success/failure discriminator", () => {
  it("recognizes an issue object", () => {
    expect(isIssue({ field: "age", code: "KAVO_QUERY_INVALID_VALUE", detail: "…" })).toBe(true);
  });

  it("treats a coerced SQL NULL as a value, not a failure", () => {
    // The load-bearing case: `typeof null === "object"`, so a NULL that read
    // as an issue would turn every `filter[x][eq]=null` into a 400.
    expect(isIssue(coerce("string", null, { nullable: true }))).toBe(false);
  });

  it("treats every coerced scalar kind as a value", () => {
    for (const value of ["john", 42, true, new Date(0)] as const) {
      expect(isIssue(value)).toBe(false);
    }
  });
});

describe("parseBracketKey — bracketed wire keys", () => {
  it("splits a key into its path segments", () => {
    expect(parseBracketKey("filter[age][gte]", "filter")).toEqual(["age", "gte"]);
    expect(parseBracketKey("filter[or][0][role][eq]", "filter")).toEqual(["or", "0", "role", "eq"]);
    expect(parseBracketKey("fields[posts]", "fields")).toEqual(["posts"]);
  });

  it("keeps the empty tail of the repeated-key form", () => {
    expect(parseBracketKey("filter[status][in][]", "filter")).toEqual(["status", "in", ""]);
  });

  it("keeps a dotted relation path as one segment", () => {
    expect(parseBracketKey("filter[profile.city][eq]", "filter")).toEqual(["profile.city", "eq"]);
  });

  it("returns null for the bare prefix — callers handle that form themselves", () => {
    // `filter` alone is the JSON escape hatch; `fields` alone is the root
    // fieldset. Neither is a bracket path.
    expect(parseBracketKey("filter", "filter")).toBeNull();
    expect(parseBracketKey("fields", "fields")).toBeNull();
  });

  it("returns null for a key belonging to another parameter", () => {
    expect(parseBracketKey("fields[posts]", "filter")).toBeNull();
    expect(parseBracketKey("sort", "filter")).toBeNull();
    expect(parseBracketKey("filterish[age]", "filter")).toBeNull();
  });

  it("returns null for a malformed bracket sequence", () => {
    for (const key of ["filter[age", "filter[age][gte]x", "filter[a]]", "filter[a]b[c]"]) {
      expect(parseBracketKey(key, "filter")).toBeNull();
    }
  });
});

describe("FieldSelection — sparse fieldsets", () => {
  const config = resolveEntityConfig(userMetadata, undefined, undefined);

  /** Records what the normalizer hands relation resolution, nothing more. */
  class RecordingIncludeResolver implements IncludeResolver<User> {
    request: IncludeRequest | null = null;

    resolve(request: IncludeRequest): IncludeTree {
      this.request = request;
      return {};
    }
  }

  it("reports root: null when no fields param is sent — the DTO decides", () => {
    const query = new QueryNormalizer<User>(userMetadata).normalizeWire({}, config);
    expect(query.fields).toEqual({ root: null, relations: {} });
  });

  it("treats an empty fields value as absent, not as an empty selection", () => {
    const query = new QueryNormalizer<User>(userMetadata).normalizeWire({ fields: "" }, config);
    expect(query.fields.root).toBeNull();
  });

  it("narrows the root to the listed columns, in wire order", () => {
    const query = new QueryNormalizer<User>(userMetadata).normalizeWire({ fields: "name,id" }, config);
    expect(query.fields.root).toEqual(["name", "id"]);
  });

  it("keys relation fieldsets by the relation path as it appeared on the wire", () => {
    const resolver = new RecordingIncludeResolver();
    const normalizer = new QueryNormalizer<User>(userMetadata, [], resolver);
    normalizer.normalizeWire({ "fields[posts]": "id,title", "fields[posts.comments]": "body" }, config);
    expect(resolver.request?.fields).toEqual({ posts: ["id", "title"], "posts.comments": ["body"] });
  });
});
