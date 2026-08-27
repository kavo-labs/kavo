import { describe, expect, it } from "vitest";
import type { EntityId, KavoContext } from "@kavo/core";
import {
  ArrayMutationInvalidShapeException,
  ArrayMutationMemberNotFoundException,
  AssociationInvalidShapeException,
  ConfigurationException,
  DefaultOperationRegistry,
  NotFoundException,
  addRelationOperationId,
  createKavo,
  listRelationOperationId,
  registerArrayMutationOperations,
  removeRelationOperationId,
} from "@kavo/core";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";

/** `SeededAdapter` plus the four primitives `arrayMutation`'s `resource` strategy needs. */
class ResourceCapableAdapter<Entity extends { id: number; posts?: unknown }> extends SeededAdapter<Entity> {
  readonly calls: { method: string; id: EntityId; relation: string; memberId?: EntityId }[] = [];
  /** Every id currently linked, per relation — the fixture's "database". */
  readonly membership = new Map<string, Set<EntityId>>([["posts", new Set<EntityId>()]]);
  /** Ids that resolve to a real row on the target entity. */
  readonly realTargetIds = new Set<EntityId>([1, 2, 3, 4, 5]);

  /**
   * Hydrated stub members (`{id, title}`), not bare ids — a real adapter's
   * `relations: { [relation]: true }` eager-load returns full related
   * rows, and the forced-include response projection
   * (`KavoEngine.contextForArrayMutationResponse`) walks each element as an
   * object.
   */
  private async loaded(id: EntityId, relation: string): Promise<Entity> {
    const row = await this.findOneById(id, null);
    if (row === null) {
      throw new Error("fixture: row not found");
    }
    (row as unknown as Record<string, unknown>)[relation] = [...(this.membership.get(relation) ?? [])].map(
      (memberId) => ({ id: memberId, title: `Post ${memberId}` }),
    );
    return row;
  }

  async replaceRelation(
    id: EntityId,
    relation: string,
    memberIds: readonly EntityId[] | null,
    _context: KavoContext<Entity>,
  ): Promise<Entity> {
    this.calls.push({ method: "replaceRelation", id, relation });
    this.membership.set(relation, new Set(memberIds ?? []));
    return this.loaded(id, relation);
  }

  async readRelation(id: EntityId, relation: string, _context: KavoContext<Entity>): Promise<Entity> {
    this.calls.push({ method: "readRelation", id, relation });
    return this.loaded(id, relation);
  }

  async addRelationMember(
    id: EntityId,
    relation: string,
    memberId: EntityId,
    context: KavoContext<Entity>,
  ): Promise<Entity> {
    this.calls.push({ method: "addRelationMember", id, relation, memberId });
    const current = this.membership.get(relation) ?? new Set<EntityId>();
    if (!current.has(memberId)) {
      if (!this.realTargetIds.has(memberId)) {
        throw new NotFoundException({
          messageParams: { entity: "Post", id: String(memberId) },
          context: { entityName: context.entityName, operation: context.operation },
        });
      }
      current.add(memberId);
      this.membership.set(relation, current);
    }
    return this.loaded(id, relation);
  }

  async removeRelationMember(
    id: EntityId,
    relation: string,
    memberId: EntityId,
    context: KavoContext<Entity>,
  ): Promise<Entity> {
    this.calls.push({ method: "removeRelationMember", id, relation, memberId });
    const current = this.membership.get(relation) ?? new Set<EntityId>();
    if (!current.has(memberId)) {
      throw new ArrayMutationMemberNotFoundException({
        messageParams: { entity: context.entityName, relation, id: String(memberId) },
        context: { entityName: context.entityName, operation: context.operation },
      });
    }
    current.delete(memberId);
    this.membership.set(relation, current);
    return this.loaded(id, relation);
  }
}

function makeAuthorCrud(edgesWrite = true) {
  const adapter = new ResourceCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [] }]);
  const kavo = createKavo();
  kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
  const crud = kavo.createCrud(
    Author,
    { arrayMutation: { strategy: "resource" }, relations: { edges: { posts: { write: edgesWrite } } } } as never,
    { adapter, metadata: authorMetadata },
  );
  return { crud, adapter };
}

