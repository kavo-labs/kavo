import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Collection, MikroORM } from "@mikro-orm/core";
import { Entity, ManyToOne, OneToMany, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";
import type { DefaultKavoService, KavoInstance } from "@kavo/core";
import { createMikroOrmKavo } from "@kavo/mikroorm";
import { clearDatabase, newTestOrm } from "./support/database.js";

@Entity()
class Blog {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  name!: string;

  @OneToMany(() => Article, (article) => article.blog)
  articles = new Collection<Article>(this);
}

@Entity()
class Article {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  title!: string;

  @ManyToOne(() => Blog, { nullable: true })
  blog: Blog | null = null;

  @OneToMany(() => Note, (note) => note.article)
  notes = new Collection<Note>(this);

  @Property({ type: "Date", nullable: true })
  deletedAt: Date | null = null;
}

@Entity()
class Note {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  body!: string;

  @ManyToOne(() => Article, { nullable: true })
  article: Article | null = null;

  /** Soft-deletable too, so a nested include has a marker at *both* levels. */
  @Property({ type: "Date", nullable: true })
  deletedAt: Date | null = null;
}

let orm: MikroORM;
let kavo: KavoInstance;
let blogs: DefaultKavoService<Blog>;
let articles: DefaultKavoService<Article>;
let notes: DefaultKavoService<Note>;
let keyArticles: DefaultKavoService<Article>;
let nestedKeyBlogs: DefaultKavoService<Blog>;

beforeAll(async () => {
  orm = await newTestOrm([Blog, Article, Note]);
  kavo = createMikroOrmKavo(orm);
  keyArticles = createMikroOrmKavo(orm).createCrud(Article, {
    softDelete: { strategy: "soft", field: "deletedAt" },
    include: { fields: ["blog"] }, filter: { fields: ["id", "title", "blog.name"] },
    relations: { edges: { blog: { strategy: "key" } } },
  } as never) as DefaultKavoService<Article>;
  const nestedKavo = createMikroOrmKavo(orm);
  nestedKavo.createCrud(Article, {
    softDelete: { strategy: "soft", field: "deletedAt" },
    include: { fields: ["blog"] },
    relations: { edges: { blog: { strategy: "key" } } },
  } as never);
  nestedKeyBlogs = nestedKavo.createCrud(Blog, {
    include: { fields: ["articles"] },
  }) as DefaultKavoService<Blog>;
  blogs = kavo.createCrud(Blog, {
    include: { fields: ["articles"] },
  }) as DefaultKavoService<Blog>;
  articles = kavo.createCrud(Article, {
    softDelete: { strategy: "soft", field: "deletedAt" },
    include: { fields: ["blog", "notes"] },
            // Filtering across a relation path is its own allowlist decision,
      // independent of whether the relation may be included.
filter: { fields: ["id", "title", "blog.name"] },
  } as never) as DefaultKavoService<Article>;
  notes = kavo.createCrud(Note, {
    softDelete: { strategy: "soft", field: "deletedAt" },
    include: { fields: ["article"] },
  }) as DefaultKavoService<Note>;
});

afterAll(async () => {
  await orm.close();
});

beforeEach(async () => {
  await clearDatabase(orm);
});

/** One blog, two articles, one note on the first article. */
async function seed(): Promise<{ blogId: number; articleId: number }> {
  const em = orm.em.fork();
  const blog = em.create(Blog, { name: "Kavo weekly" });
  const first = em.create(Article, { title: "Includes", blog });
  em.create(Article, { title: "Soft delete", blog });
  em.create(Note, { body: "typo on line 3", article: first });
  await em.flush();
  return { blogId: blog.id, articleId: first.id };
}

describe("MikroOrmRepositoryAdapter — to-one includes", () => {
  it("embeds a to-one relation", async () => {
    const { blogId } = await seed();
    const list = await articles.findMany({ include: ["blog"], sort: [{ field: "id", direction: "asc" }] });
    expect(list.items[0]).toMatchObject({ title: "Includes", blog: { id: blogId, name: "Kavo weekly" } });
  });

  it("supports include on findOne with identical semantics", async () => {
    const { articleId, blogId } = await seed();
    const item = await articles.findOne(articleId, { include: ["blog"] } as never);
    expect(item).toMatchObject({ blog: { id: blogId } });
  });

  it("combines an include with a filter on the same relation path", async () => {
    await seed();
    const list = await articles.findMany({
      include: ["blog"],
      filter: { kind: "condition", field: "blog.name" as never, operator: "EQ", value: "Kavo weekly" },
    });
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ blog: { name: "Kavo weekly" } });
  });

  it("returns null for a to-one relation with no related row", async () => {
    const em = orm.em.fork();
    em.create(Article, { title: "Orphan" });
    await em.flush();
    const list = await articles.findMany({ include: ["blog"] });
    expect(list.items[0]).toMatchObject({ blog: null });
  });
});

