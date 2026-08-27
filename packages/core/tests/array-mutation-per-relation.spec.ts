import { describe, expect, it } from "vitest";
import type { EntityId, EntityMetadata, KavoContext, KavoSettings, RelationDescriptor } from "@kavo/core";
import {
  BUILT_IN_DEFAULTS,
  ConfigurationException,
  DefaultRelationRegistry,
  JsonPatchInvalidDocumentException,
  createKavo,
  validateSettings,
  writeOptedInRelationNames,
} from "@kavo/core";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";

/** `authorMetadata` plus a second to-many relation, so a relation-level override has a sibling to differ from. */
const authorMetadataTwoRelations: EntityMetadata<Author> = {
  ...authorMetadata,
  relations: [
    ...authorMetadata.relations,
    { name: "favorites", target: () => Post as never, cardinality: "many", includable: false, strategy: "auto" },
  ],
};

/** `SeededAdapter` plus every primitive `replace`, `resource`, and `jsonPatch` each need — enough to mix all three on one entity. */
class FullCapableAdapter<Entity extends { id: number }> extends SeededAdapter<Entity> {
  readonly calls: { method: string; relation: string }[] = [];
  readonly membership = new Map<string, Set<EntityId>>();

  async replaceRelation(
    id: EntityId,
    relation: string,
    memberIds: readonly EntityId[] | null,
    _context: KavoContext<Entity>,
  ): Promise<Entity> {
    this.calls.push({ method: "replaceRelation", relation });
    this.membership.set(relation, new Set(memberIds ?? []));
    const row = await this.findOneById(id, null);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    (row as unknown as Record<string, unknown>)[relation] = memberIds;
    return row;
  }

  async readRelation(id: EntityId, relation: string, _context: KavoContext<Entity>): Promise<Entity> {
    this.calls.push({ method: "readRelation", relation });
    const row = await this.findOneById(id, null);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    return row;
  }

  async addRelationMember(id: EntityId, relation: string, memberId: EntityId): Promise<Entity> {
    this.calls.push({ method: "addRelationMember", relation });
    const current = this.membership.get(relation) ?? new Set<EntityId>();
    current.add(memberId);
    this.membership.set(relation, current);
    const row = await this.findOneById(id, null);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    return row;
  }

  async removeRelationMember(id: EntityId, relation: string, memberId: EntityId): Promise<Entity> {
    this.calls.push({ method: "removeRelationMember", relation });
    const current = this.membership.get(relation) ?? new Set<EntityId>();
    current.delete(memberId);
    this.membership.set(relation, current);
    const row = await this.findOneById(id, null);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    return row;
  }

  async patchRelation(
    id: EntityId,
    relation: string,
    changes: { readonly add: readonly EntityId[]; readonly remove: readonly EntityId[] },
  ): Promise<Entity> {
    this.calls.push({ method: "patchRelation", relation });
    const current = this.membership.get(relation) ?? new Set<EntityId>();
    for (const memberId of changes.add) {
      current.add(memberId);
    }
    for (const memberId of changes.remove) {
      current.delete(memberId);
    }
    this.membership.set(relation, current);
    const row = await this.findOneById(id, null);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    return row;
  }
}

function makeTwoRelationCrud(config: Record<string, unknown>) {
  const adapter = new FullCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [], favorites: [] } as never]);
  const kavo = createKavo();
  kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
  const crud = kavo.createCrud(Author, config as never, { adapter, metadata: authorMetadataTwoRelations });
  return { crud, adapter, kavo };
}

/** `SeededAdapter` plus *only* `replaceRelation` — no `resource`/`jsonPatch` primitives at all. */
class ReplaceOnlyAdapter<Entity extends { id: number }> extends SeededAdapter<Entity> {
  async replaceRelation(
    id: EntityId,
    relation: string,
    memberIds: readonly EntityId[] | null,
    _context: KavoContext<Entity>,
  ): Promise<Entity> {
    const row = await this.findOneById(id, null);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    (row as unknown as Record<string, unknown>)[relation] = memberIds;
    return row;
  }
}

