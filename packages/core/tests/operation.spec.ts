import { describe, expect, it } from "vitest";
import { STANDARD_OPERATION_IDS, STANDARD_OPERATION_VERB } from "../src/operations/operation.js";

describe("STANDARD_OPERATION_VERB (ADR-0032's reserved Level 3 mapping)", () => {
  it("has exactly one entry per standard operation id, no more and no fewer", () => {
    expect(Object.keys(STANDARD_OPERATION_VERB).sort()).toEqual([...STANDARD_OPERATION_IDS].sort());
  });

  it("maps findOne/findMany to item/list, not a shared 'find' — they share no DTO slot", () => {
    expect(STANDARD_OPERATION_VERB.findOne).toBe("item");
    expect(STANDARD_OPERATION_VERB.findMany).toBe("list");
  });

  it("maps every other operation to its own bare verb", () => {
    expect(STANDARD_OPERATION_VERB.createOne).toBe("create");
    expect(STANDARD_OPERATION_VERB.updateOne).toBe("update");
    expect(STANDARD_OPERATION_VERB.patchOne).toBe("patch");
    expect(STANDARD_OPERATION_VERB.deleteOne).toBe("delete");
    expect(STANDARD_OPERATION_VERB.restoreOne).toBe("restore");
    expect(STANDARD_OPERATION_VERB.purgeOne).toBe("purge");
  });
});
