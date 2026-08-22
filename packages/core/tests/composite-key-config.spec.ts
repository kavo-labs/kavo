import { describe, expect, it } from "vitest";
import { ConfigurationException, createKavo, resolveEntityConfig } from "@kavo/core";
import { SeededAdapter } from "./support/blog-fixture.js";
import { User, userMetadata } from "./support/user-fixture.js";
import {
  CompositeEntity,
  compositeMetadata,
  OwnerOfComposite,
  ownerOfCompositeMetadata,
} from "./support/composite-fixture.js";

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

  it("rejects cursor pagination configured on a composite-key entity, at bootstrap", () => {
    expect(() =>
      resolveEntityConfig(compositeMetadata, { pagination: { strategy: "cursor" } } as never, undefined),
    ).toThrow(ConfigurationException);
    expect(() =>
      resolveEntityConfig(compositeMetadata, { pagination: { strategy: "cursor" } } as never, undefined),
    ).toThrow(/not yet supported.*composite-key entity/);
  });

  it("rejects since pagination configured on a composite-key entity, at bootstrap", () => {
    expect(() =>
      resolveEntityConfig(
        compositeMetadata,
        { pagination: { strategy: "since", since: { field: "key" } } } as never,
        undefined,
      ),
    ).toThrow(ConfigurationException);
  });

  it("leaves offset/page pagination on a composite-key entity unaffected", () => {
    expect(() => resolveEntityConfig(compositeMetadata, undefined, undefined)).not.toThrow();
    expect(() =>
      resolveEntityConfig(compositeMetadata, { pagination: { strategy: "page" } } as never, undefined),
    ).not.toThrow();
  });
});

describe("createCrud — composite-key bootstrap rejections (issue #261)", () => {
  it("rejects a relation that opts into array-mutation writes on a composite-key entity", () => {
    expect(() =>
      createKavo().createCrud(
        CompositeEntity,
        { relations: { edges: { tags: { write: { strategy: "replace" } } } } } as never,
        {
          adapter: new SeededAdapter<CompositeEntity>(),
          metadata: compositeMetadata,
        },
      ),
    ).toThrow(ConfigurationException);
    expect(() =>
      createKavo().createCrud(
        CompositeEntity,
        { relations: { edges: { tags: { write: { strategy: "replace" } } } } } as never,
        {
          adapter: new SeededAdapter<CompositeEntity>(),
          metadata: compositeMetadata,
        },
      ),
    ).toThrow(/array-mutation writes are not yet supported for composite-key entities/);
  });

  it("rejects a relation whose target is a composite-key entity, once the target is registered", () => {
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
    ).toThrow(ConfigurationException);
    expect(() =>
      kavo.createCrud(OwnerOfComposite, undefined, {
        adapter: new SeededAdapter<OwnerOfComposite>(),
        metadata: ownerOfCompositeMetadata,
      }),
    ).toThrow(/composite-key relation targets are not yet supported/);
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
