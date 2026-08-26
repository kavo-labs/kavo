import { describe, expect, it } from "vitest";
import type { EntityId, KavoContext } from "@kavo/core";
import { createKavo, resolveEntityConfig } from "@kavo/core";
import { SeededAdapter } from "./support/blog-fixture.js";
import { User, userMetadata } from "./support/user-fixture.js";
import {
  CompositeEntity,
  compositeMetadata,
  OwnerOfComposite,
  ownerOfCompositeMetadata,
} from "./support/composite-fixture.js";

/** A `replaceRelation`-capable adapter, the array-mutation counterpart of `array-mutation.spec.ts`'s `ReplaceCapableAdapter`. */
class ReplaceCapableCompositeAdapter extends SeededAdapter<CompositeEntity> {
  readonly calls: { id: EntityId; relation: string; memberIds: readonly EntityId[] | null }[] = [];

  async replaceRelation(
    id: EntityId,
    relation: string,
    memberIds: readonly EntityId[] | null,
    _context: KavoContext<CompositeEntity>,
  ): Promise<CompositeEntity> {
    this.calls.push({ id, relation, memberIds });
    const row = await this.findOneById(id, null);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    (row as unknown as Record<string, unknown>)[relation] = memberIds;
    return row;
  }
}

describe("resolveEntityConfig — composite-key allowlist defaults (issue #261)", () => {
  it("keeps the composite key columns in creatable's default", () => {
    const config = resolveEntityConfig(compositeMetadata, undefined, undefined);
    expect(config.allowlists.creatable).toEqual(expect.arrayContaining(["userId", "topic", "key"]));
  });

  it("excludes the composite key columns from updatable's default — a natural key is immutable after create", () => {
    const config = resolveEntityConfig(compositeMetadata, undefined, undefined);
    expect(config.allowlists.updatable).not.toEqual(expect.arrayContaining(["userId"]));
    expect(config.allowlists.updatable).not.toEqual(expect.arrayContaining(["topic"]));
    expect(config.allowlists.updatable).toEqual(expect.arrayContaining(["key"]));
  });

  it("leaves a single-key entity's creatable/updatable defaults unchanged", () => {
    const config = resolveEntityConfig(userMetadata, undefined, undefined);
    expect(config.allowlists.creatable).not.toEqual(expect.arrayContaining(["id"]));
    expect(config.allowlists.updatable).not.toEqual(expect.arrayContaining(["id"]));
  });

  it("allows cursor pagination on a composite-key entity (issue #263)", () => {
    expect(() =>
      resolveEntityConfig(compositeMetadata, { pagination: { strategy: "cursor" } } as never, undefined),
    ).not.toThrow();
  });

  it("allows since pagination on a composite-key entity and keeps every key column on filterable/selectable (issue #263)", () => {
    const config = resolveEntityConfig(
      compositeMetadata,
      { pagination: { strategy: "since", since: { field: "key" } } } as never,
      undefined,
    );
    expect(config.allowlists.filterable).toEqual(expect.arrayContaining(["userId", "topic"]));
    expect(config.allowlists.selectable).toEqual(expect.arrayContaining(["userId", "topic"]));
  });

  it("still rejects since pagination whose forced tiebreaker column is missing from filterable, on a composite-key entity", () => {
    expect(() =>
      resolveEntityConfig(
        compositeMetadata,
        {
          pagination: { strategy: "since", since: { field: "key" } },
          allowlists: { filterable: ["key", "topic"] }, // userId narrowed out
        } as never,
        undefined,
      ),
    ).toThrow(/forced tiebreaker column 'userId'/);
  });

  it("leaves offset/page pagination on a composite-key entity unaffected", () => {
    expect(() => resolveEntityConfig(compositeMetadata, undefined, undefined)).not.toThrow();
    expect(() =>
      resolveEntityConfig(compositeMetadata, { pagination: { strategy: "page" } } as never, undefined),
    ).not.toThrow();
  });
});

describe("createCrud — composite-key bootstrap rejections (issue #261)", () => {
  it("allows a composite-key entity's own relation to opt into array-mutation writes (issue #263)", () => {
    const kavo = createKavo();
    kavo.createCrud(User, undefined, { adapter: new SeededAdapter<User>(), metadata: userMetadata });
    const adapter = new ReplaceCapableCompositeAdapter();
    expect(() =>
      kavo.createCrud(
        CompositeEntity,
        { relations: { edges: { tags: { write: { strategy: "replace" } } } } } as never,
        { adapter, metadata: compositeMetadata },
      ),
    ).not.toThrow();
  });

  it("allows a relation whose target is a composite-key entity (issue #263)", () => {
    const kavo = createKavo();
    kavo.createCrud(CompositeEntity, undefined, {
      adapter: new SeededAdapter<CompositeEntity>(),
      metadata: compositeMetadata,
    });
    expect(() =>
      kavo.createCrud(OwnerOfComposite, undefined, {
        adapter: new SeededAdapter<OwnerOfComposite>(),
        metadata: ownerOfCompositeMetadata,
      }),
    ).not.toThrow();
  });

  it("does not reject an ordinary relation to a single-key target", () => {
    const kavo = createKavo();
    kavo.createCrud(User, undefined, { adapter: new SeededAdapter<User>(), metadata: userMetadata });
    expect(() =>
      kavo.createCrud(CompositeEntity, undefined, {
        adapter: new SeededAdapter<CompositeEntity>(),
        metadata: compositeMetadata,
      }),
    ).not.toThrow();
  });
});