describe("arrayMutation.strategy: 'resource' — bootstrap", () => {
  for (const missing of ["replaceRelation", "readRelation", "addRelationMember", "removeRelationMember"] as const) {
    it(`rejects a write-opted relation under 'resource' when the adapter has no ${missing}`, () => {
      class PartiallyCapable extends SeededAdapter<Author> {
        async replaceRelation(): Promise<Author> {
          throw new Error("unused");
        }
        async readRelation(): Promise<Author> {
          throw new Error("unused");
        }
        async addRelationMember(): Promise<Author> {
          throw new Error("unused");
        }
        async removeRelationMember(): Promise<Author> {
          throw new Error("unused");
        }
      }
      const adapter = new PartiallyCapable();
      delete (adapter as unknown as Record<string, unknown>)[missing];

      expect(() =>
        createKavo().createCrud(
          Author,
          { arrayMutation: { strategy: "resource" }, relations: { edges: { posts: { write: true } } } } as never,
          { adapter, metadata: authorMetadata },
        ),
      ).toThrowError(ConfigurationException);
    });
  }

  it("registers list/add/remove/replace<Relation> for a resource-strategy write-opted relation", () => {
    const { crud } = makeAuthorCrud(true);
    expect(crud.engine.registry.has("listPosts")).toBe(true);
    expect(crud.engine.registry.has("addPosts")).toBe(true);
    expect(crud.engine.registry.has("removePosts")).toBe(true);
    expect(crud.engine.registry.has("replacePosts")).toBe(true);
  });

  it("registers none of the four when the relation never opts in", () => {
    const { crud } = makeAuthorCrud(false);
    expect(crud.engine.registry.has("listPosts")).toBe(false);
    expect(crud.engine.registry.has("addPosts")).toBe(false);
    expect(crud.engine.registry.has("removePosts")).toBe(false);
    expect(crud.engine.registry.has("replacePosts")).toBe(false);
  });
});

describe("registerArrayMutationOperations — resource strategy", () => {
  it("derives camelCase list/add/remove<Relation> ids", () => {
    expect(listRelationOperationId("posts")).toBe("listPosts");
    expect(addRelationOperationId("posts")).toBe("addPosts");
    expect(removeRelationOperationId("posts")).toBe("removePosts");
  });

  it("registers four operations per relation, each carrying its own meta.arrayMutation.action", () => {
    const registry = new DefaultOperationRegistry<Author>("Author");
    registerArrayMutationOperations<Author>(registry, [{ name: "posts", strategy: "resource" }], "Author");

    const list = registry.get("listPosts");
    expect(list?.kind).toBe("read");
    expect(list?.cardinality).toBe("one");
    expect(list?.meta.arrayMutation).toEqual({ relation: "posts", strategy: "resource", action: "list" });

    const add = registry.get("addPosts");
    expect(add?.kind).toBe("write");
    expect(add?.meta.arrayMutation).toEqual({ relation: "posts", strategy: "resource", action: "add" });

    const remove = registry.get("removePosts");
    expect(remove?.kind).toBe("write");
    expect(remove?.meta.arrayMutation).toEqual({ relation: "posts", strategy: "resource", action: "remove" });

    const replace = registry.get("replacePosts");
    expect(replace?.kind).toBe("write");
    expect(replace?.meta.arrayMutation).toEqual({ relation: "posts", strategy: "resource", action: "replace" });
  });

  it("only replace<Relation> is registered under the 'replace' strategy", () => {
    const registry = new DefaultOperationRegistry<Author>("Author");
    registerArrayMutationOperations<Author>(registry, [{ name: "posts", strategy: "replace" }], "Author");
    expect(registry.has("replacePosts")).toBe(true);
    expect(registry.has("listPosts")).toBe(false);
    expect(registry.has("addPosts")).toBe(false);
    expect(registry.has("removePosts")).toBe(false);
  });
});

describe("list<Relation> — end to end through KavoEngine", () => {
  it("returns the parent, with the relation forced onto the response", async () => {
    const { crud, adapter } = makeAuthorCrud();
    adapter.membership.set("posts", new Set([2, 3]));
    const response = await crud.engine.execute({
      operation: "listPosts",
      id: "1",
      body: null,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ method: "readRelation", id: 1, relation: "posts" }]);
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
    // The whole point of `list<Relation>`: the response must actually show
    // the relation it just read, not just the bare parent. Client `include=`
    // never reaches these operations, so this has to be forced on
    // (`KavoEngine.contextForArrayMutationResponse`) rather than riding the
    // ordinary include mechanism.
    expect((response.item as { posts: unknown }).posts).toEqual([
      { id: 2, title: "Post 2" },
      { id: 3, title: "Post 3" },
    ]);
  });

  it("still shows the relation even when it is write-opted but not read-includable", async () => {
    // ADR-0029: `write` and `allowlists.includable` are independent
    // opt-ins — a relation a client could never reach with `?include=`
    // must still appear on its own dedicated `list<Relation>` response.
    const { crud, adapter } = makeAuthorCrud(true);
    adapter.membership.set("posts", new Set([2]));
    const response = await crud.engine.execute({
      operation: "listPosts",
      id: "1",
      body: null,
      query: null,
      options: null,
    } as never);
    expect((response.item as { posts: unknown }).posts).toEqual([{ id: 2, title: "Post 2" }]);
  });
});

