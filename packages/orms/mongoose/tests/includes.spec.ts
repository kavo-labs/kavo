import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Schema } from "mongoose";
import type { DefaultKavoService, KavoInstance } from "@kavo/core";
import { createMongooseKavo } from "@kavo/mongoose";
import { clearCollections, startTestDatabase, type TestDatabase } from "./support/database.js";

interface Blog {
  _id: string;
  name: string;
  articles?: Article[];
}

interface Article {
  _id: string;
  title: string;
  blog?: Blog | null;
  notes?: Note[];
  deletedAt: Date | null;
}

interface Note {
  _id: string;
  body: string;
}

/**
 * Mongoose models a to-many edge as an array of refs on the *parent*,
 * which is the mirror image of a SQL foreign key on the child. The relation
 * descriptors core sees are identical either way.
 *
 * Declared through a factory so the models keep their *inferred* Mongoose
 * types — annotating them with `ReturnType<connection["model"]>` would
 * collapse them to `Model<unknown>`.
 */
function defineModels(connection: TestDatabase["connection"]) {
  return {
    Blog: connection.model(
      "Blog",
      new Schema({ name: String, articles: [{ type: Schema.Types.ObjectId, ref: "Article" }] }),
    ),
    Article: connection.model(
      "Article",
      new Schema({
        title: String,
        blog: { type: Schema.Types.ObjectId, ref: "Blog" },
        notes: [{ type: Schema.Types.ObjectId, ref: "Note" }],
        deletedAt: { type: Date, default: null },
      }),
    ),
    Note: connection.model("Note", new Schema({ body: String })),
  };
}

let database: TestDatabase;
let kavo: KavoInstance;
let models: ReturnType<typeof defineModels>;
let blogs: DefaultKavoService<Blog>;
let articles: DefaultKavoService<Article>;
let keyArticles: DefaultKavoService<Article>;
let nestedKeyBlogs: DefaultKavoService<Blog>;

beforeAll(async () => {
  database = await startTestDatabase();
  models = defineModels(database.connection);

  kavo = createMongooseKavo(database.connection);
  // Double cast on purpose: Mongoose's model type describes a *hydrated
  // document*, while Kavo serves lean data with `_id` already rendered as a
  // string. The interfaces above are the shape the service actually
  // returns, which is what these tests assert.
  blogs = kavo.createCrud(models.Blog, {
    allowlists: { includable: ["articles"] },
  }) as unknown as DefaultKavoService<Blog>;
  articles = kavo.createCrud(models.Article, {
    softDelete: { field: "deletedAt" },
    allowlists: { includable: ["blog", "notes"] },
  } as never) as unknown as DefaultKavoService<Article>;
  kavo.createCrud(models.Note);
  // Its own root instance so this Article config does not clobber the one
  // above in the shared catalog (issue #364).
  keyArticles = createMongooseKavo(database.connection).createCrud(models.Article, {
    softDelete: { field: "deletedAt" },
    allowlists: { includable: ["blog"] },
    relations: { edges: { blog: { strategy: "key" } } },
  } as never) as unknown as DefaultKavoService<Article>;
  const nestedKavo = createMongooseKavo(database.connection);
  nestedKavo.createCrud(models.Article, {
    softDelete: { field: "deletedAt" },
    allowlists: { includable: ["blog"] },
    relations: { edges: { blog: { strategy: "key" } } },
  } as never);
  nestedKeyBlogs = nestedKavo.createCrud(models.Blog, {
    allowlists: { includable: ["articles"] },
  }) as unknown as DefaultKavoService<Blog>;
});

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await clearCollections(database.connection);
});

/** One blog, two articles, one note on the first article. */
async function seed(): Promise<{ blogId: string; articleId: string }> {
  const blog = await models.Blog.create({ name: "Kavo weekly" });
  const note = await models.Note.create({ body: "typo on line 3" });
  const first = await models.Article.create({ title: "Includes", blog: blog._id, notes: [note._id] });
  const second = await models.Article.create({ title: "Soft delete", blog: blog._id, notes: [] });
  await models.Blog.updateOne({ _id: blog._id }, { $set: { articles: [first._id, second._id] } });
  return { blogId: String(blog._id), articleId: String(first._id) };
}

describe("MongooseRepositoryAdapter — to-one includes", () => {
  it("embeds a to-one relation through populate", async () => {
    const { blogId } = await seed();
    const list = await articles.findMany({ include: ["blog"], sort: [{ field: "title", direction: "asc" }] });
    expect(list.items[0]).toMatchObject({ title: "Includes", blog: { _id: blogId, name: "Kavo weekly" } });
  });

  it("supports include on findOne with identical semantics", async () => {
    const { articleId, blogId } = await seed();
    const item = await articles.findOne(articleId, { include: ["blog"] } as never);
    expect(item).toMatchObject({ blog: { _id: blogId } });
  });

  it("renders the ids of populated documents as strings too", async () => {
    const { blogId } = await seed();
    const item = (await articles.findMany({ include: ["blog"] })).items[0] as Article;
    // The ObjectId conversion has to recurse: a populated document carries
    // its own _id, and it must not leak out as a raw ObjectId.
    expect(typeof item.blog!._id).toBe("string");
    expect(item.blog!._id).toBe(blogId);
  });

  it("omits an un-included relation entirely, even though the ref path holds the id", async () => {
    await seed();
    const item = (await articles.findMany()).items[0] as unknown as Record<string, unknown>;
    // Documented asymmetry, not an oversight. In Mongoose the ref path *is*
    // the foreign key, so the raw id is right there in the stored document
    // — but `DefaultSerializer` skips any projected key that is also a
    // relation name, emitting the edge only when it is included. Under
    // @kavo/typeorm the FK is a separate `blogId` column and so survives.
    // Closing the gap needs a core change; see doc 15 §1.
    expect(item).not.toHaveProperty("blog");
    const stored = (await models.Article.findById(item["_id"]).lean()) as unknown as Record<string, unknown>;
    expect(stored["blog"]).toBeTruthy();
  });
});