describe("MikroOrmRepositoryAdapter — key loading (issue #364)", () => {
  it("materializes a to-one as its FK id, left un-populated", async () => {
    const { blogId } = await seed();
    const list = await keyArticles.findMany({ include: ["blog"], sort: [{ field: "id", direction: "asc" }] });
    expect((list.items[0] as { blog: unknown }).blog).toEqual({ id: blogId });
  });

  it("serializes a null FK as null", async () => {
    const em = orm.em.fork();
    em.create(Article, { title: "Orphan" });
    await em.flush();
    const list = await keyArticles.findMany({
      include: ["blog"],
      filter: { kind: "condition", field: "title" as never, operator: "EQ", value: "Orphan" },
    });
    expect((list.items[0] as { blog: unknown }).blog).toBeNull();
  });

  it("works on findOne with the same shape", async () => {
    const { articleId, blogId } = await seed();
    const item = await keyArticles.findOne(articleId, { include: ["blog"] } as never);
    expect(item).toMatchObject({ blog: { id: blogId } });
  });

  it("accepts select of exactly the pk and rejects any other field", async () => {
    const { blogId } = await seed();
    const ok = await keyArticles.findMany({ include: ["blog"], select: { blog: ["id"] } as never });
    expect((ok.items[0] as { blog: unknown }).blog).toEqual({ id: blogId });
    await expect(
      keyArticles.findMany({ include: ["blog"], select: { blog: ["name"] } as never }),
    ).rejects.toMatchObject({ issues: [{ field: "blog.name", code: "KAVO_QUERY_INVALID_FIELD" }] });
  });

  it("still resolves a filter on the key-edge path", async () => {
    await seed();
    const list = await keyArticles.findMany({
      include: ["blog"],
      filter: { kind: "condition", field: "blog.name" as never, operator: "EQ", value: "Kavo weekly" },
    });
    expect(list.items).toHaveLength(2);
  });

  it("resolves a key edge nested under a populated to-many parent", async () => {
    const { blogId } = await seed();
    const list = await nestedKeyBlogs.findMany({ include: ["articles", "articles.blog"] as never });
    const embedded = (list.items[0] as unknown as { articles: { blog: unknown }[] }).articles;
    expect(embedded).toHaveLength(2);
    for (const article of embedded) {
      expect(article.blog).toEqual({ id: blogId });
    }
  });
});

