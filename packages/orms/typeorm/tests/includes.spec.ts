import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Column, DataSource, DeleteDateColumn, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import type { Logger } from "typeorm";
import type { KavoInstance, DefaultKavoService } from "@kavo/core";
import { createTypeOrmKavo } from "@kavo/typeorm";

/** Counts SELECT statements so a test can assert "exactly one query fired". */
class QueryCountingLogger implements Logger {
  count = 0;
  logQuery(): void {
    this.count += 1;
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
    allowlists: { includable: ["articles"] },
  }) as DefaultKavoService<Blog>;
  articles = kavo.createCrud(Article, {
    softDelete: { strategy: "soft" },
    allowlists: {
      includable: ["blog", "notes"],
      // Filtering across a relation path is its own allowlist decision,
      // independent of whether the relation may be included.
      filterable: ["id", "title", "blog.name"],
    },
  } as never) as DefaultKavoService<Article>;
  kavo.createCrud(Note, { allowlists: { includable: ["article"] } });
  // The same entity with the to-many forced to `join`: the case the
  // normative pagination rule exists for.
  joinedBlogs = createTypeOrmKavo(dataSource).createCrud(Blog, {
    allowlists: { includable: ["articles"] },
    relations: { edges: { articles: { strategy: "join" } } },
  }) as DefaultKavoService<Blog>;
  // A *to-one* forced to `batch`. Left on `auto` a to-one joins, so the
  // batched to-one path only exists when a config asks for it.
  batchedArticles = createTypeOrmKavo(dataSource).createCrud(Article, {
    softDelete: { strategy: "soft" },
    allowlists: { includable: ["blog"] },
    relations: { edges: { blog: { strategy: "batch" } } },
  } as never) as DefaultKavoService<Article>;
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
      fields: { root: ["id", "name"], relations: { articles: ["title"] } },
    });
    expect(list.items[0]).toEqual({
      id: expect.any(Number),
      name: "Kavo weekly",
      articles: [{ title: "Includes" }, { title: "Soft delete" }],
    });
  });
});
