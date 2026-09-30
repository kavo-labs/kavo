import { describe, expect, it } from "vitest";
import type { EntityId, EntityMetadata, KavoContext } from "@kavo/core";
import { createKavo } from "@kavo/core";
import { Post, SeededAdapter, postMetadata } from "./support/blog-fixture.js";

/**
 * A writable field or write-opted relation named `__proto__` (#533). Every
 * stage that builds a write from such a name has to keep it an own key:
 * assigning it (`result[key] = …`, `Object.assign`) runs the prototype setter
 * instead, silently dropping the value and re-parenting the object the adapter
 * receives onto a caller-chosen one. No ORM declares such a column, so this is
 * hardening; the names come from config, never from a request.
 */

class Doc {
  id = 0;
  name = "";
}

const docMetadata: EntityMetadata<Doc> = {
  entity: Doc,
  name: "Doc",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "name", kind: "string", nullable: false, generated: false },
    { name: "__proto__", kind: "json", nullable: true, generated: false },
  ],
  relations: [],
};

/** Records the data each write hands the adapter, exactly as received. */
class RecordingAdapter extends SeededAdapter<Doc> {
  readonly writes: Record<string, unknown>[] = [];

  override async create(data: Partial<Doc>): Promise<Doc> {
    this.writes.push(data as Record<string, unknown>);
    return { id: 1, name: "" };
  }

  override async patch(id: EntityId, data: Partial<Doc>): Promise<Doc> {
    this.writes.push(data as Record<string, unknown>);
    return { id: Number(id), name: "" };
  }
}

function expectOwnProtoKey(data: Record<string, unknown> | undefined, value: unknown) {
  expect(data).toBeDefined();
  expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  expect(Object.keys(data!)).toContain("__proto__");
  expect(Object.getOwnPropertyDescriptor(data, "__proto__")?.value).toEqual(value);
  expect(data!["polluted"]).toBeUndefined();
}

describe("a field named __proto__", () => {
  it("reaches the adapter as an own key on createOne, never as the data's prototype", async () => {
    const adapter = new RecordingAdapter();
    const crud = createKavo().createCrud(Doc, undefined, { adapter, metadata: docMetadata });

    // `JSON.parse` is how a wire body arrives, and it defines `__proto__` as an own key.
    await crud.createOne(JSON.parse('{ "name": "a", "__proto__": { "polluted": true } }') as never);

    expectOwnProtoKey(adapter.writes[0], { polluted: true });
  });

  it("reaches the adapter as an own key on patchOne", async () => {
    const adapter = new RecordingAdapter([{ id: 1, name: "a" }]);
    const crud = createKavo().createCrud(Doc, undefined, { adapter, metadata: docMetadata });

    await crud.patchOne(1, JSON.parse('{ "__proto__": { "polluted": true } }') as never);

    expectOwnProtoKey(adapter.writes[0], { polluted: true });
  });

  it("stays an own key when `set` forces it", async () => {
    const adapter = new RecordingAdapter();
    const crud = createKavo().createCrud(
      Doc,
      {
        set: { create: () => JSON.parse('{ "__proto__": { "polluted": true } }') as Record<string, unknown> },
      } as never,
      { adapter, metadata: docMetadata },
    );

    await crud.createOne({ name: "a" } as never);

    expectOwnProtoKey(adapter.writes[0], { polluted: true });
  });
});

class Shelf {
  id = 0;
  name = "";
}

const shelfMetadata: EntityMetadata<Shelf> = {
  entity: Shelf,
  name: "Shelf",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "name", kind: "string", nullable: false, generated: false },
  ],
  relations: [{ name: "__proto__", target: () => Post as never, cardinality: "many" } as never],
};

class PatchRecordingAdapter extends SeededAdapter<Shelf> {
  readonly patches: { relation: string; changes: unknown }[] = [];

  async patchRelation(
    id: EntityId,
    relation: string,
    changes: { readonly add: readonly EntityId[]; readonly remove: readonly EntityId[] },
    _context: KavoContext<Shelf>,
  ): Promise<Shelf> {
    this.patches.push({ relation, changes });
    return { id: Number(id), name: "" };
  }
}

describe("a write-opted relation named __proto__", () => {
  it("reaches patchRelation by name under the jsonPatch strategy", async () => {
    const adapter = new PatchRecordingAdapter([{ id: 1, name: "a" }]);
    const kavo = createKavo();
    kavo.createCrud(Post, undefined, { adapter: new SeededAdapter<Post>(), metadata: postMetadata });
    // A computed key: a literal `__proto__:` would set the prototype instead.
    const relations = { ["__proto__"]: { write: { strategy: "jsonPatch" } } };
    const crud = kavo.createCrud(Shelf, { relations } as never, { adapter, metadata: shelfMetadata });

    await crud.patchOne(1, [{ op: "add", path: "/__proto__/-", value: { id: 3 } }] as never);

    expect(adapter.patches).toEqual([{ relation: "__proto__", changes: { add: [3], remove: [] } }]);
  });
});
