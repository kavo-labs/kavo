import { describe, expect, it, vi } from "vitest";
import type { EntityId } from "@kavo/core";
import { AssociationInvalidShapeException, QueryValidationException, createKavo } from "@kavo/core";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";

/**
 * An id is a scalar. The programmatic surfaces (MCP tool arguments, GraphQL
 * JSON scalars, application code) can hand the engine any JSON value, and an
 * object that reaches an adapter is read as query criteria — TypeORM's
 * `Repository.delete({ ... })` and MikroORM's `nativeDelete` delete every
 * row it matches. The engine therefore refuses a non-scalar id before any
 * adapter call, on every id-addressed operation.
 */

class RecordingAdapter extends SeededAdapter<Post> {}

function makePosts() {
  const adapter = new RecordingAdapter([{ id: 1, title: "a", authorId: 1 } as never, { id: 2, title: "b" } as never]);
  const kavo = createKavo();
  kavo.createCrud(Author, undefined, { adapter: new SeededAdapter<Author>(), metadata: authorMetadata });
  const crud = kavo.createCrud(Post, undefined, { adapter, metadata: postMetadata });
  return { crud, adapter };
}

describe("engine — a non-scalar id never reaches an adapter", () => {
  const objectIds: unknown[] = [{ title: "a" }, { id: { gt: 0 } }, ["1"], true, null, "", Number.NaN, Infinity];

  it.each(["findOne", "updateOne", "patchOne", "deleteOne"] as const)(
    "rejects an object/array/boolean/empty id on %s with a 400 before the adapter runs",
    async (operation) => {
      const { crud, adapter } = makePosts();
      const spies = (["findOneById", "update", "patch", "delete", "restore", "purge"] as const).map((method) =>
        vi.spyOn(adapter, method),
      );
      for (const id of objectIds.filter((candidate) => candidate !== null)) {
        const body = operation.startsWith("update") || operation.startsWith("patch") ? { title: "x" } : null;
        await expect(
          crud.engine.execute({ operation, id: id as never, body: body as never, query: null, options: null }),
        ).rejects.toBeInstanceOf(QueryValidationException);
      }
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(adapter.rows).toHaveLength(2);
    },
  );

  it("keeps accepting string and number ids", async () => {
    const { crud } = makePosts();
    await expect(crud.findOne("1" as never)).resolves.toMatchObject({ id: 1 });
    await expect(crud.findOne(1 as never)).resolves.toMatchObject({ id: 1 });
  });
});

/** `SeededAdapter` plus the one write the `replace` strategy needs. */
class ReplaceCapableAdapter extends SeededAdapter<Author> {
  readonly calls: (readonly EntityId[] | null)[] = [];
  async replaceRelation(id: EntityId, _relation: string, memberIds: readonly EntityId[] | null): Promise<Author> {
    this.calls.push(memberIds);
    return (await this.findOneById(id, null))!;
  }
}

function makeAuthors() {
  const adapter = new ReplaceCapableAdapter([{ id: 1, name: "Ada", posts: [] }]);
  const kavo = createKavo();
  kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
  const crud = kavo.createCrud(Author, { relations: { posts: { write: { strategy: "replace" } } } } as never, {
    adapter,
    metadata: authorMetadata,
  });
  return { crud, adapter };
}

describe("serializer — a to-many association element's id must be a scalar", () => {
  it("rejects { id: <object> } inside an opted-in to-many create body with a 400, never passing it on", async () => {
    const { crud, adapter } = makeAuthors();
    const create = vi.spyOn(adapter, "create");
    await expect(crud.createOne({ name: "x", posts: [{ id: { gt: 0 } }] } as never)).rejects.toBeInstanceOf(
      AssociationInvalidShapeException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects { id: <object> } as a replace<Relation> member with a 400 before the adapter runs", async () => {
    const { crud, adapter } = makeAuthors();
    await expect(
      crud.engine.execute({ operation: "replacePosts", id: "1", body: [{ id: { gt: 0 } }], query: null, options: null } as never),
    ).rejects.toBeInstanceOf(AssociationInvalidShapeException);
    expect(adapter.calls).toHaveLength(0);
  });
});
