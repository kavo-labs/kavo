import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { KavoInstance, DefaultKavoService } from "@kavo/core";
import { createPrismaKavo } from "@kavo/prisma";
import { newTestPrismaClient } from "./support/client.js";

class Blog {
  id!: number;
  name!: string;
  articles?: Article[];
}

class Article {
  id!: number;
  title!: string;
  blogId!: number | null;
  blog?: Blog | null;
  notes?: Note[];
  deletedAt!: Date | null;
}

class Note {
  id!: number;
  body!: string;
  articleId!: number | null;
}

let client: PrismaClient;
let kavo: KavoInstance;
let blogs: DefaultKavoService<Blog>;
let articles: DefaultKavoService<Article>;

beforeAll(() => {
  client = newTestPrismaClient();
  kavo = createPrismaKavo(client as never, {
    datamodel: Prisma.dmmf.datamodel,
    entities: [Blog, Article, Note],
    caseInsensitiveFilters: false,
  });
  blogs = kavo.createCrud(Blog, {
    allowlists: { includable: ["articles"] },
  }) as DefaultKavoService<Blog>;
  articles = kavo.createCrud(Article, {
    softDelete: { field: "deletedAt" },
    allowlists: { includable: ["blog", "notes"], filterable: ["id", "title", "blog.name"] },
  } as never) as DefaultKavoService<Article>;
  kavo.createCrud(Note, { allowlists: { includable: ["article"] } } as never);
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.note.deleteMany();
  await client.article.deleteMany();
  await client.blog.deleteMany();
});

/** One blog, two articles, one note on the first article. */
async function seed(): Promise<{ blogId: number; articleId: number }> {
  const blog = await client.blog.create({ data: { name: "Kavo weekly" } });
  const first = await client.article.create({ data: { title: "Includes", blogId: blog.id } });
  await client.article.create({ data: { title: "Soft delete", blogId: blog.id } });
  await client.note.create({ data: { body: "typo on line 3", articleId: first.id } });
  return { blogId: blog.id, articleId: first.id };
}

describe("PrismaRepositoryAdapter — to-one includes", () => {
  it("embeds a to-one relation from the main query", async () => {
    const { blogId } = await seed();
    const list = await articles.findMany({ include: ["blog"], sort: [{ field: "id", direction: "asc" }] });
    expect(list.items[0]).toMatchObject({ title: "Includes", blog: { id: blogId, name: "Kavo weekly" } });
  });

  it("supports include on findOne with identical semantics", async () => {
    const { articleId, blogId } = await seed();
    const item = await articles.findOne(articleId, { include: ["blog"] } as never);
    expect(item).toMatchObject({ blog: { id: blogId } });
  });

  it("reuses the filter allowlist for a condition on the same relation path", async () => {
    await seed();
    const list = await articles.findMany({
      include: ["blog"],
      filter: { kind: "condition", field: "blog.name" as never, operator: "EQ", value: "Kavo weekly" },
    });
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ blog: { name: "Kavo weekly" } });
  });
});

describe("PrismaRepositoryAdapter — to-many includes", () => {
  it("embeds a to-many relation without disturbing root pagination", async () => {
    await seed();
    const list = await blogs.findMany({ include: ["articles"] });
    // One root row, not one per article — Prisma's `include` never
    // multiplies root rows the way a raw SQL join would, so pagination
    // counted distinct roots with no adapter-side strategy needed.
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);
    expect((list.items[0] as { articles: unknown[] }).articles).toHaveLength(2);
  });

  it("paginates roots, then embeds — a page of one still gets its children", async () => {
    await seed();
    await client.blog.create({ data: { name: "Empty" } });
    const page = await blogs.findMany({ include: ["articles"], limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect((page.items[0] as { articles: unknown[] }).articles).toHaveLength(2);
  });

  it("loads a nested level below an included to-many node", async () => {
    await seed();
    const list = await blogs.findMany({ include: ["articles.notes"] });
    const embedded = (list.items[0] as { articles: { title: string; notes: unknown[] }[] }).articles;
    expect(embedded.find((article) => article.title === "Includes")?.notes).toHaveLength(1);
    expect(embedded.find((article) => article.title === "Soft delete")?.notes).toEqual([]);
  });

  it("returns an empty array for a root with no related rows", async () => {
    await client.blog.create({ data: { name: "Empty" } });
    const list = await blogs.findMany({ include: ["articles"] });
    expect((list.items[0] as { articles: unknown[] }).articles).toEqual([]);
  });
});

describe("Includes and soft delete", () => {
  it("excludes soft-deleted related rows", async () => {
    const { articleId } = await seed();
    await articles.deleteOne(articleId);

    const list = await blogs.findMany({ include: ["articles"] });
    const embedded = (list.items[0] as { articles: { title: string }[] }).articles;
    expect(embedded.map((article) => article.title)).toEqual(["Soft delete"]);
  });

  it("keeps a root withDeleted from widening the relation", async () => {
    const { articleId } = await seed();
    await articles.deleteOne(articleId);

    // `withDeleted` is the *root's* opt-in; the included relation stays
    // scoped to live rows.
    const list = await articles.findMany({ withDeleted: true, include: ["notes"] });
    expect(list.items).toHaveLength(2);
    const deleted = (list.items as readonly { id: number; notes: unknown[] }[]).find((row) => row.id === articleId);
    expect(deleted?.notes).toHaveLength(1);
  });
});

describe("Sparse fieldsets on included nodes", () => {
  it("narrows the embedded shape and strips keys fetched for stitching", async () => {
    await seed();
    const list = await blogs.findMany({
      include: ["articles"],
      select: { root: ["id", "name"], relations: { articles: ["title"] } },
    });
    expect(list.items[0]).toEqual({
      id: expect.any(Number),
      name: "Kavo weekly",
      articles: [{ title: "Includes" }, { title: "Soft delete" }],
    });
  });
});
