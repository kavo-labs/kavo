import { describe, expect, it, vi } from "vitest";
import { QueryValidationException, createKavo } from "@kavo/core";
import { Post, SeededAdapter, postMetadata } from "./support/blog-fixture.js";

/**
 * A route id on a numeric id column is coerced with the same rule a numeric
 * filter value is (`coerceScalar`): finite JavaScript number syntax only. A
 * blank id is not `0`, and `Infinity` names no row — both are the client's
 * 400, never an adapter lookup of some other id or a driver 500.
 */
describe("KavoEngine — numeric route id coercion", () => {
  function makePosts() {
    const adapter = new SeededAdapter<Post>([{ id: 1, title: "a" } as never]);
    const crud = createKavo().createCrud(Post, undefined, { adapter, metadata: postMetadata });
    return { crud, adapter };
  }

  it.each(["Infinity", "-Infinity", "1e999", "NaN", " ", "abc"])(
    "rejects the route id '%s' with a 400 before any lookup",
    async (id) => {
      const { crud, adapter } = makePosts();
      const lookup = vi.spyOn(adapter, "findOneById");
      await expect(
        crud.engine.execute({ operation: "findOne", id, body: null, query: null, options: null }),
      ).rejects.toMatchObject({
        code: "KAVO_QUERY_INVALID",
        issues: [{ field: "id", code: "KAVO_QUERY_INVALID_VALUE" }],
      });
      await expect(
        crud.engine.execute({ operation: "findOne", id, body: null, query: null, options: null }),
      ).rejects.toBeInstanceOf(QueryValidationException);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("still coerces an ordinary numeric id", async () => {
    const { crud } = makePosts();
    await expect(crud.findOne("1" as never)).resolves.toMatchObject({ id: 1 });
  });
});
