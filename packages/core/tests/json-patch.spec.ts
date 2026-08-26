import { describe, expect, it } from "vitest";
import type { EntityId, KavoContext } from "@kavo/core";
import {
  ConfigurationException,
  JsonPatchInvalidDocumentException,
  JsonPatchTargetNotFoundException,
  NotFoundException,
  createKavo,
} from "@kavo/core";
import { Author, Post, SeededAdapter, authorMetadata, postMetadata } from "./support/blog-fixture.js";

/** `SeededAdapter` plus the one write `arrayMutation`'s `jsonPatch` strategy needs. */
class JsonPatchCapableAdapter<Entity extends { id: number; posts?: unknown }> extends SeededAdapter<Entity> {
  readonly calls: {
    id: EntityId;
    relation: string;
    changes: { add: readonly EntityId[]; remove: readonly EntityId[] };
  }[] = [];

  /** Every id currently linked, per relation — the fixture's "database". */
  readonly membership = new Map<string, Set<EntityId>>([["posts", new Set<EntityId>()]]);
  /** Ids that resolve to a real row on the target entity. */
  readonly realTargetIds = new Set<EntityId>([1, 2, 3, 4, 5]);

  async patchRelation(
    id: EntityId,
    relation: string,
    changes: { readonly add: readonly EntityId[]; readonly remove: readonly EntityId[] },
    context: KavoContext<Entity>,
  ): Promise<Entity> {
    this.calls.push({ id, relation, changes });
    const current = this.membership.get(relation) ?? new Set<EntityId>();

    const missingRemovals = changes.remove.filter((memberId) => !current.has(memberId));
    if (missingRemovals.length > 0) {
      // The parent entity (`Author`) — `relation` is one of *its* edges —
      // matching `TypeOrmRepositoryAdapter#patchRelation`'s own
      // `{ entity: context.entityName, relation }` convention.
      throw new JsonPatchTargetNotFoundException({
        messageParams: { entity: context.entityName, relation, id: missingRemovals.join(", ") },
        context: { entityName: context.entityName, operation: context.operation },
      });
    }
    const toAdd = changes.add.filter((memberId) => !current.has(memberId));
    const missingTargets = toAdd.filter((memberId) => !this.realTargetIds.has(memberId));
    if (missingTargets.length > 0) {
      throw new NotFoundException({
        messageParams: { entity: "Post", id: missingTargets.join(", ") },
        context: { entityName: context.entityName, operation: context.operation },
      });
    }
    for (const memberId of toAdd) {
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
    (row as unknown as Record<string, unknown>)[relation] = [...current];
    return row;
  }
}

function makeAuthorCrud(strategy: "jsonPatch" | "replace" | false, edgesWrite = true) {
  const adapter = new JsonPatchCapableAdapter<Author>([{ id: 1, name: "Ada", posts: [] }]);
  const kavo = createKavo();
  // Registered on the same root so the entity catalog can resolve `Post`'s
  // id field when normalizing relation-op `value`s (`{id}` and scalar
  // forms) — the same association logic `create`/`update`/`replace` run
  // through.
  kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
  const crud = kavo.createCrud(
    Author,
    {
      arrayMutation: strategy === false ? false : { strategy },
      relations: { edges: { posts: { write: edgesWrite } } },
    } as never,
    { adapter, metadata: authorMetadata },
  );
  return { crud, adapter };
}

describe("arrayMutation.strategy: 'jsonPatch' — bootstrap", () => {
  it("rejects a write-opted relation under jsonPatch when the adapter has no patchRelation", () => {
    expect(() =>
      createKavo().createCrud(
        Author,
        { arrayMutation: { strategy: "jsonPatch" }, relations: { edges: { posts: { write: true } } } } as never,
        { adapter: new SeededAdapter<Author>(), metadata: authorMetadata }, // no patchRelation
      ),
    ).toThrowError(ConfigurationException);
  });

  it("requires patchRelation even when the write-opted relation's target is registered — the capability check, not the target, is what fires", () => {
    // The test above fails fast at `requireArrayMutationTargetsResolvable`
    // because `Post` is never registered; registering it clears that check
    // so the later `requireJsonPatchSupport` (kavo.ts) is the thrower.
    const kavo = createKavo();
    kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
    expect(() =>
      kavo.createCrud(
        Author,
        { arrayMutation: { strategy: "jsonPatch" }, relations: { edges: { posts: { write: true } } } } as never,
        { adapter: new SeededAdapter<Author>(), metadata: authorMetadata }, // no patchRelation
      ),
    ).toThrowError(ConfigurationException);
    expect(() =>
      kavo.createCrud(
        Author,
        { arrayMutation: { strategy: "jsonPatch" }, relations: { edges: { posts: { write: true } } } } as never,
        { adapter: new SeededAdapter<Author>(), metadata: authorMetadata },
      ),
    ).toThrowError(/patchRelation/);
  });

  it("does not register replacePosts under jsonPatch — that surface belongs to the replace strategy", () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    expect(crud.engine.registry.has("replacePosts")).toBe(false);
  });

  it("still requires replaceRelation under the replace strategy — jsonPatch's capability check is additive, not a substitute", () => {
    // `JsonPatchCapableAdapter` implements `patchRelation` but not
    // `replaceRelation`, so a relation still opted into the `replace`
    // strategy must fail bootstrap exactly as it always has.
    expect(() => makeAuthorCrud("replace")).toThrowError(ConfigurationException);
  });

  it("does not require patchRelation for a 'replace'-strategy entity", () => {
    class ReplaceCapable extends SeededAdapter<Author> {
      async replaceRelation(id: EntityId, relation: string, memberIds: readonly EntityId[] | null): Promise<Author> {
        const row = await this.findOneById(id, null);
        if (row === null) {
          throw new Error("fixture");
        }
        (row as unknown as Record<string, unknown>)[relation] = memberIds;
        return row;
      }
    }
    const kavo = createKavo();
    kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
    expect(() =>
      kavo.createCrud(
        Author,
        { arrayMutation: { strategy: "replace" }, relations: { edges: { posts: { write: true } } } } as never,
        { adapter: new ReplaceCapable(), metadata: authorMetadata },
      ),
    ).not.toThrow();
  });
});

