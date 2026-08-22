import { describe, expect, it } from "vitest";
import { decodeCompositeId, encodeCompositeId } from "@kavo/core";

describe("encodeCompositeId / decodeCompositeId (issue #261)", () => {
  it("round-trips plain values", () => {
    const encoded = encodeCompositeId(["abc-123", "topicName"]);
    expect(encoded).toBe("abc-123~topicName");
    expect(decodeCompositeId(encoded, 2)).toEqual(["abc-123", "topicName"]);
  });

  it("round-trips numeric values as their string form", () => {
    const encoded = encodeCompositeId([7, "x"]);
    expect(decodeCompositeId(encoded, 2)).toEqual(["7", "x"]);
  });

  it("escapes a literal separator inside a value so it survives the round trip", () => {
    const encoded = encodeCompositeId(["a~b", "c"]);
    expect(encoded).toBe("a~~b~c");
    expect(decodeCompositeId(encoded, 2)).toEqual(["a~b", "c"]);
  });

  it("escapes a value that is entirely separators", () => {
    const encoded = encodeCompositeId(["~~", "x"]);
    expect(decodeCompositeId(encoded, 2)).toEqual(["~~", "x"]);
  });

  it("returns null when the decoded part count does not match", () => {
    expect(decodeCompositeId("a~b", 3)).toBeNull();
    expect(decodeCompositeId("a~b~c", 2)).toBeNull();
    expect(decodeCompositeId("a", 2)).toBeNull();
  });

  it("round-trips a single-field composite id", () => {
    const encoded = encodeCompositeId(["only"]);
    expect(encoded).toBe("only");
    expect(decodeCompositeId(encoded, 1)).toEqual(["only"]);
  });
});