describe("add<Relation> — end to end through KavoEngine", () => {
  it("resolves an {id} reference and calls addRelationMember", async () => {
    const { crud, adapter } = makeAuthorCrud();
    const response = await crud.engine.execute({
      operation: "addPosts",
      id: "1",
      body: { id: 2 } as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ method: "addRelationMember", id: 1, relation: "posts", memberId: 2 }]);
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
  });

  it("rejects a bare scalar body instead of resolving it as shorthand for an {id} reference (issue #291)", async () => {
    const { crud } = makeAuthorCrud();
    await expect(
      crud.engine.execute({
        operation: "addPosts",
        id: "1",
        body: 2 as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(AssociationInvalidShapeException);
  });

  it("is idempotent — adding an id already a member changes nothing", async () => {
    const { crud, adapter } = makeAuthorCrud();
    adapter.membership.set("posts", new Set([2]));
    await crud.engine.execute({
      operation: "addPosts",
      id: "1",
      body: { id: 2 } as never,
      query: null,
      options: null,
    } as never);
    expect([...adapter.membership.get("posts")!]).toEqual([2]);
  });

  it("raises NotFoundException for an id matching no real row", async () => {
    const { crud } = makeAuthorCrud();
    const call = crud.engine.execute({
      operation: "addPosts",
      id: "1",
      body: { id: 404 } as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toThrowError(NotFoundException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_NOT_FOUND" });
  });

  it("rejects an array body with KAVO_ARRAY_MUTATION_INVALID_SHAPE — that shape is replace's own surface", async () => {
    const { crud } = makeAuthorCrud();
    const call = crud.engine.execute({
      operation: "addPosts",
      id: "1",
      body: [2, 3] as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toThrowError(ArrayMutationInvalidShapeException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_ARRAY_MUTATION_INVALID_SHAPE", status: 400 });
  });

  it("rejects a null body with KAVO_ARRAY_MUTATION_INVALID_SHAPE", async () => {
    const { crud } = makeAuthorCrud();
    await expect(
      crud.engine.execute({
        operation: "addPosts",
        id: "1",
        body: null,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(ArrayMutationInvalidShapeException);
  });
});

describe("remove<Relation> — end to end through KavoEngine", () => {
  it("resolves an {id} reference and calls removeRelationMember", async () => {
    const { crud, adapter } = makeAuthorCrud();
    adapter.membership.set("posts", new Set([2, 3]));
    const response = await crud.engine.execute({
      operation: "removePosts",
      id: "1",
      body: { id: 2 } as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ method: "removeRelationMember", id: 1, relation: "posts", memberId: 2 }]);
    expect([...adapter.membership.get("posts")!]).toEqual([3]);
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
  });

  it("raises ArrayMutationMemberNotFoundException for an id that isn't currently a member", async () => {
    const { crud } = makeAuthorCrud();
    const call = crud.engine.execute({
      operation: "removePosts",
      id: "1",
      body: { id: 99 } as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toThrowError(ArrayMutationMemberNotFoundException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND", status: 404 });
  });

  it("rejects a bare scalar body instead of resolving it as shorthand for an {id} reference (issue #291)", async () => {
    const { crud } = makeAuthorCrud();
    await expect(
      crud.engine.execute({
        operation: "removePosts",
        id: "1",
        body: 2 as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(AssociationInvalidShapeException);
  });

  it("rejects an array body with KAVO_ARRAY_MUTATION_INVALID_SHAPE", async () => {
    const { crud } = makeAuthorCrud();
    await expect(
      crud.engine.execute({
        operation: "removePosts",
        id: "1",
        body: [2] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(ArrayMutationInvalidShapeException);
  });
});