describe("MongooseRepositoryAdapter — key loading (issue #364)", () => {
  it("materializes a to-one as its FK id, left un-populated", async () => {
    const { blogId } = await seed();
    const list = await keyArticles.findMany({ include: ["blog"], sort: [{ field: "title", direction: "asc" }] });
    expect((list.items[0] as { blog: unknown }).blog).toEqual({ _id: blogId });
  });

  it("serializes a null FK as null", async () => {
    await models.Article.create({ title: "Orphan" });
    const list = await keyArticles.findMany({
      include: ["blog"],
      filter: { kind: "condition", field: "title" as never, operator: "EQ", value: "Orphan" },
    });
    expect((list.items[0] as { blog: unknown }).blog).toBeNull();
  });

  it("works on findOne with the same shape", async () => {
    const { articleId, blogId } = await seed();
    const item = await keyArticles.findOne(articleId, { include: ["blog"] } as never);
    expect(item).toMatchObject({ blog: { _id: blogId } });
  });

  it("accepts select of exactly the pk and rejects any other field", async () => {
    const { blogId } = await seed();
    const ok = await keyArticles.findMany({ include: ["blog"], select: { blog: ["_id"] } as never });
    expect((ok.items[0] as { blog: unknown }).blog).toEqual({ _id: blogId });
    await expect(
      keyArticles.findMany({ include: ["blog"], select: { blog: ["name"] } as never }),
    ).rejects.toMatchObject({ issues: [{ field: "blog.name", code: "KAVO_QUERY_INVALID_FIELD" }] });
  });

  it("resolves a key edge nested under a populated to-many parent", async () => {
    const { blogId } = await seed();
    const list = await nestedKeyBlogs.findMany({ include: ["articles", "articles.blog"] });
    const embedded = (list.items[0] as { articles: { blog: unknown }[] }).articles;
    expect(embedded).toHaveLength(2);
    for (const article of embedded) {
      expect(article.blog).toEqual({ _id: blogId });
    }
  });
});

describe("MongooseRepositoryAdapter — to-many includes", () => {
  it("embeds a to-many relation without disturbing root pagination", async () => {
    await seed();
    const list = await blogs.findMany({ include: ["articles"] });
    // One root document, not one per article: populate issues its own
    // query and stitches in memory, so it can never multiply root rows
    // the way a SQL join would.
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);
    expect((list.items[0] as Blog).articles).toHaveLength(2);
  });

  it("paginates roots, then embeds — a page of one still gets its children", async () => {
    await seed();
    await models.Blog.create({ name: "Empty", articles: [] });
    const page = await blogs.findMany({ include: ["articles"], limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect((page.items[0] as Blog).articles).toHaveLength(2);
  });

  it("loads a nested level below an included to-many node", async () => {
    await seed();
    const list = await blogs.findMany({ include: ["articles.notes"] });
    const embedded = (list.items[0] as Blog).articles!;
    expect(embedded.find((article) => article.title === "Includes")?.notes).toHaveLength(1);
    expect(embedded.find((article) => article.title === "Soft delete")?.notes).toEqual([]);
  });

  it("returns an empty array for a root with no related documents", async () => {
    await models.Blog.create({ name: "Empty", articles: [] });
    const list = await blogs.findMany({ include: ["articles"] });
    expect((list.items[0] as Blog).articles).toEqual([]);
  });
});

describe("Includes and soft delete", () => {
  it("excludes soft-deleted related documents", async () => {
    const { articleId } = await seed();
    await articles.deleteOne(articleId);

    const list = await blogs.findMany({ include: ["articles"] });
    const embedded = (list.items[0] as Blog).articles!;
    expect(embedded.map((article) => article.title)).toEqual(["Soft delete"]);
  });

  it("keeps a root withDeleted from widening the relation", async () => {
    const { articleId } = await seed();
    await articles.deleteOne(articleId);

    // `withDeleted` is the *root's* opt-in; an included relation stays
    // scoped to live documents.
    const list = await articles.findMany({ withDeleted: true, include: ["notes"] });
    expect(list.items).toHaveLength(2);
    const deleted = (list.items as readonly Article[]).find((article) => article._id === articleId);
    expect(deleted?.notes).toHaveLength(1);
  });
});

describe("Sparse fieldsets on included nodes", () => {
  it("narrows the embedded shape and strips keys fetched for stitching", async () => {
    await seed();
    const list = await blogs.findMany({
      include: ["articles"],
      select: { root: ["_id", "name"], relations: { articles: ["title"] } },
    });
    expect(list.items[0]).toEqual({
      _id: expect.any(String),
      name: "Kavo weekly",
      articles: [{ title: "Includes" }, { title: "Soft delete" }],
    });
  });
});