describe("patchOne — jsonPatch overlap with the ordinary object-body contract", () => {
  it("an object body deserializes exactly as before, jsonPatch strategy or not", async () => {
    const { crud, adapter } = makeAuthorCrud("jsonPatch");
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: { name: "Grace" } as never,
      query: null,
      options: null,
    } as never);
    expect(response.item).toMatchObject({ id: 1, name: "Grace" });
    expect(adapter.calls).toEqual([]); // no relation ops touched
  });

  it("an array body under the 'replace' strategy is untouched — same {} DefaultDeserializer already produced", async () => {
    const { crud } = makeAuthorCrud("replace", false);
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "replace", path: "/name", value: "Grace" }] as never,
      query: null,
      options: null,
    } as never);
    // Not parsed as JSON Patch: the array degrades to an empty patch, same
    // as any non-object body always has.
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
  });

  it("an array body with arrayMutation: false is untouched, same as any non-object body", async () => {
    const { crud } = makeAuthorCrud(false, false);
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "replace", path: "/name", value: "Grace" }] as never,
      query: null,
      options: null,
    } as never);
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
  });
});

describe("patchOne — jsonPatch document, document-level validation", () => {
  it("rejects a non-object entry — a scalar, a null, or a nested array are all not ops", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    for (const body of [[42], [null], [["nested"]]]) {
      await expect(
        crud.engine.execute({
          operation: "patchOne",
          id: "1",
          body: body as never,
          query: null,
          options: null,
        } as never),
      ).rejects.toThrowError(JsonPatchInvalidDocumentException);
    }
  });

  it("rejects an invalid path — a non-string, one with no leading '/', or the bare root", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    for (const path of ["name", "", "/", 42]) {
      await expect(
        crud.engine.execute({
          operation: "patchOne",
          id: "1",
          body: [{ op: "replace", path, value: "Grace" }] as never,
          query: null,
          options: null,
        } as never),
      ).rejects.toThrowError(JsonPatchInvalidDocumentException);
    }
  });

  it("rejects a relation op whose value is missing, null, or undefined", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    for (const value of [undefined, null]) {
      await expect(
        crud.engine.execute({
          operation: "patchOne",
          id: "1",
          body: [{ op: "add", path: "/posts/-", value }] as never,
          query: null,
          options: null,
        } as never),
      ).rejects.toThrowError(JsonPatchInvalidDocumentException);
    }
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ op: "add", path: "/posts/-" }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });
});

