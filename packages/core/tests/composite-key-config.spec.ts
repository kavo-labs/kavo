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

// Composite-key creatable/updatable derivation (issue #261) is exercised by
// `DefaultDeserializer` directly (`serializer.spec.ts`) — it is no longer a
// separately resolved config field (issue #386: `creatable`/`updatable` are
// reached through `dto.create`/`dto.update`'s `{ fields }` shorthand now,
// not a resolved allowlist).
describe("resolveEntityConfig — composite-key field-group defaults (issue #261)", () => {
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
    expect(config.filter.fields).toEqual(expect.arrayContaining(["userId", "topic"]));
    expect(config.select.fields).toEqual(expect.arrayContaining(["userId", "topic"]));
  });

  it("still rejects since pagination whose forced tiebreaker column is missing from filter.fields, on a composite-key entity", () => {
    expect(() =>
      resolveEntityConfig(
        compositeMetadata,
        {
          pagination: { strategy: "since", since: { field: "key" } },
          filter: { fields: ["key", "topic"] }, // userId narrowed out
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

  it("rejects include of a strategy: 'key' edge whose target has a composite primary key (issue #364)", async () => {
    const kavo = createKavo();
    kavo.createCrud(CompositeEntity, undefined, {
      adapter: new SeededAdapter<CompositeEntity>(),
      metadata: compositeMetadata,
    });
    const ownerAdapter = new SeededAdapter<OwnerOfComposite>([{ id: 1 } as OwnerOfComposite]);
    const owners = kavo.createCrud(
      OwnerOfComposite,
      { include: { fields: ["item"] }, relations: { edges: { item: { strategy: "key" } } } } as never,
      { adapter: ownerAdapter, metadata: ownerOfCompositeMetadata },
    ) as unknown as { findMany: (q: unknown) => Promise<unknown> };

    await expect(owners.findMany({ include: ["item"] })).rejects.toMatchObject({
      issues: [{ field: "item", code: "KAVO_QUERY_UNSUPPORTED_PARAM" }],
    });
  });
});
