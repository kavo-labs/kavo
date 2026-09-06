import { describe, expect, it } from "vitest";
import type { EntityId, KavoContext } from "@kavo/core";
import {
  ArrayMutationInvalidShapeException,
  AssociationInvalidShapeException,
  ConfigurationException,
  DefaultOperationRegistry,
  createKavo,
  registerArrayMutationOperations,
  replaceRelationOperationId,
  writeOptedInRelationNames,
} from "@kavo/core";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";

/** `SeededAdapter` plus the one write the `replace` strategy needs. */
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
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    (row as unknown as Record<string, unknown>)[relation] = memberIds;
    return row;
  }
}

function makeAuthorCrud(optIn: boolean) {
  const adapter = new ReplaceCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [] }]);
  const kavo = createKavo();
  // Registered on the same root so the entity catalog can resolve `Post`'s
  // id field when normalizing `posts` refs (`{id}` and scalar forms) — the
  // same association logic `create`/`update` already run through.
  kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
  const crud = kavo.createCrud(
    Author,
    (optIn ? { relations: { posts: { write: { strategy: "replace" } } } } : {}) as never,
    { adapter, metadata: authorMetadata },
  );
  return { crud, adapter };
}

describe("array-mutation config (EntityConfig.relations.<name>.write)", () => {
  it("rejects an unknown strategy value", () => {
    expect(() =>
      createKavo().createCrud(Author, { relations: { posts: { write: { strategy: "bogus" } } } } as never, {
        adapter: new SeededAdapter<Author>(),
        metadata: authorMetadata,
      }),
    ).toThrowError(ConfigurationException);
  });

  it("rejects write on a to-one relation", () => {
    expect(() =>
      createKavo().createCrud(Post, { relations: { author: { write: { strategy: "replace" } } } } as never, {
        adapter: new SeededAdapter<Post>(),
        metadata: postMetadata,
      }),
    ).toThrowError(ConfigurationException);
  });

  it("rejects a relations entry that tunes nothing (bare '{}')", () => {
    try {
      createKavo().createCrud(Author, { relations: { posts: {} } } as never, {
        adapter: new SeededAdapter<Author>(),
        metadata: authorMetadata,
      });
      throw new Error("expected a ConfigurationException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationException);
      expect((error as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
      expect((error as ConfigurationException).messageParams).toMatchObject({
        entity: "Author",
        path: "relations.posts",
      });
    }
  });

  it("rejects a write-opted relation when the adapter has no replaceRelation", () => {
    expect(() =>
      createKavo().createCrud(Author, { relations: { posts: { write: { strategy: "replace" } } } } as never, {
        adapter: new SeededAdapter<Author>(), // no replaceRelation
        metadata: authorMetadata,
      }),
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
      createKavo().createCrud(Author, { relations: { posts: { write: { strategy: "replace" } } } } as never, {
        adapter: new ReplaceCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [] }]),
        metadata: authorMetadata,
      }),
    ).toThrowError(ConfigurationException);
  });

  it("accepts an entity with no relations block", () => {
    expect(() =>
      createKavo().createCrud(Author, {} as never, {
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

  it("reads only the entries carrying a write block off EntityConfig.relations", () => {
    expect(
      writeOptedInRelationNames({
        posts: { write: { strategy: "replace" } },
        comments: { read: { maxDepth: 1 } },
      }),
    ).toEqual(["posts"]);
    expect(writeOptedInRelationNames(undefined)).toEqual([]);
  });

  it("registers one write operation per relation, carrying meta.arrayMutation", () => {
    const registry = new DefaultOperationRegistry<Author>("Author");
    registerArrayMutationOperations<Author>(registry, [{ name: "posts", strategy: "replace" }], "Author");
    const descriptor = registry.get("replacePosts");
    expect(descriptor?.kind).toBe("write");
    expect(descriptor?.cardinality).toBe("one");
    expect(descriptor?.enabled).toBe(true);
    expect(descriptor?.meta.arrayMutation).toEqual({ relation: "posts", strategy: "replace", action: "replace" });
  });

  it("registers an inspection-only handler when no handlerFactory is given", () => {
    const registry = new DefaultOperationRegistry<Author>("Author");
    registerArrayMutationOperations<Author>(registry, [{ name: "posts", strategy: "replace" }], "Author");
    expect(() => registry.get("replacePosts")!.handler.execute(null, {} as never)).toThrowError(ConfigurationException);
  });
});

describe("replace<Relation> — end to end through KavoEngine", () => {
  it("normalizes {id} references, and returns the updated parent", async () => {
    const { crud, adapter } = makeAuthorCrud(true);
    const response = await crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: [{ id: 2 }, { id: 3 }] as never,
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
      body: [{ id: 2 }, { id: 2 }, { id: 3 }] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", memberIds: [2, 2, 3] }]);
  });

  it("silently drops an array element with no id key, rather than rejecting it", async () => {
    // Element-level leniency, not top-level: only a non-array/non-null body
    // is ArrayMutationInvalidShapeException. An object element that carries
    // no `id` key goes through the same associate()/narrow-and-drop path
    // create/update already use (ADR-0014) — pinned here so a change to that
    // shared logic doesn't silently start rejecting these instead.
    const { crud, adapter } = makeAuthorCrud(true);
    await crud.engine.execute({
      operation: "replacePosts",
      id: "1",
      body: [{ id: 2 }, { name: "no id here" }] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", memberIds: [2] }]);
  });

  it("rejects a bare scalar array element instead of resolving it as shorthand for an {id} reference (issue #291)", async () => {
    const { crud } = makeAuthorCrud(true);
    await expect(
      crud.engine.execute({
        operation: "replacePosts",
        id: "1",
        body: [2, { id: 3 }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(AssociationInvalidShapeException);
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
