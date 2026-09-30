import { beforeEach, describe, expect, it } from "vitest";
import type { SecurityDriver, SecurityResult } from "./driver.js";
import { isUnsupported } from "./driver.js";
import { HIDDEN_TENANT, type VaultRow, type VaultSeed } from "./fixture.js";

/** Every case in the corpus, by the id a `knownGaps` entry names. */
export type SecurityCaseId =
  | "filter-identifier-injection"
  | "filter-hidden-column"
  | "sort-hidden-column"
  | "select-hidden-column"
  | "filter-prototype-key"
  | "filter-prototype-operator"
  | "filter-value-literal"
  | "filter-nul-character"
  | "filter-non-finite-number"
  | "response-hides-column"
  | "create-strips-protected-fields"
  | "patch-keeps-primary-key"
  | "policy-denial"
  | "missing-row-before-denial"
  | "apply-scopes-find-many"
  | "search-escapes-wildcards"
  | "error-body-hides-internals";

export interface SecuritySuiteOptions {
  /** Shown in the `describe` title, e.g. `"@kavo/typeorm (engine)"`. */
  readonly name: string;
  /** A driver over an entity built from `VAULT_CONFIG`; called once per test, after `reset`. */
  readonly driver: () => SecurityDriver | Promise<SecurityDriver>;
  /** Empties the vault's storage. */
  readonly reset: () => Promise<void>;
  /** Writes rows straight to storage, bypassing Kavo, and returns their ids in order. */
  readonly seed: (rows: readonly VaultSeed[]) => Promise<readonly (number | string)[]>;
  /** Reads one row straight from storage, bypassing Kavo. */
  readonly read: (id: number | string) => Promise<VaultRow | null>;
  /** An id in the entity's own id format that names no row (`999999`, or an unused ObjectId). */
  readonly missingId: number | string;
  /** The primary key's name in a response body — `id` unless the ORM names it otherwise (Mongoose: `_id`). */
  readonly idField?: string;
  /**
   * Cases this consumer is known to fail, each with the public issue that
   * tracks it (`"#520"`). The case is skipped, not dropped, so the gap stays
   * visible in the run and the entry is deleted the day the issue closes.
   */
  readonly knownGaps?: Partial<Record<SecurityCaseId, string>>;
}

const QUERY_INVALID = /^KAVO_QUERY_/;

function expectRejected(result: SecurityResult, status: number, code?: RegExp | string): void {
  if (isUnsupported(result)) {
    throw new Error(`driver reported the input unsupported: ${result.unsupported}`);
  }
  expect(result.ok, JSON.stringify(result)).toBe(false);
  expect(result.status).toBe(status);
  if (code !== undefined && !result.ok && result.code !== undefined) {
    expect(result.code).toMatch(code);
  }
}

function expectAccepted(result: SecurityResult): unknown {
  if (isUnsupported(result)) {
    throw new Error(`driver reported the input unsupported: ${result.unsupported}`);
  }
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as { body: unknown }).body;
}

function itemsOf(body: unknown): readonly Record<string, unknown>[] {
  return (body as { items: readonly Record<string, unknown>[] }).items;
}

/**
 * The shared security conformance suite (#491). Every attack in it is one a
 * remote client can mount through any surface, and every expectation is the
 * guarantee Kavo documents — so an adapter or protocol surface inherits the
 * whole corpus the day it wires up a driver.
 *
 * Case names state the attack and the guarantee. Categories follow the
 * threat model in #490: 1 query-grammar injection, 2 allowlist bypass,
 * 3 write-side abuse, 4 authorization parity, 6 information disclosure.
 */