describe("patchOne — jsonPatch document, field ops", () => {
  it("applies add/replace field ops through the ordinary patch DTO deserializer", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "replace", path: "/name", value: "Grace" }] as never,
      query: null,
      options: null,
    } as never);
    expect(response.item).toMatchObject({ id: 1, name: "Grace" });
  });

  it("last write wins when two ops target the same field", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [
        { op: "add", path: "/name", value: "Grace" },
        { op: "replace", path: "/name", value: "Ada Lovelace" },
      ] as never,
      query: null,
      options: null,
    } as never);
    expect(response.item).toMatchObject({ id: 1, name: "Ada Lovelace" });
  });

  it("rejects 'remove' on a field path — nothing to literally delete from a partial update", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    const call = crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "remove", path: "/name" }] as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toThrowError(JsonPatchInvalidDocumentException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_JSON_PATCH_INVALID_DOCUMENT", status: 400 });
  });

  it("rejects a path naming a field the entity doesn't have", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ op: "replace", path: "/nope", value: 1 }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });

  it("rejects a path naming the generated id field", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ op: "replace", path: "/id", value: 99 }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });

  it("rejects a malformed op (missing 'op')", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ path: "/name", value: "x" }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });

  it("rejects an op missing 'value'", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ op: "replace", path: "/name" }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });
});