function makeTwoRelationCrudWithReplaceOnlyAdapter(config: Record<string, unknown>) {
  const adapter = new ReplaceOnlyAdapter<Author>([{ id: 1, name: "Ada", posts: [], favorites: [] } as never]);
  const kavo = createKavo();
  kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
  return kavo.createCrud(Author, config as never, { adapter, metadata: authorMetadataTwoRelations });
}

describe("per-relation arrayMutation.strategy (ADR-0029's per-relation amendment, issue #223)", () => {
  it("resolves two different strategies for two relations on the same entity", () => {
    const { crud } = makeTwoRelationCrud({
      arrayMutation: { strategy: "resource" },
      relations: {
        edges: {
          posts: { write: true }, // inherits the entity default: "resource"
          favorites: { write: { strategy: "replace" } }, // pinned, overrides the default
        },
      },
    });
    // posts: full resource surface.
    expect(crud.engine.registry.has("listPosts")).toBe(true);
    expect(crud.engine.registry.has("addPosts")).toBe(true);
    expect(crud.engine.registry.has("removePosts")).toBe(true);
    expect(crud.engine.registry.has("replacePosts")).toBe(true);
    // favorites: replace only.
    expect(crud.engine.registry.has("replaceFavorites")).toBe(true);
    expect(crud.engine.registry.has("listFavorites")).toBe(false);
    expect(crud.engine.registry.has("addFavorites")).toBe(false);
    expect(crud.engine.registry.has("removeFavorites")).toBe(false);
  });

  it("a relation-level override wins over the entity default", () => {
    const { crud } = makeTwoRelationCrud({
      arrayMutation: { strategy: "replace" },
      relations: { edges: { posts: { write: { strategy: "resource" } } } },
    });
    // Despite the entity default being "replace", the override gives posts the full resource surface.
    expect(crud.engine.registry.has("listPosts")).toBe(true);
    expect(crud.engine.registry.has("addPosts")).toBe(true);
    expect(crud.engine.registry.has("removePosts")).toBe(true);
    expect(crud.engine.registry.has("replacePosts")).toBe(true);
  });

  it("only registers replace<Relation> for a relation whose own override names 'replace', even under an entity default of 'resource'", () => {
    const { crud } = makeTwoRelationCrud({
      arrayMutation: { strategy: "resource" },
      relations: { edges: { posts: { write: { strategy: "replace" } } } },
    });
    expect(crud.engine.registry.has("replacePosts")).toBe(true);
    expect(crud.engine.registry.has("listPosts")).toBe(false);
    expect(crud.engine.registry.has("addPosts")).toBe(false);
    expect(crud.engine.registry.has("removePosts")).toBe(false);
  });

  it("rejects a per-relation override when arrayMutation is false at entity scope — feature-off wins", () => {
    expect(() =>
      makeTwoRelationCrud({
        arrayMutation: false,
        relations: { edges: { posts: { write: { strategy: "jsonPatch" } } } },
      }),
    ).toThrowError(ConfigurationException);
  });

  it("names the entity, relation and reason when arrayMutation is false and a relation pins its own strategy anyway", () => {
    try {
      makeTwoRelationCrud({
        arrayMutation: false,
        relations: { edges: { posts: { write: { strategy: "jsonPatch" } } } },
      });
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "relations.edges.posts.write",
      });
      expect((error as ConfigurationException).message).toContain("'arrayMutation' is false");
    }
  });

  it("rejects a relation-level write: true with no resolvable strategy anywhere, same as the entity-wide case", () => {
    expect(() =>
      makeTwoRelationCrud({
        relations: { edges: { posts: { write: true } } },
      }),
    ).toThrowError(ConfigurationException);
  });

  it("still accepts a plain write: true relation inheriting the entity default (back-compat)", () => {
    const { crud } = makeTwoRelationCrud({
      arrayMutation: { strategy: "replace" },
      relations: { edges: { posts: { write: true } } },
    });
    expect(crud.engine.registry.has("replacePosts")).toBe(true);
  });

  it("boots on an adapter with only replaceRelation when every write-opted relation resolves 'replace'", () => {
    // A real regression guard for capability narrowing (unlike a
    // full-capability adapter, which can't tell a broad check from a
    // narrow one): this adapter has no readRelation/addRelationMember/
    // removeRelationMember/patchRelation at all, so this only passes if
    // `createCrud` actually skips the resource/jsonPatch capability checks
    // for an entity with no relation using those strategies.
    expect(() =>
      makeTwoRelationCrudWithReplaceOnlyAdapter({
        arrayMutation: { strategy: "replace" },
        relations: { edges: { posts: { write: true } } },
      }),
    ).not.toThrow();
  });

  it("exposes each relation's resolved strategy through kavo.describe's debug dump", () => {
    const { kavo } = makeTwoRelationCrud({
      arrayMutation: { strategy: "resource" },
      relations: {
        edges: {
          posts: { write: true },
          favorites: { write: { strategy: "replace" } },
        },
      },
    });
    const dump = kavo.describe("Author") as { relations: { name: string; write?: string }[] };
    expect(dump.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "posts", write: "resource" }),
        expect.objectContaining({ name: "favorites", write: "replace" }),
      ]),
    );
  });

  it("throws once a sibling relation resolves 'resource', on that same replace-only adapter", () => {
    // Same adapter as above — adding a second, resource-strategy relation
    // must now demand the primitives that relation actually needs, even
    // though the first relation's own 'replace' requirement is still met.
    expect(() =>
      makeTwoRelationCrudWithReplaceOnlyAdapter({
        arrayMutation: { strategy: "replace" },
        relations: {
          edges: { posts: { write: true }, favorites: { write: { strategy: "resource" } } },
        },
      }),
    ).toThrowError(ConfigurationException);
  });
});

