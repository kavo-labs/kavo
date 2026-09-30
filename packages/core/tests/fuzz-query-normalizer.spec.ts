import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NormalizedQueryContext, ResolvedEntityConfig } from "@kavo/core";
import { QueryNormalizer, QueryValidationException, resolveEntityConfig } from "@kavo/core";
import type { User } from "./support/user-fixture.js";
import { userMetadata } from "./support/user-fixture.js";

/**
 * Property-based fuzzing of the wire grammar. Every other normalizer spec
 * asserts one crafted input; these assert invariants that must hold for
 * any input an attacker can put in a query string. `FC_SEED` pins the run
 * (CI sets it); without it every local run explores fresh inputs.
 */

const seed = process.env["FC_SEED"] === undefined ? undefined : Number(process.env["FC_SEED"]);
const runs = { numRuns: 2000, ...(seed === undefined ? {} : { seed }) };

const normalizer = new QueryNormalizer(userMetadata);

/**
 * Two configs: the derived default, where every field is allowed, and a
 * narrowed one, where the allowlist properties below actually exclude
 * something an attacker can name.
 */
const configs: ReadonlyArray<readonly [string, ResolvedEntityConfig<User>]> = [
  ["default config", resolveEntityConfig(userMetadata, undefined, undefined)],
  [
    "narrowed config",
    resolveEntityConfig(
      userMetadata,
      {
        filter: { fields: ["name", "age"] },
        sort: { fields: ["name"] },
        select: { fields: ["id", "name"] },
        pagination: { defaultLimit: 5, maxLimit: 10 },
        search: {},
      },
      undefined,
    ),
  ],
];

const hostileSegment = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom(
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "hasOwnProperty",
    "eq",
    "in",
    "like",
    "isNull",
    "$ne",
    "$where",
    "or",
    "and",
    "not",
    "..",
    "",
    "0",
    "-1",
    "email",
    "status",
    "createdAt",
    "id",
  ),
);
const head = fc.oneof(
  fc.constantFrom(
    "filter",
    "sort",
    "select",
    "fields",
    "include",
    "limit",
    "offset",
    "search",
    "cursor",
    "since",
    "count",
    "withDeleted",
    "onlyDeleted",
    "__proto__",
  ),
  fc.string({ maxLength: 8 }),
);
const wireKey = fc
  .tuple(head, fc.array(hostileSegment, { maxLength: 5 }))
  .map(([h, segments]) => h + segments.map((s) => `[${s}]`).join(""));
const numberish = fc.oneof(
  fc.integer().map(String),
  fc.double().map(String),
  fc.constantFrom("1e308", "-0", "0x10", "Infinity", "NaN", " 5", "5 ", "9007199254740993", "1_000"),
);
const wireScalar = fc.oneof(
  fc.string({ maxLength: 64 }),
  fc.json({ maxDepth: 6 }),
  numberish,
  fc.constantFrom("-name", "name,-age", "id,name,email", "true", "false", "", ",", "-", "--name"),
);
const wireValue = fc.oneof(wireScalar, fc.array(wireScalar, { maxLength: 5 }));
const randomParams = fc.dictionary(wireKey, wireValue, { maxKeys: 8 });

/**
 * Grammar-shaped params: real field names and operator tokens, nested under
 * `or`/`and`/`not`, with values that often parse. Purely random keys are
 * almost always rejected outright, which would leave the allowlist
 * properties below checking nothing.
 */
const fieldName = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("id", "name", "email", "age", "status", "createdAt") },
  fc.constantFrom("password", "__proto__", "constructor", "name.length", "author.name", ""),
);
const operator = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      "eq",
      "ne",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "notIn",
      "like",
      "ilike",
      "between",
      "isNull",
      "isNotNull",
    ),
  },
  fc.constantFrom("EQ", "$eq", "__proto__", "", "constructor"),
);
const logical = fc.array(
  fc.oneof(
    fc.tuple(fc.constantFrom("or", "and"), fc.nat({ max: 3 })).map(([op, i]) => `[${op}][${i}]`),
    fc.constant("[not]"),
  ),
  { maxLength: 2 },
);
const filterValue = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      "active",
      "banned",
      "ada",
      "%a%",
      "true",
      "false",
      "2026-01-01",
      "18,65",
      "1,2,3",
      "a,b",
    ),
  },
  numberish,
  fc.string({ maxLength: 16 }),
);
/** A condition whose operator and value suit the field's kind, so it usually parses. */
const word = fc.oneof(fc.constantFrom("ada", "%a%", "a_b", "\\%", "admin"), fc.string({ maxLength: 8 }));
const integer = fc.integer({ min: -1000, max: 1000 }).map(String);
const typedCondition = fc.oneof(
  fc.tuple(fc.constantFrom("name", "email"), fc.constantFrom("eq", "ne", "like", "ilike"), word),
  fc.tuple(
    fc.constantFrom("name", "email"),
    fc.constantFrom("in", "notIn"),
    fc.array(word, { minLength: 1, maxLength: 3 }).map((words) => words.join(",")),
  ),
  fc.tuple(fc.constantFrom("id", "age"), fc.constantFrom("eq", "ne", "gt", "gte", "lt", "lte"), integer),
  fc.tuple(
    fc.constantFrom("id", "age"),
    fc.constant("between"),
    fc.tuple(integer, integer).map(([a, b]) => `${a},${b}`),
  ),
  fc.tuple(
    fc.constant("status"),
    fc.constantFrom("eq", "ne", "in"),
    fc.constantFrom("active", "pending", "banned", "active,banned"),
  ),
  fc.tuple(
    fc.constant("createdAt"),
    fc.constantFrom("gt", "gte", "lt", "lte"),
    fc.constantFrom("2026-01-01", "2026-06-01T12:00:00Z", "1970-01-01"),
  ),
  fc.tuple(
    fc.constantFrom("id", "name", "email", "age", "status", "createdAt"),
    fc.constantFrom("isNull", "isNotNull"),
    fc.constantFrom("true", "false"),
  ),
);
const anyCondition = fc.tuple(fieldName, operator, fc.oneof(filterValue, fc.array(filterValue, { maxLength: 3 })));
const filterEntry = fc
  .tuple(logical, fc.oneof({ weight: 4, arbitrary: typedCondition }, anyCondition))
  .map(([prefix, [field, op, value]]) => [`filter${prefix.join("")}[${field}][${op}]`, value] as const);
