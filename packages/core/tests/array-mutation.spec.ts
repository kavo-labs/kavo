import { describe, expect, it } from "vitest";
import type { EntityId, KavoContext } from "@kavo/core";
import {
  ArrayMutationInvalidShapeException,
  ConfigurationException,
  DefaultOperationRegistry,
  createKavo,
  registerArrayMutationOperations,
  replaceRelationOperationId,
  writeOptedInRelationNames,
} from "@kavo/core";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";

/** `SeededAdapter` plus the one write `arrayMutation`'s `replace` strategy needs. */
class ReplaceCapableAdapter<Entity extends { id: number }> extends SeededAdapter<Entity> {
  readonly calls: { id: EntityId; relation: string; memberIds: readonly EntityId[] | null }[] = [];

  async replaceRelation(
    id: EntityId,
    relation: string,
    memberIds: readonly EntityId[] | null,
    _context: KavoContext<Entity>,
  ): Promise<Entity> {
    this.calls.push({ id, relation, memberIds });
    const row = await this.findOneById(id, null);
    if (row === null) throw new Error("fixture: row not found");
    (row as unknown as Record<string, unknown>)[relation] = memberIds;
    return row;
  }
}

function makeAuthorCrud(edgesWrite: boolean) {
  const adapter = new ReplaceCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [] }]);
  const kavo = createKavo();
  // Registered on the same root so the entity catalog can resolve `Post`'s
  // id field when normalizing `posts` refs (`{id}` and scalar forms) — the
  // same association logic `create`/`update` already run through.
  kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
  const crud = kavo.createCrud(
    Author,
    { arrayMutation: { strategy: "replace" }, relations: { edges: { posts: { write: edgesWrite } } } } as never,
    { adapter, metadata: authorMetadata },
  );
  return { crud, adapter };
}

describe("array-mutation config (arrayMutation, relations.edges.<name>.write)", () => {
  it("accepts the 'resource' strategy with no write-opted relations (no adapter capability required)", () => {
    expect(() =>
      createKavo().createCrud(Author, { arrayMutation: { strategy: "resource" } } as never, {
        adapter: new SeededAdapter<Author>(),
        metadata: authorMetadata,
      }),
    ).not.toThrow();
  });

  it("accepts the 'jsonPatch' strategy with no write-opted relations (no adapter capability required)", () => {
    expect(() =>
      createKavo().createCrud(Author, { arrayMutation: { strategy: "jsonPatch" } } as never, {
        adapter: new SeededAdapter<Author>(),
        metadata: authorMetadata,
      }),
    ).not.toThrow();
  });

  it("rejects an unknown strategy value", () => {
    expect(() =>
      createKavo().createCrud(Author, { arrayMutation: { strategy: "bogus" } } as never, {
        adapter: new SeededAdapter<Author>(),
        metadata: authorMetadata,
      }),
    ).toThrowError(ConfigurationException);
  });

  it("rejects write: true on a to-one relation", () => {
    expect(() =>
      createKavo().createCrud(Post, { relations: { edges: { author: { write: true } } } } as never, {
        adapter: new SeededAdapter<Post>(),
        metadata: postMetadata,
      }),
    ).toThrowError(ConfigurationException);
  });

  it("rejects write: true on a relation when arrayMutation is false", () => {
    expect(() =>
      createKavo().createCrud(
        Author,
        { arrayMutation: false, relations: { edges: { posts: { write: true } } } } as never,
        { adapter: new SeededAdapter<Author>(), metadata: authorMetadata },
      ),
    ).toThrowError(ConfigurationException);
  });

  it("rejects a write-opted relation when the adapter has no replaceRelation", () => {
    expect(() =>
      createKavo().createCrud(
        Author,
        { arrayMutation: { strategy: "replace" }, relations: { edges: { posts: { write: true } } } } as never,
        {
          adapter: new SeededAdapter<Author>(), // no replaceRelation
          metadata: authorMetadata,
        },
      ),
    ).toThrowError(ConfigurationException);
  });

  it("does not register replacePosts when the relation never opts in", () => {
    const { crud } = makeAuthorCrud(false);
    expect(crud.engine.registry.has("replacePosts")).toBe(false);
  });

  it("rejects a write-opted relation whose target the entity catalog cannot resolve", () => {
    // `Post` is deliberately never registered on this root and carries no
    // `infrastructure` fallback — the same condition that, unchecked, let
    // `resolveArrayMutationMemberIds` silently fall back to an unnarrowed
    // wire body at request time (a scalar id degrading to `undefined`, or
    // an object's first value being taken as the id).
    expect(() =>
      createKavo().createCrud(
        Author,
        { arrayMutation: { strategy: "replace" }, relations: { edges: { posts: { write: true } } } } as never,
        {
          adapter: new ReplaceCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [] }]),
          metadata: authorMetadata,
        },
      ),
    ).toThrowError(ConfigurationException);
  });

  it("rejects write: true on a relation when arrayMutation.strategy is left unset (issue #221)", () => {
    expect(() =>
      createKavo().createCrud(Author, { relations: { edges: { posts: { write: true } } } } as never, {
        adapter: new ReplaceCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [] }]),
        metadata: authorMetadata,
      }),
    ).toThrowError(ConfigurationException);
  });

  it("names the entity and relation when arrayMutation.strategy is left unset (issue #221)", () => {
    try {
      createKavo().createCrud(Author, { relations: { edges: { posts: { write: true } } } } as never, {
        adapter: new ReplaceCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [] }]),
        metadata: authorMetadata,
      });
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "relations.edges.posts.write",
      });
      expect((error as ConfigurationException).message).toContain("arrayMutation.strategy");
    }
  });

  it("accepts arrayMutation with strategy left unset when no relation opts into write", () => {
    expect(() =>
      createKavo().createCrud(Author, { arrayMutation: {} } as never, {
        adapter: new SeededAdapter<Author>(),
        metadata: authorMetadata,
      }),
    ).not.toThrow();
  });
});

