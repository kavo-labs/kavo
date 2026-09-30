import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JsonPatchInvalidDocumentException, KavoException } from "@kavo/core";
import type { JsonPatchParseOptions } from "../src/engine/json-patch.js";
import { parseJsonPatchDocument } from "../src/engine/json-patch.js";
import { expectPrototypesIntact, fuzzRuns } from "./support/fuzz.js";

/**
 * Property-based fuzzing of the `jsonPatch` body parser (ADR-0029). A patch
 * document is attacker input end to end, so whatever it spells, the parser
 * must either reject it with a Kavo exception or yield only the fields and
 * relations it was told are writable. `FC_SEED` pins the run (CI sets it).
 */

const runs = fuzzRuns();

function options(writableFields: readonly string[], writeOptedRelations: readonly string[]): JsonPatchParseOptions {
  return {
    entityName: "User",
    writableFields: new Set(writableFields),
    writeOptedRelations: new Set(writeOptedRelations),
    operation: "patchOne",
    correlationId: "fuzz",
  };
}

/**
 * The second set names a field and a relation after `Object.prototype`
 * members. Nothing stops an entity from declaring either, and a parser that
 * accumulates into a plain object reads the inherited member back.
 */
const optionSets: ReadonlyArray<readonly [string, JsonPatchParseOptions]> = [
  ["ordinary names", options(["name", "email"], ["posts"])],
  ["prototype-shadowing names", options(["name", "constructor", "__proto__"], ["posts", "toString", "__proto__"])],
];

const hostileSegment = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom(
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "name",
    "email",
    "posts",
    "id",
    "-",
    "0",
    "~0",
    "~1",
    "..",
    "",
  ),
);
const pointer = fc.oneof(
  fc.array(hostileSegment, { minLength: 1, maxLength: 4 }).map((segments) => `/${segments.join("/")}`),
  fc.string({ maxLength: 16 }),
);
const op = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom("add", "remove", "replace", "move", "copy", "test") },
  fc.string({ maxLength: 8 }),
);
const operation = fc.record(
  { op, path: pointer, from: pointer, value: fc.jsonValue({ maxDepth: 3 }) },
  { requiredKeys: [] },
);
const randomDocument = fc.array(fc.oneof({ weight: 4, arbitrary: operation }, fc.jsonValue({ maxDepth: 2 })), {
  maxLength: 6,
});

/**
 * Near-valid documents: ops over the names the parser was actually given,
 * in the two legal path shapes. A random document almost always fails on
 * its first op, so without these a bug that needs every op to pass the
 * structural checks is never reached.
 */
function nearValidDocument(parseOptions: JsonPatchParseOptions) {
  const names = fc.constantFrom(...parseOptions.writableFields, ...parseOptions.writeOptedRelations);
  const nearValidOp = fc.record({
    op: fc.constantFrom("add", "remove", "replace"),
    path: fc.oneof(
      names.map((name) => `/${name}`),
      names.map((name) => `/${name}/-`),
    ),
    value: fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.record({ id: fc.integer() })),
  });
  return fc.array(nearValidOp, { minLength: 1, maxLength: 4 });
}

describe.each(optionSets)("parseJsonPatchDocument — fuzzed documents (%s)", (_, parseOptions) => {
  const document = fc.oneof(randomDocument, nearValidDocument(parseOptions));

  it("rejects a malformed document only with a Kavo exception", () => {
    fc.assert(
      fc.property(document, (doc) => {
        try {
          parseJsonPatchDocument(doc, parseOptions);
        } catch (error) {
          expect(error).toBeInstanceOf(KavoException);
          expect(error).toBeInstanceOf(JsonPatchInvalidDocumentException);
        }
      }),
      runs,
    );
  });

  it("never yields a field outside writableFields or a relation outside writeOptedRelations", () => {
    fc.assert(
      fc.property(document, (doc) => {
        let parsed;
        try {
          parsed = parseJsonPatchDocument(doc, parseOptions);
        } catch {
          return;
        }
        // A re-parented result hides its keys from `Object.keys`, so pin the
        // prototype first, then walk with `for…in` to see inherited keys too.
        expect(Object.getPrototypeOf(parsed.fields)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(parsed.relations)).toBe(Object.prototype);
        for (const field in parsed.fields) {
          expect(parseOptions.writableFields).toContain(field);
        }
        for (const relation in parsed.relations) {
          expect(parseOptions.writeOptedRelations).toContain(relation);
          expect(Object.hasOwn(parsed.relations, relation)).toBe(true);
          expect(Array.isArray(parsed.relations[relation]!.add)).toBe(true);
          expect(Array.isArray(parsed.relations[relation]!.remove)).toBe(true);
        }
        expectPrototypesIntact();
      }),
      runs,
    );
  });

  it("yields exactly the fields and member changes a valid document spells, dropping none", () => {
    fc.assert(
      fc.property(nearValidDocument(parseOptions), (doc) => {
        let parsed;
        try {
          parsed = parseJsonPatchDocument(doc, parseOptions);
        } catch {
          return;
        }
        // The expected result, built with Maps for the same reason the parser
        // uses them: a name like `__proto__` must stay an ordinary key.
        const fields = new Map<string, unknown>();
        const relations = new Map<string, { add: unknown[]; remove: unknown[] }>();
        for (const { op, path, value } of doc) {
          const [name, dash] = path.slice(1).split("/") as [string, string | undefined];
          if (dash === undefined) {
            fields.set(name, value);
          } else {
            const bucket = relations.get(name) ?? { add: [], remove: [] };
            bucket[op as "add" | "remove"].push(value);
            relations.set(name, bucket);
          }
        }
        expect(new Map(Object.entries(parsed.fields))).toEqual(fields);
        expect(new Map(Object.entries(parsed.relations))).toEqual(relations);
      }),
      runs,
    );
  });
});