describe("DefaultRelationRegistry — the arrayMutationDefault constructor parameter", () => {
  const postsRelation: readonly RelationDescriptor[] = [
    { name: "posts", target: () => Post as never, cardinality: "many", includable: false, strategy: "auto" },
  ];

  it("names 'declares no arrayMutation.strategy', not 'is false', when the parameter is omitted", () => {
    try {
      new DefaultRelationRegistry(postsRelation, [], { posts: { write: true } }, "Author");
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).message).toContain("names a strategy");
      expect((error as ConfigurationException).message).not.toContain("is false");
    }
  });

  it("names 'is false' when the parameter is explicitly false", () => {
    try {
      new DefaultRelationRegistry(postsRelation, [], { posts: { write: true } }, "Author", false);
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).message).toContain("'arrayMutation' is false");
    }
  });

  it("raises a clean ConfigurationException, not a raw TypeError, for a null write value", () => {
    // `entityDefault: {}` (not `false`), so resolution actually reaches the
    // `typeof write === "object"` branch — `null` is `typeof "object"` too,
    // and without the guard `write.strategy` would throw a raw TypeError
    // instead of the same clean error an unresolvable strategy always gets.
    expect(
      () => new DefaultRelationRegistry(postsRelation, [], { posts: { write: null as never } }, "Author", {}),
    ).toThrowError(ConfigurationException);
  });
});

describe("validateSettings — relations.edges.<name>.write's object form", () => {
  function settingsWith(write: unknown): KavoSettings {
    return {
      ...BUILT_IN_DEFAULTS,
      relations: { ...BUILT_IN_DEFAULTS.relations, edges: { posts: { write } } },
    } as KavoSettings;
  }

  it("rejects an unknown strategy inside the object form, naming .write.strategy", () => {
    expect(() => validateSettings("Author", settingsWith({ strategy: "bogus" }))).toThrowError(ConfigurationException);
    try {
      validateSettings("Author", settingsWith({ strategy: "bogus" }));
    } catch (error) {
      expect((error as ConfigurationException).messageParams).toMatchObject({
        path: "relations.edges.posts.write.strategy",
      });
    }
  });

  it("rejects an object form with no strategy at all, naming .write.strategy", () => {
    try {
      validateSettings("Author", settingsWith({}));
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).messageParams).toMatchObject({
        path: "relations.edges.posts.write.strategy",
      });
    }
  });

  it("rejects a non-boolean, non-object write value, naming .write", () => {
    try {
      validateSettings("Author", settingsWith(42));
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).messageParams).toMatchObject({
        path: "relations.edges.posts.write",
      });
    }
  });

  it("accepts every valid strategy in the object form", () => {
    for (const strategy of ["replace", "resource", "jsonPatch"] as const) {
      expect(() => validateSettings("Author", settingsWith({ strategy }))).not.toThrow();
    }
  });
});