const sortValue = fc
  .array(
    fc.tuple(fc.boolean(), fieldName).map(([desc, field]) => (desc ? `-${field}` : field)),
    {
      minLength: 1,
      maxLength: 3,
    },
  )
  .map((parts) => parts.join(","));
const grammarParams = fc
  .tuple(
    fc.array(filterEntry, { maxLength: 4 }),
    fc.option(sortValue, { nil: undefined }),
    fc.oneof({ weight: 3, arbitrary: fc.constant(undefined) }, fc.string({ maxLength: 12 })),
    fc.oneof({ weight: 3, arbitrary: fc.constant({}) }, randomParams),
  )
  .map(([filters, sort, search, noise]) => ({
    ...noise,
    ...Object.fromEntries(filters),
    ...(sort === undefined ? {} : { sort }),
    ...(search === undefined ? {} : { "search[query]": search }),
  }));
const wireParams = fc.oneof(randomParams, grammarParams);
/** `limit` on its own, so the clamp property is exercised on most runs rather than a few. */
const limitParams = fc
  .tuple(wireParams, fc.oneof(fc.nat().map(String), fc.integer().map(String), numberish, fc.string({ maxLength: 12 })))
  .map(([params, limit]) => ({ ...params, limit }));

function normalizeOrReject(
  params: Record<string, unknown>,
  config: ResolvedEntityConfig<User>,
): NormalizedQueryContext<User> | undefined {
  try {
    return normalizer.normalizeWire(params, config);
  } catch (error) {
    if (error instanceof QueryValidationException) {
      return undefined;
    }
    throw error;
  }
}

/** Every `field` on a `kind: "condition"` node, however deep. */
function conditionFields(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => conditionFields(child, out));
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record["kind"] === "condition" && typeof record["field"] === "string") {
      out.push(record["field"]);
    }
    Object.values(record).forEach((child) => conditionFields(child, out));
  }
  return out;
}

const prototypeKeys = Object.getOwnPropertyNames(Object.prototype).sort();

describe.each(configs)("QueryNormalizer — fuzzed wire params (%s)", (_, config) => {
  it("rejects hostile input only with QueryValidationException, never a crash", () => {
    fc.assert(
      fc.property(wireParams, (params) => void normalizeOrReject(params, config)),
      runs,
    );
  });

  it("never pollutes Object.prototype, whatever the bracket keys spell", () => {
    fc.assert(
      fc.property(wireParams, (params) => {
        normalizeOrReject(params, config);
        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeKeys);
        expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      }),
      runs,
    );
  });

  it("never lets a filter or sort field outside the allowlist through", () => {
    const filterable = new Set<string>(config.filter.fields as readonly string[]);
    // The effective sort is the client's sort (checked against `sort.fields`)
    // or the configured default; the id tiebreaker is appended to either.
    const sortable = new Set<string>([
      ...(config.sort.fields as readonly string[]),
      ...config.sortDefault.map(({ field }) => field as string),
      userMetadata.idField as string,
    ]);
    fc.assert(
      fc.property(wireParams, (params) => {
        const query = normalizeOrReject(params, config);
        if (query === undefined) {
          return;
        }
        for (const field of conditionFields(query.filter)) {
          expect(filterable).toContain(field);
        }
        for (const { field } of query.sort) {
          expect(sortable).toContain(field as string);
        }
      }),
      runs,
    );
  });

  it("never returns a page larger than pagination.maxLimit", () => {
    const { maxLimit } = config.settings.pagination;
    fc.assert(
      fc.property(limitParams, (params) => {
        const query = normalizeOrReject(params, config);
        if (query === undefined) {
          return;
        }
        expect(Number.isInteger(query.pagination.limit)).toBe(true);
        expect(query.pagination.limit).toBeGreaterThanOrEqual(0);
        expect(query.pagination.limit).toBeLessThanOrEqual(maxLimit);
      }),
      runs,
    );
  });
});