describe("patchOne — jsonPatch document, relation ops", () => {
  it("resolves a scalar id and an {id} reference the same way replace does, and calls patchRelation", async () => {
    const { crud, adapter } = makeAuthorCrud("jsonPatch");
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [
        { op: "add", path: "/posts/-", value: 2 },
        { op: "add", path: "/posts/-", value: { id: 3 } },
      ] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", changes: { add: [2, 3], remove: [] } }]);
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
  });

  it("collects add and remove ops for the same relation into one patchRelation call", async () => {
    const { crud, adapter } = makeAuthorCrud("jsonPatch");
    adapter.membership.set("posts", new Set([1]));
    await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [
        { op: "add", path: "/posts/-", value: 2 },
        { op: "remove", path: "/posts/-", value: 1 },
      ] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", changes: { add: [2], remove: [1] } }]);
  });

  it("applies field ops and relation ops from the same document, field ops committing first", async () => {
    const { crud, adapter } = makeAuthorCrud("jsonPatch");
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [
        { op: "replace", path: "/name", value: "Grace" },
        { op: "add", path: "/posts/-", value: 2 },
      ] as never,
      query: null,
      options: null,
    } as never);
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", changes: { add: [2], remove: [] } }]);
    // The final response reflects the last write (`patchRelation`'s
    // return), which still carries the earlier field write — both target
    // the same persisted row.
    expect(response.item).toMatchObject({ id: 1, name: "Grace" });
  });

  it("propagates JsonPatchTargetNotFoundException for a 'remove' that isn't currently a member", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    const call = crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "remove", path: "/posts/-", value: 99 }] as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toThrowError(JsonPatchTargetNotFoundException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_JSON_PATCH_TARGET_NOT_FOUND", status: 404 });
    // The *parent* entity ('Author') names the relation — 'posts' is one of
    // Author's own edges, not one of the removed member's ('Post') — so the
    // rendered message must not name the related entity instead.
    await expect(call).rejects.toMatchObject({ detail: expect.stringContaining("Author") });
  });

  it("does not partially apply a document — field ops still commit even when the relation op is rejected", async () => {
    // The stated scope limit (ADR-0029's jsonPatch amendment): field changes
    // commit first via a separate adapter call, then one `patchRelation`
    // call per relation — each its own atomic unit, not one transaction
    // spanning the whole document. Pinning that here so a later change
    // can't silently make it either more atomic (fields roll back on relation
    // failure) or less (this stays true) without a test noticing.
    const { crud } = makeAuthorCrud("jsonPatch");
    const call = crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [
        { op: "replace", path: "/name", value: "Grace" },
        { op: "remove", path: "/posts/-", value: 99 },
      ] as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toThrowError(JsonPatchTargetNotFoundException);

    const reread = await crud.engine.execute({
      operation: "findOne",
      id: "1",
      body: null,
      query: null,
      options: null,
    } as never);
    expect(reread.item).toMatchObject({ id: 1, name: "Grace" });
  });

  it("propagates NotFoundException for an 'add' whose id matches no real row", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    const call = crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "add", path: "/posts/-", value: 404 }] as never,
      query: null,
      options: null,
    } as never);
    await expect(call).rejects.toThrowError(NotFoundException);
    await expect(call).rejects.toMatchObject({ code: "KAVO_NOT_FOUND" });
  });

  it("rejects a path naming a relation that never opted into write", async () => {
    const { crud } = makeAuthorCrud("jsonPatch", false);
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ op: "add", path: "/posts/-", value: 2 }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });

  it("rejects 'replace' on a relation path — that surface is arrayMutation.strategy: 'replace'", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ op: "replace", path: "/posts/-", value: [1, 2] }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });

  it("rejects a deeper path than '/<relation>/-' — no arbitrary path traversal", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ op: "add", path: "/posts/-/nested", value: 2 }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });

  it("rejects an unsupported top-level op", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ op: "move", path: "/posts/-", from: "/posts/0" }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });

  it("rejects an index-addressed relation path — members are addressed by identity, not position", async () => {
    const { crud } = makeAuthorCrud("jsonPatch");
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [{ op: "add", path: "/posts/0", value: 2 }] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchInvalidDocumentException);
  });

  it("silently narrows a value with no id key, rather than rejecting it — same leniency 'replace' already has", async () => {
    const { crud, adapter } = makeAuthorCrud("jsonPatch");
    await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [{ op: "add", path: "/posts/-", value: { name: "no id here" } }] as never,
      query: null,
      options: null,
    } as never);
    // Same element-level leniency `replace` already has (ADR-0014): an
    // object with no `id` key narrows to `undefined`, filtered out —
    // pinned here so a change to that shared `associate()` logic doesn't
    // silently start rejecting these instead.
    expect(adapter.calls).toEqual([{ id: 1, relation: "posts", changes: { add: [], remove: [] } }]);
  });

  it("treats an empty document as a clean no-op", async () => {
    const { crud, adapter } = makeAuthorCrud("jsonPatch");
    const response = await crud.engine.execute({
      operation: "patchOne",
      id: "1",
      body: [] as never,
      query: null,
      options: null,
    } as never);
    expect(response.item).toMatchObject({ id: 1, name: "Ada" });
    expect(adapter.calls).toEqual([]);
  });

  it("removing an id also named in the same document's 'add' fails on the not-a-member check, not a net no-op", async () => {
    // Both ops target the same relation and are collected into one
    // `patchRelation` call — the adapter (not the parser) is what decides
    // "is this id currently a member", so pinning here that a same-document
    // add+remove of one id is NOT quietly canceled out before reaching it.
    const { crud } = makeAuthorCrud("jsonPatch");
    await expect(
      crud.engine.execute({
        operation: "patchOne",
        id: "1",
        body: [
          { op: "add", path: "/posts/-", value: 7 },
          { op: "remove", path: "/posts/-", value: 7 },
        ] as never,
        query: null,
        options: null,
      } as never),
    ).rejects.toThrowError(JsonPatchTargetNotFoundException);
  });
});
