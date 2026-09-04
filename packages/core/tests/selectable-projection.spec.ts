import { describe, expect, it } from "vitest";
import type { DefaultKavoService, EntityConfig, ListResultDto } from "@kavo/core";
import { createKavo } from "@kavo/core";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";
import {
  Author,
  Comment,
  Post,
  SeededAdapter,
  authorMetadata,
  commentMetadata,
  postMetadata,
} from "./support/blog-fixture.js";

/**
 * `allowed.selectable` narrows the response projection (ADR-0026).
 *
 * Before that decision it gated only what `select=` could *name*, which
 * made it vacuous as a confidentiality control: a client that could not ask
 * for `email` received it anyway by sending no `select=` at all. #149 found
 * this with a real credential column.
 *
 * The three axes that matter are the ones these tests are organized around:
 * **which operations** it covers (all reads and all writes, since every one
 * of them serves a representation), **which spellings** trigger it (the
 * plain list, the `{ exclude }` form, and no key at all), and **how far it
 * reaches** (an included relation is projected by its own target's list,
 * not the root's).
 */

const COLUMNS = ["id", "name", "email", "age", "status", "createdAt"];

function crudFor(config: EntityConfig<User>) {
  const adapter = new InMemoryUserAdapter();
  const kavo = createKavo();
  return kavo.createCrud(User, config as never, { adapter, metadata: userMetadata }) as DefaultKavoService<User>;
}

async function seeded(config: EntityConfig<User>) {
  const crud = crudFor(config);
  const created = await crud.createOne({ name: "Ada", email: "ada@example.com", age: 36 } as never);
  return { crud, id: (created as User).id };
}

/** `email` stands in for #149's `apiKey`: present on the entity, off the list. */
const HIDES_EMAIL: EntityConfig<User> = {
  allowed: { selectable: ["id", "name", "age", "status", "createdAt"] },
} as EntityConfig<User>;

const EXCLUDES_EMAIL: EntityConfig<User> = {
  allowed: { selectable: { exclude: ["email"] } },
} as EntityConfig<User>;