export function defineSecuritySuite(options: SecuritySuiteOptions): void {
  const gaps = options.knownGaps ?? {};
  const idField = options.idField ?? "id";
  let driver: SecurityDriver;

  const run = (id: SecurityCaseId, title: string, body: (skip: () => void) => Promise<void>): void => {
    const gap = gaps[id];
    if (gap !== undefined) {
      it.skip(`${title} [known gap, ${gap}]`, async () => {});
      return;
    }
    it(title, async (context) => {
      await body(() => context.skip());
    });
  };

  /** Skips the case when the surface cannot express the input at all — never a pass. */
  async function call(skip: () => void, operation: string, input: Parameters<SecurityDriver["call"]>[1]) {
    const result = await driver.call(operation, input);
    if (isUnsupported(result)) {
      skip();
    }
    return result;
  }

  describe(`security conformance — ${options.name}`, () => {
    beforeEach(async () => {
      await options.reset();
      driver = await options.driver();
    });

    describe("1 · query-grammar injection", () => {
      run(
        "filter-identifier-injection",
        "rejects an injected identifier in a filter field with a 400",
        async (skip) => {
          const [id] = await options.seed([{ name: "alpha", tenant: "a", apiKey: "k-1" }]);
          for (const field of ["name; DROP TABLE vault", "name) OR (1=1", "name`", "name.$where"]) {
            expectRejected(
              await call(skip, "findMany", { query: { [`filter[${field}][eq]`]: "x" } }),
              400,
              QUERY_INVALID,
            );
          }
          expect(await options.read(id!)).not.toBeNull();
        },
      );

      run(
        "filter-prototype-key",
        "rejects __proto__, constructor and prototype as filter fields with a 400",
        async (skip) => {
          for (const field of ["__proto__", "constructor", "prototype"]) {
            expectRejected(
              await call(skip, "findMany", { query: { [`filter[${field}][eq]`]: "x" } }),
              400,
              QUERY_INVALID,
            );
          }
          expect(Object.getPrototypeOf({})).toBe(Object.prototype);
        },
      );

      run(
        "filter-prototype-operator",
        "rejects an Object.prototype member name as a filter operator with a 400",
        async (skip) => {
          if (driver.grammar !== "wire") {
            skip();
          }
          for (const operator of ["constructor", "__proto__", "toString"]) {
            expectRejected(
              await call(skip, "findMany", { query: { [`filter[name][${operator}]`]: "x" } }),
              400,
              QUERY_INVALID,
            );
          }
        },
      );

      run(
        "filter-value-literal",
        "treats SQL and NoSQL metacharacters in a filter value as a literal",
        async (skip) => {
          await options.seed([
            { name: "alpha", tenant: "a", apiKey: null },
            { name: "beta", tenant: "a", apiKey: null },
          ]);
          for (const value of ["' OR '1'='1", "alpha' --", '{"$ne":null}', "%", "alpha\\"]) {
            const body = expectAccepted(await call(skip, "findMany", { query: { "filter[name][eq]": value } }));
            expect(itemsOf(body)).toEqual([]);
          }
        },
      );

      run(
        "filter-nul-character",
        "rejects a NUL character in a filter or search value with a 400 (#527)",
        async (skip) => {
          // Wire values only: a programmatic filter's values are typed input,
          // which skips wire coercion by design (doc 05 §5).
          if (driver.grammar !== "wire") {
            skip();
          }
          await options.seed([{ name: "alpha", tenant: "a", apiKey: null }]);
          expectRejected(
            await call(skip, "findMany", { query: { "filter[name][eq]": "alpha\u0000" } }),
            400,
            QUERY_INVALID,
          );
          expectRejected(await call(skip, "findMany", { query: { "search[query]": "al\u0000" } }), 400, QUERY_INVALID);
        },
      );

      run("filter-non-finite-number", "rejects Infinity as a numeric filter value with a 400", async (skip) => {
        if (driver.grammar !== "wire") {
          skip();
        }
        for (const value of ["Infinity", "-Infinity", "1e999"]) {
          expectRejected(await call(skip, "findMany", { query: { "filter[rank][gt]": value } }), 400, QUERY_INVALID);
        }
      });

      run(
        "search-escapes-wildcards",
        "matches % and _ in a search term literally, never as LIKE wildcards",
        async (skip) => {
          if (driver.grammar !== "wire") {
            skip();
          }
          await options.seed([
            { name: "100% cotton", tenant: "a", apiKey: null },
            { name: "1000 cotton", tenant: "a", apiKey: null },
            { name: "snake_case", tenant: "a", apiKey: null },
            { name: "snakeXcase", tenant: "a", apiKey: null },
          ]);
          const percent = expectAccepted(await call(skip, "findMany", { query: { "search[query]": "0%" } }));
          expect(itemsOf(percent).map((row) => row["name"])).toEqual(["100% cotton"]);
          const underscore = expectAccepted(await call(skip, "findMany", { query: { "search[query]": "e_c" } }));
          expect(itemsOf(underscore).map((row) => row["name"])).toEqual(["snake_case"]);
        },
      );
    });

    describe("2 · allowlist and projection bypass", () => {
      run("filter-hidden-column", "rejects a filter on a column outside filter.fields with a 400", async (skip) => {
        await options.seed([{ name: "alpha", tenant: "a", apiKey: "k-secret" }]);
        const queries: readonly Record<string, string>[] = [
          { "filter[apiKey][eq]": "k-secret" },
          { "filter[apiKey][like]": "k%" },
        ];
        for (const query of queries) {
          expectRejected(await call(skip, "findMany", { query }), 400, QUERY_INVALID);
        }
      });

      run("sort-hidden-column", "rejects a sort on a column outside sort.fields with a 400", async (skip) => {
        for (const sort of ["apiKey", "-apiKey", "tenant"]) {
          expectRejected(await call(skip, "findMany", { query: { sort } }), 400, QUERY_INVALID);
        }
      });

      run("select-hidden-column", "rejects a select of a column outside select.fields with a 400", async (skip) => {
        expectRejected(await call(skip, "findMany", { query: { select: "id,apiKey" } }), 400, QUERY_INVALID);
      });

      run("response-hides-column", "never serializes a column outside select.fields", async (skip) => {
        const [id] = await options.seed([{ name: "alpha", tenant: "a", apiKey: "k-secret" }]);
        const list = expectAccepted(await call(skip, "findMany", {}));
        const one = expectAccepted(await call(skip, "findOne", { id: id! }));
        for (const payload of [list, one]) {
          expect(JSON.stringify(payload)).not.toContain("k-secret");
          expect(JSON.stringify(payload)).not.toContain("apiKey");
        }
      });
    });

    describe("3 · write-side abuse", () => {
      run(
        "create-strips-protected-fields",
        "strips the primary key and non-writable columns from a create body",
        async (skip) => {
          const body = expectAccepted(
            await call(skip, "createOne", {
              body: { [idField]: 4242, name: "new", tenant: "a", apiKey: "k-injected" },
            }),
          ) as Record<string, number | string>;
          const id = body[idField]!;
          expect(String(id)).not.toBe("4242");
          expect((await options.read(id))?.apiKey ?? null).toBeNull();
        },
      );

      run(
        "patch-keeps-primary-key",
        "never changes the primary key or a non-writable column through patch",
        async (skip) => {
          const [id] = await options.seed([{ name: "alpha", tenant: "a", apiKey: "k-original" }]);
          expectAccepted(
            await call(skip, "patchOne", { id: id!, body: { [idField]: 4242, name: "patched", apiKey: "k-injected" } }),
          );
          expect(await options.read(id!)).toMatchObject({ name: "patched", apiKey: "k-original" });
        },
      );
    });

    describe("4 · authorization parity", () => {
      run("policy-denial", "denies a policy-forbidden operation with 403 and leaves the row in place", async (skip) => {
        const [id] = await options.seed([{ name: "alpha", tenant: "a", apiKey: null }]);
        expectRejected(await call(skip, "deleteOne", { id: id! }), 403, "KAVO_FORBIDDEN");
        expect(await options.read(id!)).not.toBeNull();
      });

      run(
        "missing-row-before-denial",
        "answers 404, not 403, for a row that does not exist (ADR-0037)",
        async (skip) => {
          expectRejected(await call(skip, "deleteOne", { id: options.missingId }), 404, "KAVO_NOT_FOUND");
          expectRejected(await call(skip, "findOne", { id: options.missingId }), 404, "KAVO_NOT_FOUND");
        },
      );

      run("apply-scopes-find-many", "keeps rows outside filter.apply out of findMany and its total", async (skip) => {
        await options.seed([
          { name: "visible", tenant: "a", apiKey: null },
          { name: "scoped out", tenant: HIDDEN_TENANT, apiKey: null },
        ]);
        const body = expectAccepted(await call(skip, "findMany", {}));
        expect(itemsOf(body).map((row) => row["name"])).toEqual(["visible"]);
        const filtered = expectAccepted(
          await call(skip, "findMany", { query: { "filter[tenant][eq]": HIDDEN_TENANT } }),
        );
        expect(itemsOf(filtered)).toEqual([]);
      });
    });

    describe("6 · information disclosure", () => {
      run(
        "error-body-hides-internals",
        "keeps stacks, driver messages and query text out of error bodies",
        async (skip) => {
          const results = [
            await call(skip, "findMany", { query: { "filter[apiKey][eq]": "x" } }),
            await call(skip, "findOne", { id: options.missingId }),
            await call(skip, "deleteOne", { id: options.missingId }),
          ];
          for (const result of results) {
            expect(isUnsupported(result) ? true : result.ok).toBe(false);
            const text = JSON.stringify((result as { body: unknown }).body);
            for (const leak of [
              /\bstack\b/i,
              /\bat .+:\d+:\d+/,
              /\bSELECT\b/,
              /\bFROM\s+"?vault/i,
              /Prisma|Mongo|TypeORM|MikroORM/,
            ]) {
              expect(text).not.toMatch(leak);
            }
          }
        },
      );
    });
  });
}