describe("MikroOrmRepositoryAdapter — to-many includes", () => {
  it("embeds a to-many relation without disturbing root pagination", async () => {
    await seed();
    const list = await blogs.findMany({ include: ["articles"] });
    // One root row, not one per article: MikroORM resolves `populate` with
    // its own queries, so a to-many never multiplies the rows pagination
    // counts — which is why this adapter ignores IncludeNode.strategy.
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);
    expect((list.items[0] as unknown as { articles: unknown[] }).articles).toHaveLength(2);
  });

  it("paginates roots, then populates — a page of one still gets its children", async () => {
    await seed();
    const em = orm.em.fork();
    em.create(Blog, { name: "Empty" });
    await em.flush();

    const page = await blogs.findMany({ include: ["articles"], limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect((page.items[0] as unknown as { articles: unknown[] }).articles).toHaveLength(2);
  });

  it("loads a nested level below a to-many node", async () => {
    await seed();
    const list = await blogs.findMany({ include: ["articles.notes" as never] });
    const embedded = (list.items[0] as unknown as { articles: { title: string; notes: unknown[] }[] }).articles;
    expect(embedded.find((article) => article.title === "Includes")?.notes).toHaveLength(1);
    expect(embedded.find((article) => article.title === "Soft delete")?.notes).toEqual([]);
  });

  it("returns an empty array for a root with no related rows", async () => {
    const em = orm.em.fork();
    em.create(Blog, { name: "Empty" });
    await em.flush();
    const list = await blogs.findMany({ include: ["articles"] });
    expect((list.items[0] as unknown as { articles: unknown[] }).articles).toEqual([]);
  });

  it("returns a to-many as a real array, not a MikroORM Collection", async () => {
    // The conversion at the adapter boundary is what makes this true; a
    // `Collection` would fail core's `Array.isArray` branch and serialize as
    // a single object.
    await seed();
    const list = await blogs.findMany({ include: ["articles"] });
    expect(Array.isArray((list.items[0] as unknown as { articles: unknown }).articles)).toBe(true);
  });
});

describe("Includes and soft delete", () => {
  it("excludes soft-deleted related rows", async () => {
    const { articleId } = await seed();
    await articles.deleteOne(articleId);

    const list = await blogs.findMany({ include: ["articles"] });
    const embedded = (list.items[0] as unknown as { articles: { title: string }[] }).articles;
    expect(embedded.map((article) => article.title)).toEqual(["Soft delete"]);
  });

  it("keeps a root withDeleted from widening the relation", async () => {
    const { articleId } = await seed();
    await articles.deleteOne(articleId);

    // `withDeleted` is the *root's* opt-in; the included relation stays
    // scoped to live rows.
    const list = await articles.findMany({ withDeleted: true, include: ["notes"] });
    expect(list.items).toHaveLength(2);
    const deleted = (list.items as unknown as readonly { id: number; notes: unknown[] }[]).find(
      (row) => row.id === articleId,
    );
    expect(deleted?.notes).toHaveLength(1);
  });
});

describe("Includes and soft delete, two levels down", () => {
  it("excludes soft-deleted rows at every level of a nested include", async () => {
    // `includeSoftDeleteWhere` merges a node's own `{ field: null }` with its
    // children's nested conditions. With only one soft-deletable level the
    // children half is always `undefined`, so the merge never actually runs —
    // this is the case that exercises both halves together.
    const { articleId } = await seed();
    const em = orm.em.fork();
    const extra = em.create(Note, { body: "second note", article: em.getReference(Article, articleId) });
    await em.flush();
    await notes.deleteOne(extra.id);

    const list = await blogs.findMany({ include: ["articles.notes" as never] });
    const embedded = (list.items[0] as unknown as { articles: { title: string; notes: { body: string }[] }[] })
      .articles;
    const includes = embedded.find((article) => article.title === "Includes")!;
    // The live note survives; the soft-deleted one is gone from the nested level.
    expect(includes.notes.map((note) => note.body)).toEqual(["typo on line 3"]);
  });
});

describe("Nested includes keep parents that have no surviving children", () => {
  it("returns an article with no live notes, rather than dropping it", async () => {
    // The trap `populateWhere` walked into: expressing the deeper level's
    // soft-delete scope as a nested condition made MikroORM read it as a
    // relation-path predicate on the *parent*, so an article whose notes were
    // all deleted (or which had none) vanished from the blog's collection
    // entirely instead of coming back with `notes: []`.
    const { articleId } = await seed();
    const em = orm.em.fork();
    const note = em.create(Note, { body: "doomed", article: em.getReference(Article, articleId) });
    await em.flush();
    await notes.deleteOne(note.id);

    const list = await blogs.findMany({ include: ["articles.notes" as never] });
    const embedded = (list.items[0] as unknown as { articles: { title: string; notes: { body: string }[] }[] })
      .articles;

    // Both articles survive: one with its remaining live note, one with none.
    expect(embedded.map((article) => article.title).sort()).toEqual(["Includes", "Soft delete"]);
    expect(embedded.find((article) => article.title === "Includes")!.notes.map((n) => n.body)).toEqual([
      "typo on line 3",
    ]);
    expect(embedded.find((article) => article.title === "Soft delete")!.notes).toEqual([]);
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
