import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Column, DataSource, DeleteDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import type { Logger } from "typeorm";
import type { KavoInstance, DefaultKavoService } from "@kavo/core";
import { createTypeOrmKavo } from "@kavo/typeorm";

/** Counts SELECT statements so a test can assert "exactly one query fired". */
class QueryCountingLogger implements Logger {
  count = 0;
  queries: string[] = [];
  logQuery(query: string): void {
    this.count += 1;
    this.queries.push(query);
  }
  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}

@Entity()
class Blog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;

  @OneToMany(() => Article, (article) => article.blog)
  articles!: Article[];
}

@Entity()
class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  title!: string;

  @ManyToOne(() => Blog, (blog) => blog.articles, { nullable: true })
  blog!: Blog | null;

  @OneToMany(() => Note, (note) => note.article)
  notes!: Note[];

  @DeleteDateColumn()
  deletedAt!: Date | null;
}

@Entity()
class Note {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  body!: string;

  @ManyToOne(() => Article, (article) => article.notes, { nullable: true })
  article!: Article | null;
}

let dataSource: DataSource;
let kavo: KavoInstance;
let blogs: DefaultKavoService<Blog>;
let joinedBlogs: DefaultKavoService<Blog>;
let articles: DefaultKavoService<Article>;
let batchedArticles: DefaultKavoService<Article>;
let keyArticles: DefaultKavoService<Article>;
let nestedKeyBlogs: DefaultKavoService<Blog>;
const queryLogger = new QueryCountingLogger();

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Blog, Article, Note],
    synchronize: true,
    logging: "all",
    logger: queryLogger,
  });
  await dataSource.initialize();
  kavo = createTypeOrmKavo(dataSource);
  blogs = kavo.createCrud(Blog, {
    include: { fields: ["articles"] },
  }) as DefaultKavoService<Blog>;
  articles = kavo.createCrud(Article, {
    softDelete: { strategy: "soft" },
    include: { fields: ["blog", "notes"] },
    // Filtering across a relation path is its own allowlist decision,
    // independent of whether the relation may be included.
    filter: { fields: ["id", "title", "blog.name"] },
  } as never) as DefaultKavoService<Article>;
  kavo.createCrud(Note, { include: { fields: ["article"] } });
  // The same entity with the to-many forced to `join`: the case the
  // normative pagination rule exists for.
  joinedBlogs = createTypeOrmKavo(dataSource).createCrud(Blog, {
    include: { fields: ["articles"] },
    relations: { edges: { articles: { strategy: "join" } } },
  }) as DefaultKavoService<Blog>;
  // A *to-one* forced to `batch`. Left on `auto` a to-one joins, so the
  // batched to-one path only exists when a config asks for it.
  batchedArticles = createTypeOrmKavo(dataSource).createCrud(Article, {
    softDelete: { strategy: "soft" },
    include: { fields: ["blog"] },
    relations: { edges: { blog: { strategy: "batch" } } },
  } as never) as DefaultKavoService<Article>;
  // The same to-one loaded as its FK id alone (issue #364) — no join, no
  // batch. `blog.name` stays filterable to prove a filter on a key-edge
  // path still resolves through its own join.
  keyArticles = createTypeOrmKavo(dataSource).createCrud(Article, {
    softDelete: { strategy: "soft" },
    include: { fields: ["blog"] },
    filter: { fields: ["id", "title", "blog.name"] },
    relations: { edges: { blog: { strategy: "key" } } },
  } as never) as DefaultKavoService<Article>;
  // A key edge nested under a batched to-many parent: Blog → articles (batch)
  // → each article's `blog` as a key edge.
  const nestedKavo = createTypeOrmKavo(dataSource);
  nestedKavo.createCrud(Article, {
    softDelete: { strategy: "soft" },
    include: { fields: ["blog"] },
    relations: { edges: { blog: { strategy: "key" } } },
  } as never);
  nestedKeyBlogs = nestedKavo.createCrud(Blog, {
    include: { fields: ["articles"] },
  }) as DefaultKavoService<Blog>;
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Note).clear();
  await dataSource.getRepository(Article).clear();
  await dataSource.getRepository(Blog).clear();
});

