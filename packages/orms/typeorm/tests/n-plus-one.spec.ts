import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Column, DataSource, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import type { Logger } from "typeorm";
import type { DefaultKavoService, KavoInstance } from "@kavo/core";
import { createTypeOrmKavo } from "@kavo/typeorm";

/**
 * The query-count regression guard `docs/superpowers/plans/
 * 2026-08-24-test-coverage-roadmap.md` names as missing: `includes.spec.ts`
 * already proves a *single* joined/batched relation fires the query count
 * you'd expect for one root row, but nothing pins that the batch strategy's
 * whole reason to exist — flat query count as root cardinality grows —
 * actually holds. This file scales the root count up and asserts the query
 * count does not scale with it. `kavo-perf-auditor` checks this by eye at
 * review time; this is the same invariant enforced in CI.
 */
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
    // Default relation strategy is `auto`, which batches a to-many rather
    // than joining it — the case this whole file is about.
    include: { fields: ["articles"] },
  }) as DefaultKavoService<Blog>;
  kavo.createCrud(Article, {
    include: { fields: ["blog", "notes"] },
  });
  kavo.createCrud(Note, { include: { fields: ["article"] } });

  // Seed N blogs, each with M articles, each with K notes — the shape an
  // unbounded per-row loop would blow up on.
  const blogRepo = dataSource.getRepository(Blog);
  const articleRepo = dataSource.getRepository(Article);
  const noteRepo = dataSource.getRepository(Note);
  for (let b = 1; b <= 20; b++) {
    const blog = await blogRepo.save({ name: `Blog ${b}` });
    for (let a = 1; a <= 3; a++) {
      const article = await articleRepo.save({ title: `Article ${b}.${a}`, blog });
      for (let n = 1; n <= 2; n++) {
        await noteRepo.save({ body: `Note ${b}.${a}.${n}`, article });
      }
    }
  }
});

afterAll(async () => {
  await dataSource.destroy();
});

describe("Batched to-many includes: query count does not scale with root row count (N+1 regression)", () => {
  it("fires a constant number of queries for a page of 5 root rows with a batched to-many include", async () => {
    const before = queryLogger.count;
    const page = await blogs.findMany({ include: ["articles"], limit: 5 } as never);
    const afterFive = queryLogger.count - before;
    expect(page.items).toHaveLength(5);

    const before2 = queryLogger.count;
    const allTwenty = await blogs.findMany({ include: ["articles"], limit: 20 } as never);
    const afterTwenty = queryLogger.count - before2;
    expect(allTwenty.items).toHaveLength(20);

    // One root query + one `COUNT` for the envelope's `total` + one batch
    // query for the relation — three, regardless of how many roots came
    // back. A real N+1 would make `afterTwenty` scale with root count (21+
    // queries: the above plus one per-row relation fetch).
    expect(afterFive).toBe(3);
    expect(afterTwenty).toBe(3);
  });

  it("a two-level batched include (blog -> articles -> notes) still fires a constant, small number of queries", async () => {
    const before = queryLogger.count;
    const result = await blogs.findMany({
      include: ["articles", "articles.notes"],
      limit: 20,
    } as never);
    const fired = queryLogger.count - before;

    expect(result.items).toHaveLength(20);
    // Root blogs, the pagination `COUNT`, batched articles, batched notes:
    // one query per level (plus the one `COUNT`), never one query per row
    // at any level.
    expect(fired).toBe(4);
  });

  it("fires the same query count whether the page has 1 root row or 20", async () => {
    const before = queryLogger.count;
    await blogs.findMany({ include: ["articles"], limit: 1 } as never);
    const withOne = queryLogger.count - before;

    const before2 = queryLogger.count;
    await blogs.findMany({ include: ["articles"], limit: 20 } as never);
    const withTwenty = queryLogger.count - before2;

    expect(withOne).toBe(withTwenty);
  });
});