describe("writeOptedInRelationNames — the object write form counts as opting in", () => {
  it("includes a relation whose write names an object with a strategy", () => {
    expect(
      writeOptedInRelationNames({
        posts: { write: { strategy: "replace" } },
        comments: { write: false },
        tags: {},
      }),
    ).toEqual(["posts"]);
  });

  it("still includes a plain write: true relation, unaffected by the new form", () => {
    expect(writeOptedInRelationNames({ posts: { write: true } })).toEqual(["posts"]);
  });
});

describe("per-relation jsonPatch — engine end to end", () => {
  function makeJsonPatchMixCrud() {
    return makeTwoRelationCrud({
      // Entity default is "replace" — posts inherits it. favorites pins its
      // own "jsonPatch" strategy, which must still turn on jsonPatch body
      // parsing for the whole entity's patchOne, per relation scoping.
      arrayMutation: { strategy: "replace" },
      relations: {
        edges: {
          posts: { write: true },
          favorites: { write: { strategy: "jsonPatch" } },
        },
      },
    });
  }

  it("parses an array patchOne body as RFC 6902 once any relation resolves to jsonPatch, even though the entity default is 'replace'", async () => {
    const { crud, adapter } = makeJsonPatchMixCrud();
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "add", path: "/favorites/-", value: { id: 2 } }] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ method: "patchRelation", relation: "favorites" }]);
    expect(response.item).toMatchObject({ id: 1 });
  });

  it("also parses scalar /<field> ops through the same jsonPatch document once opted in via a relation alone", async () => {
    const { crud } = makeJsonPatchMixCrud();
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "replace", path: "/name", value: "Grace" }] as never,
      query: null,
      options: null,
    } as never);
    expect(response.item).toMatchObject({ id: 1, name: "Grace" });
  });

  it("rejects a /<relation>/- op naming a relation that opted into 'replace', not 'jsonPatch' — the two strategies stay mutually exclusive per relation", async () => {
    const { crud } = makeJsonPatchMixCrud();
    const call = crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "add", path: "/posts/-", value: 2 }] as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });

  it("registers no replace/list/add/remove<Relation> operation for a relation pinned to 'jsonPatch' alone (no replace/resource sibling)", () => {
    const { crud } = makeTwoRelationCrud({
      arrayMutation: {}, // unset — nothing inherits it, favorites pins its own
      relations: { edges: { favorites: { write: { strategy: "jsonPatch" } } } },
    });
    for (const id of ["replaceFavorites", "listFavorites", "addFavorites", "removeFavorites"]) {
      expect(crud.engine.registry.has(id)).toBe(false);
    }
  });

  it("still parses and applies an RFC 6902 body correctly for an entity with no replace/resource relation at all", async () => {
    const { crud, adapter } = makeTwoRelationCrud({
      arrayMutation: {},
      relations: { edges: { favorites: { write: { strategy: "jsonPatch" } } } },
    });
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [
        { op: "replace", path: "/name", value: "Marie" },
        { op: "add", path: "/favorites/-", value: { id: 2 } },
      ] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ method: "patchRelation", relation: "favorites" }]);
    expect(response.item).toMatchObject({ id: 1, name: "Marie" });
  });

  it("takes the ordinary object-body path, touching no relation primitive, when jsonPatch is opted into via a relation alone", async () => {
    const { crud, adapter } = makeJsonPatchMixCrud();
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: { name: "Grace" } as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([]);
    expect(response.item).toMatchObject({ id: 1, name: "Grace" });
  });

  it("does not parse an array patchOne body as jsonPatch when no relation and no entity default resolve to it", async () => {
    const { crud, adapter } = makeTwoRelationCrud({
      arrayMutation: { strategy: "replace" },
      relations: { edges: { posts: { write: true } } },
    });
    // An array body against an entity with no jsonPatch anywhere degrades
    // to `{}` through the ordinary deserializer, exactly as it always has.
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "replace", path: "/name", value: "Grace" }] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([]);
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
  });
});
