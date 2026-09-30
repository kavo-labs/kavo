import { describe, expect, it } from "vitest";
import type { EntityId, NormalizedQueryContext } from "@kavo/core";
import { ForbiddenException, NotFoundException, createKavo, evaluateFilter } from "@kavo/core";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";

/**
 * The synthesized relation operations (`replace<Rel>`, `add<Rel>`,
 * `remove<Rel>`, `list<Rel>`, ADR-0029) read or write the parent row the
 * route id names, so they answer to that row's rules: a write is governed
 * as `updateOne`, the read as `findOne`, and `filter.apply` scopes the
 * parent lookup. A relation route must never be a way around either.
 */

/** Every relation primitive, recorded; `findOneById` honours `query.filter` the way a real adapter must. */
class RelationAdapter extends SeededAdapter<Author> {
  readonly calls: string[] = [];

  override async findOneById(id: EntityId, query: NormalizedQueryContext<Author> | null): Promise<Author | null> {
    const row = this.rows.find((candidate) => candidate.id === Number(id)) ?? null;
    if (row === null || query === null || query.filter.root === null) {
      return row;
    }
    return evaluateFilter(query.filter.root as never, row as unknown as Record<string, unknown>) ? row : null;
  }

  async replaceRelation(id: EntityId): Promise<Author> {
    this.calls.push("replace");
    return (await super.findOneById(id, null))!;
  }

  async readRelation(id: EntityId): Promise<Author> {
    this.calls.push("read");
    return (await super.findOneById(id, null))!;
  }

  async addRelationMember(id: EntityId): Promise<Author> {
    this.calls.push("add");
    return (await super.findOneById(id, null))!;
  }

  async removeRelationMember(id: EntityId): Promise<Author> {
    this.calls.push("remove");
    return (await super.findOneById(id, null))!;
  }
}

function makeAuthors(config: object) {
  const adapter = new RelationAdapter([
    { id: 1, name: "Ada", posts: [] },
    { id: 2, name: "Grace", posts: [] },
  ]);
  const kavo = createKavo();
  kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>([{ id: 9 } as never]), metadata: postMetadata });
  const crud = kavo.createCrud(
    Author,
    { relations: { posts: { write: { strategy: "resource" } } }, ...config } as never,
    { adapter, metadata: authorMetadata },
  );
  const run = (operation: string, id: string, body: unknown = null, app: object = {}) =>
    crud.engine.execute({ operation, id, body: body as never, query: null, options: { app } } as never);
  return { adapter, run };
}

const writes: readonly [string, unknown][] = [
  ["replacePosts", [{ id: 9 }]],
  ["addPosts", { id: 9 }],
  ["removePosts", { id: 9 }],
];

describe("relation operations answer to the parent's policy", () => {
  it.each(writes)("denies %s when the entity-level policy denies every operation", async (operation, body) => {
    const { adapter, run } = makeAuthors({ policy: () => false });
    await expect(run(operation, "1", body)).rejects.toBeInstanceOf(ForbiddenException);
    expect(adapter.calls).toEqual([]);
  });

  it.each(writes)(
    "governs %s by operations.updateOne.policy, which sees operation 'updateOne'",
    async (operation, body) => {
      const seen: string[] = [];
      const { adapter, run } = makeAuthors({
        operations: {
          updateOne: {
            policy: ({ operation: governing }: { operation: string }) => (seen.push(governing), false),
          },
        },
      });
      await expect(run(operation, "1", body)).rejects.toBeInstanceOf(ForbiddenException);
      expect(seen).toEqual(["updateOne"]);
      expect(adapter.calls).toEqual([]);
    },
  );

  it("governs listPosts by the findOne policy", async () => {
    const { adapter, run } = makeAuthors({ policy: ({ operation }: { operation: string }) => operation !== "findOne" });
    await expect(run("listPosts", "1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(adapter.calls).toEqual([]);
  });

  it("still runs a relation operation the policy allows", async () => {
    const { adapter, run } = makeAuthors({ policy: () => true });
    await run("addPosts", "1", { id: 9 });
    expect(adapter.calls).toEqual(["add"]);
  });
});

describe("relation operations answer to the parent's filter.apply", () => {
  const scopeToAda = {
    filter: {
      apply: () => ({ kind: "condition", field: "name", operator: "EQ", value: "Ada" }),
    },
  };

  it.each([...writes, ["listPosts", null] as [string, unknown]])(
    "answers %s on a parent outside the scope with 404, never reaching the adapter",
    async (operation, body) => {
      const { adapter, run } = makeAuthors(scopeToAda);
      await expect(run(operation, "2", body)).rejects.toBeInstanceOf(NotFoundException);
      expect(adapter.calls).toEqual([]);
    },
  );

  it("still serves a parent inside the scope", async () => {
    const { adapter, run } = makeAuthors(scopeToAda);
    await run("listPosts", "1");
    expect(adapter.calls).toEqual(["read"]);
  });
});