describe("allowed.selectable narrows the response projection", () => {
  describe("every operation that serves a representation", () => {
    // A read-only fix would have been worthless: `createOne` echoes the row
    // it just wrote, so a credential omitted from every GET still leaves on
    // the 201. All five are asserted rather than sampled for that reason.
    it("hides the column on findOne", async () => {
      const { crud, id } = await seeded(HIDES_EMAIL);
      expect(await crud.findOne(id)).not.toHaveProperty("email");
    });

    it("hides the column on findMany", async () => {
      const { crud } = await seeded(HIDES_EMAIL);
      const list = (await crud.findMany()) as ListResultDto<User>;
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).not.toHaveProperty("email");
    });

    it("hides the column on the createOne echo", async () => {
      const crud = crudFor(HIDES_EMAIL);
      const created = await crud.createOne({ name: "Grace", email: "grace@example.com", age: 45 } as never);
      expect(created).not.toHaveProperty("email");
    });

    it("hides the column on updateOne", async () => {
      const { crud, id } = await seeded(HIDES_EMAIL);
      const updated = await crud.updateOne(id, { name: "Ada L", email: "new@example.com", age: 36 } as never);
      expect(updated).not.toHaveProperty("email");
    });

    it("hides the column on patchOne", async () => {
      const { crud, id } = await seeded(HIDES_EMAIL);
      expect(await crud.patchOne(id, { name: "Ada L" } as never)).not.toHaveProperty("email");
    });

    it("still serves everything the list does allow", async () => {
      const { crud, id } = await seeded(HIDES_EMAIL);
      expect(Object.keys((await crud.findOne(id)) as object).sort()).toEqual(
        COLUMNS.filter((name) => name !== "email").sort(),
      );
    });

    it("echoes the full allowlist key set from createOne, not merely one absence", async () => {
      // The five tests above assert `not.toHaveProperty("email")`, which
      // would also pass if the projection collapsed entirely. The create
      // echo is the case worth pinning positively: it is the argument for
      // why a read-only fix would have been worthless.
      const crud = crudFor(HIDES_EMAIL);
      const created = await crud.createOne({ name: "Grace", email: "g@x.io", age: 45 } as never);
      expect(Object.keys(created as object).sort()).toEqual(COLUMNS.filter((name) => name !== "email").sort());
    });
  });

  describe("the spellings", () => {
    it("treats the { exclude } form identically", async () => {
      // The form that states the intent most plainly, and the one #149
      // singled out as the clearest evidence the old behavior was wrong.
      const { crud, id } = await seeded(EXCLUDES_EMAIL);
      expect(await crud.findOne(id)).not.toHaveProperty("email");
    });

    it("leaves the projection alone when the key is not configured at all", async () => {
      // The compatibility guarantee. An app that never wrote `selectable`
      // sees exactly what it saw before, which is what makes this change
      // affect only configurations that asked for it.
      const { crud, id } = await seeded({});
      expect(Object.keys((await crud.findOne(id)) as object).sort()).toEqual([...COLUMNS].sort());
    });

    it("keeps rejecting an unlisted field in select=, rather than dropping it", async () => {
      // The old behavior that was already correct, and has to survive: the
      // 400 is what tells a client it asked for something it cannot have.
      const { crud, id } = await seeded(HIDES_EMAIL);
      await expect(crud.findOne(id, { select: ["email"] } as never)).rejects.toMatchObject({
        code: "KAVO_QUERY_INVALID",
        issues: [{ field: "email", code: "KAVO_QUERY_INVALID_FIELD" }],
      });
    });

    it("narrows further, never wider, when select= is sent as well", async () => {
      const { crud, id } = await seeded(HIDES_EMAIL);
      expect(await crud.findOne(id, { select: ["id", "name"] } as never)).toEqual({ id, name: "Ada" });
    });
  });

  describe("an included relation is projected by its own target", () => {
    // The leak this closes is indirect and would otherwise undo the whole
    // fix: hiding a column on `Author` means nothing if `Post` can include
    // `author` and serve it back.
    function blog(authorConfig: EntityConfig<Author>) {
      const metadata = new Map<unknown, unknown>([
        [Author, authorMetadata],
        [Post, postMetadata],
        [Comment, commentMetadata],
      ]);
      const postRow = Object.assign(new Post(), {
        id: 10,
        title: "First",
        authorId: 1,
        author: Object.assign(new Author(), { id: 1, name: "Ada" }),
      });
      const adapters = new Map<unknown, unknown>([
        [Author, new SeededAdapter<Author>([])],
        [Post, new SeededAdapter<Post>([postRow])],
        [Comment, new SeededAdapter<Comment>([])],
      ]);
      const kavo = createKavo({
        infrastructure: {
          metadataFor: (entity) => metadata.get(entity) as never,
          adapterFor: (entity) => adapters.get(entity) as never,
        },
      });
      kavo.createCrud(Author, authorConfig as never);
      kavo.createCrud(Comment);
      return kavo.createCrud(Post, {
        allowed: { includable: ["author"] },
      } as never) as DefaultKavoService<Post>;
    }

    async function includedAuthor(authorConfig: EntityConfig<Author>): Promise<Record<string, unknown>> {
      const list = (await blog(authorConfig).findMany({ include: ["author"] } as never)) as ListResultDto<Post>;
      const author = (list.items[0] as unknown as { author?: Record<string, unknown> }).author;
      expect(author).toBeDefined();
      return author as Record<string, unknown>;
    }

    it("applies the target's own selectable to the included rows", async () => {
      expect(Object.keys(await includedAuthor({ allowed: { selectable: ["id"] } } as EntityConfig<Author>))).toEqual([
        "id",
      ]);
    });

    it("leaves the target alone when the target configured nothing", async () => {
      // The root's own config must not reach across the edge in either
      // direction: each entity answers for its own columns.
      expect(Object.keys(await includedAuthor({} as EntityConfig<Author>))).toEqual(["id", "name"]);
    });
  });

  it("lets a registered item DTO win outright rather than intersecting", async () => {
    // Two narrowing statements, and the more specific one answers. An
    // intersection would make a DTO that deliberately exposes a field
    // silently fail to, which is the failure mode this whole ADR is about.
    class UserItemDto {
      id = 0;
      email = "";
    }
    const { crud, id } = await seeded({
      allowed: { selectable: ["id", "name"] },
      dto: { item: UserItemDto },
    } as never);
    expect(await crud.findOne(id)).toEqual({ id, email: "ada@example.com" });
  });
});
