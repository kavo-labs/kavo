import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JsonPatchInvalidDocumentException, KavoException } from "@kavo/core";
import type { JsonPatchParseOptions } from "../src/engine/json-patch.js";
import { parseJsonPatchDocument } from "../src/engine/json-patch.js";

/**
 * Property-based fuzzing of the `jsonPatch` body parser (ADR-0029). A patch
 * document is attacker input end to end, so whatever it spells, the parser
 * must either reject it with a Kavo exception or yield only the fields and
 * relations it was told are writable. `FC_SEED` pins the run (CI sets it).
 */

const seed = process.env["FC_SEED"] === undefined ? undefined : Number(process.env["FC_SEED"]);
const runs = { numRuns: 2000, ...(seed === undefined ? {} : { seed }) };

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
  ["prototype-shadowing names", options(["name", "constructor"], ["posts", "toString"])],
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

const prototypeKeys = Object.getOwnPropertyNames(Object.prototype).sort();

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
        for (const field of Object.keys(parsed.fields)) {
          expect(parseOptions.writableFields).toContain(field);
        }
        for (const relation of Object.keys(parsed.relations)) {
          expect(parseOptions.writeOptedRelations).toContain(relation);
          expect(Array.isArray(parsed.relations[relation]!.add)).toBe(true);
          expect(Array.isArray(parsed.relations[relation]!.remove)).toBe(true);
        }
        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeKeys);
      }),
      runs,
    );
  });
});
