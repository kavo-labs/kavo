import { describe, expect, it } from "vitest";
import type { ClassRef, EntityMetadata } from "@kavo/core";
import { DefaultDeserializer, DefaultEntityCatalog } from "@kavo/core";
import {
  CompositeEntity,
  compositeMetadata,
  OwnerOfComposite,
  ownerOfCompositeMetadata,
} from "./support/composite-fixture.js";

/**
 * Association by id (ADR-0014) against a composite-key relation target
 * (issue #263). A single-key target accepts a reference object keyed by its
 * real `idField` (`{owner: {id: 7}}`) — a bare scalar is rejected (issue
 * #291); a composite target has no single field to key a reference object
 * by, so it accepts an object naming each of `compositeIdFields` directly,
 * or the same `~`-delimited wire id a route already uses — a composite key
 * has no single column that shorthand could be mistaken for, so it is
 * unaffected by the single-key restriction.
 */
const catalog = new DefaultEntityCatalog((entity: ClassRef) => {
  if (entity === CompositeEntity) {
    return compositeMetadata as unknown as EntityMetadata<object>;
  }
  return undefined;
});

const deserializer = new DefaultDeserializer<OwnerOfComposite>(ownerOfCompositeMetadata, catalog);

function deserialize(raw: unknown) {
  return deserializer.deserialize(raw, null, {
    entityName: "OwnerOfComposite",
    operation: "createOne",
  } as never);
}

describe("DefaultDeserializer.associate() — composite-key relation target (issue #263)", () => {
  it("narrows a reference object naming each key column directly", () => {
    const result = deserialize({ item: { userId: "u1", topic: "billing" } });
    expect(result).toEqual({ item: { userId: "u1", topic: "billing" } });
  });

  it("narrows a bare scalar carrying the ~-delimited composite id", () => {
    const result = deserialize({ item: "u1~billing" });
    expect(result).toEqual({ item: { userId: "u1", topic: "billing" } });
  });

  it("drops extra keys from a reference object, same as a single-key target", () => {
    const result = deserialize({ item: { userId: "u1", topic: "billing", key: "sneaky" } });
    expect(result).toEqual({ item: { userId: "u1", topic: "billing" } });
  });

  it("narrows to null when the reference object is missing a key column", () => {
    const result = deserialize({ item: { userId: "u1" } });
    expect(result).toEqual({ item: null });
  });

  it("narrows to null when the scalar id does not decode into the right number of parts", () => {
    const result = deserialize({ item: "not-enough-parts" });
    expect(result).toEqual({ item: null });
  });

  it("disassociates on null, same as a single-key target", () => {
    const result = deserialize({ item: null });
    expect(result).toEqual({ item: null });
  });
});