describe("registerArrayMutationOperations / replaceRelationOperationId / writeOptedInRelationNames", () => {
  it("derives a camelCase replace<Relation> id", () => {
    expect(replaceRelationOperationId("posts")).toBe("replacePosts");
    expect(replaceRelationOperationId("tags")).toBe("replaceTags");
  });

  it("reads only the write: true entries off relations.edges", () => {
    expect(writeOptedInRelationNames({ posts: { write: true }, comments: { write: false }, tags: {} })).toEqual([
      "posts",
    ]);
    expect(writeOptedInRelationNames(undefined)).toEqual([]);
  });

  it("registers one write operation per relation, carrying meta.arrayMutation", () => {
    const registry = new DefaultOperationRegistry<Author>("Author");
    registerArrayMutationOperations<Author>(registry, ["posts"], "Author");
    const descriptor = registry.get("replacePosts");
    expect(descriptor?.kind).toBe("write");
    expect(descriptor?.cardinality).toBe("one");
    expect(descriptor?.enabled).toBe(true);
    expect(descriptor?.meta.arrayMutation).toEqual({ relation: "posts", strategy: "replace", action: "replace" });
  });

  it("registers an inspection-only handler when no handlerFactory is given", () => {
    const registry = new DefaultOperationRegistry<Author>("Author");
    registerArrayMutationOperations<Author>(registry, ["posts"], "Author");
    expect(() => registry.get("replacePosts")!.handler.execute(null, {} as never)).toThrowError(ConfigurationException);
  });
});

describe("replace<Relation> — end to end through KavoEngine", () => {
  it("normalizes scalar ids and {id} references, and returns the updated parent", async () => {
    const { crud, adapter } = makeAuthorCrud(true);
    const response = await crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: [2, { id: 3 }] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", memberIds: [2, 3] }]);
    // The response is the parent, projected through its own item DTO — not
    // the relation's member list (ADR-0029's Consequences).
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
  });

  it("passes duplicate member ids through as-is — deduping, if any, is the adapter's job", async () => {
    const { crud, adapter } = makeAuthorCrud(true);
    await crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: [2, 2, 3] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", memberIds: [2, 2, 3] }]);
  });

  it("silently drops an array element that doesn't narrow to an id, rather than rejecting it", async () => {
    // Element-level leniency, not top-level: only a non-array/non-null body
    // is ArrayMutationInvalidShapeException. An element that isn't a scalar
    // or an {id} reference goes through the same associate()/narrow-and-drop
    // path create/update already use (ADR-0014) — pinned here so a change to
    // that shared logic doesn't silently start rejecting these instead.
    const { crud, adapter } = makeAuthorCrud(true);
    await crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: [2, { name: "no id here" }] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", memberIds: [2] }]);
  });

  it("treats a null body as clearing every member", async () => {
    const { crud, adapter } = makeAuthorCrud(true);
    await crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: null,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", memberIds: null }]);
  });

  it("treats an empty array as clearing every member", async () => {
    const { crud, adapter } = makeAuthorCrud(true);
    await crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: [] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", memberIds: [] }]);
  });

  it("rejects a partial-mutation shape (an object body) with KAVO_ARRAY_MUTATION_INVALID_SHAPE", async () => {
    const { crud } = makeAuthorCrud(true);
    const call = crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: { add: [1] } as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toThrowError(ArrayMutationInvalidShapeException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_ARRAY_MUTATION_INVALID_SHAPE", status: 400 });
  });

  it("rejects a scalar body with KAVO_ARRAY_MUTATION_INVALID_SHAPE", async () => {
    const { crud } = makeAuthorCrud(true);
    await expect(
      crud.engine.execute({
        operation: "replacePosts",
        id: "1",
        body: "nope" as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(ArrayMutationInvalidShapeException);
  });
});