/** One blog, two articles, one note on the first article. */
async function seed(): Promise<{ blogId: number; articleId: number }> {
  const blog = await dataSource.getRepository(Blog).save({ name: "Kavo weekly" });
  const first = await dataSource.getRepository(Article).save({ title: "Includes", blog });
  await dataSource.getRepository(Article).save({ title: "Soft delete", blog });
  await dataSource.getRepository(Note).save({ body: "typo on line 3", article: first });
  return { blogId: blog.id, articleId: first.id };
}

describe("TypeOrmRepositoryAdapter — join loading", () => {
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

  it("reuses the include join for a filter on the same path", async () => {
    await seed();
    const list = await articles.findMany({
      include: ["blog"],
      filter: { kind: "condition", field: "blog.name" as never, operator: "EQ", value: "Kavo weekly" },
    });
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ blog: { name: "Kavo weekly" } });
  });
});

describe("TypeOrmRepositoryAdapter — batch loading", () => {
  it("embeds a to-many relation without disturbing root pagination", async () => {
    await seed();
    const list = await blogs.findMany({ include: ["articles"] });
    // One root row, not one per article — the to-many was batched, so
    // pagination counted distinct roots.
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);
    expect((list.items[0] as { articles: unknown[] }).articles).toHaveLength(2);
  });

  it("paginates roots, then batches — a page of one still gets its children", async () => {
    await seed();
    await dataSource.getRepository(Blog).save({ name: "Empty" });
    const page = await blogs.findMany({ include: ["articles"], limit: 1, offset: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect((page.items[0] as { articles: unknown[] }).articles).toHaveLength(2);
  });

  it("loads a nested level below a batched node", async () => {
    await seed();
    const list = await blogs.findMany({ include: ["articles.notes"] });
    const embedded = (list.items[0] as { articles: { title: string; notes: unknown[] }[] }).articles;
    expect(embedded.find((article) => article.title === "Includes")?.notes).toHaveLength(1);
    expect(embedded.find((article) => article.title === "Soft delete")?.notes).toEqual([]);
  });

  it("returns an empty array for a root with no related rows", async () => {
    await dataSource.getRepository(Blog).save({ name: "Empty" });
    const list = await blogs.findMany({ include: ["articles"] });
    expect((list.items[0] as { articles: unknown[] }).articles).toEqual([]);
  });
});

describe("Pagination correctness with a joined to-many (normative)", () => {
  it("counts and slices distinct roots even when the join multiplies rows", async () => {
    await seed(); // one blog, two articles
    await dataSource.getRepository(Blog).save({ name: "Second" });

    const page = await joinedBlogs.findMany({ include: ["articles"], limit: 1 });
    // The joined to-many yields two rows for the first blog; pagination
    // still counts and slices roots, so limit 1 means one blog with both
    // of its articles — never half a blog.
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect((page.items[0] as { articles: unknown[] }).articles).toHaveLength(2);
  });
});

describe("Single-query eager loading for detail views", () => {
  it("findOne with a joined to-many fires exactly one query", async () => {
    const { blogId } = await seed();
    const before = queryLogger.count;
    await joinedBlogs.findOne(blogId, { include: ["articles"] } as never);
    expect(queryLogger.count - before).toBe(1);
  });

  it("findOne with the same to-many left batched fires more than one query", async () => {
    const { blogId } = await seed();
    const before = queryLogger.count;
    await blogs.findOne(blogId, { include: ["articles"] } as never);
    expect(queryLogger.count - before).toBeGreaterThan(1);
  });
});

describe("TypeOrmRepositoryAdapter — key loading (issue #364)", () => {
  it("materializes a to-one as its FK id with no join and a constant query count", async () => {
    const { blogId } = await seed();
    const before = queryLogger.count;
    const list = await keyArticles.findMany({ include: ["blog"], sort: [{ field: "id", direction: "asc" }] });
    const fired = queryLogger.queries.slice(before);
    // No `leftJoinAndSelect` for the edge — the FK id comes from TypeORM's
    // own batched relation-id loader, never a row-multiplying join.
    expect(fired.some((sql) => /join/i.test(sql))).toBe(false);
    // One root query plus one batched relation-id query — nothing else.
    expect(fired).toHaveLength(2);
    // And that count is constant in the number of roots — never N+1.
    const twoRows = queryLogger.count;
    await dataSource.getRepository(Article).save({ title: "Third", blog: { id: blogId } as never });
    const marker = queryLogger.count;
    await keyArticles.findMany({ include: ["blog"] });
    expect(queryLogger.count - marker).toBe(twoRows - before);
    expect(list.items[0]).toMatchObject({ title: "Includes", blog: { id: blogId } });
    expect((list.items[0] as unknown as { blog: unknown }).blog).toEqual({ id: blogId });
  });

  it("serializes a null FK as null, not { id: null }", async () => {
    await dataSource.getRepository(Article).save({ title: "Orphan" });
    const list = await keyArticles.findMany({
      filter: { kind: "condition", field: "title" as never, operator: "EQ", value: "Orphan" },
      include: ["blog"],
    });
    expect((list.items[0] as { blog: unknown }).blog).toBeNull();
  });

  it("works on findOne with identical shape", async () => {
    const { articleId, blogId } = await seed();
    const item = await keyArticles.findOne(articleId, { include: ["blog"] } as never);
    expect(item).toMatchObject({ blog: { id: blogId } });
  });

  it("accepts select[blog]=id and rejects any other field", async () => {
    const { blogId } = await seed();
    const ok = await keyArticles.findMany({ include: ["blog"], select: { blog: ["id"] } as never });
    expect((ok.items[0] as { blog: unknown }).blog).toEqual({ id: blogId });
    await expect(
      keyArticles.findMany({ include: ["blog"], select: { blog: ["name"] } as never }),
    ).rejects.toMatchObject({
      issues: [{ field: "blog.name", code: "KAVO_QUERY_INVALID_FIELD" }],
    });
  });

  it("still resolves a filter on the key-edge path via its own join", async () => {
    await seed();
    const list = await keyArticles.findMany({
      include: ["blog"],
      filter: { kind: "condition", field: "blog.name" as never, operator: "EQ", value: "Kavo weekly" },
    });
    expect(list.items).toHaveLength(2);
    expect((list.items[0] as { blog: unknown }).blog).not.toBeNull();
  });

  it("resolves a key edge nested under a batched to-many parent", async () => {
    const { blogId } = await seed();
    const list = await nestedKeyBlogs.findMany({ include: ["articles", "articles.blog"] });
    const embedded = (list.items[0] as { articles: { blog: unknown }[] }).articles;
    expect(embedded).toHaveLength(2);
    for (const article of embedded) {
      expect(article.blog).toEqual({ id: blogId });
    }
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

describe("TypeOrmRepositoryAdapter — a batched to-one relation", () => {
  it("embeds the related row when there is one", async () => {
    const { blogId } = await seed();
    const list = await batchedArticles.findMany({
      include: ["blog"],
      sort: [{ field: "id", direction: "asc" }],
    });
    expect(list.items[0]).toMatchObject({ blog: { id: blogId } });
  });

  it("reports null, never undefined, when the foreign key is empty", async () => {
    // Core's serializer treats an absent key as "never hydrated" and omits
    // it; only an explicit `null` says "included, and there is nothing
    // there". A batched to-one with no match must produce the latter.
    await dataSource.getRepository(Article).save({ title: "Orphan", blog: null });

    const list = await batchedArticles.findMany({ include: ["blog"] });

    expect(list.items[0]).toHaveProperty("blog");
    expect((list.items[0] as { blog: unknown }).blog).toBeNull();
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
