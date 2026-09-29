import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Column, DataSource, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import type { DefaultKavoService, KavoInstance } from "@kavo/core";
import { createTypeOrmKavo } from "@kavo/typeorm";

/**
 * GHSA-p8cm-xwp6-gvrc: a write to a parent row that names a to-many relation
 * (`{ articles: [{ id: X }] }`) reassigns row X's foreign key, and the policy
 * stage only ever judges the parent — so X's own policy never runs. To-many
 * association is now opt-in (`relations.<name>.write`), so the derived write
 * shape no longer carries it; an app that opts in has chosen that surface.
 */

@Entity()
class GuardBlog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;

  @Column("varchar")
  ownerId!: string;

  @OneToMany(() => GuardArticle, (article) => article.blog)
  articles!: GuardArticle[];
}

@Entity()
class GuardArticle {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  title!: string;

  @Column("varchar")
  ownerId!: string;

  @ManyToOne(() => GuardBlog, (blog) => blog.articles, { nullable: true })
  blog!: GuardBlog | null;
}

const ownerOnly = ({ context, entity }: { context: { app: { userId?: string } }; entity?: { ownerId: string } }) =>
  entity?.ownerId === context.app.userId;
const asAttacker = { app: { userId: "attacker" } } as never;

let dataSource: DataSource;
let kavo: KavoInstance;
let victimBlog: GuardBlog;
let victimArticle: GuardArticle;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [GuardBlog, GuardArticle],
    synchronize: true,
  });
  await dataSource.initialize();
  kavo = createTypeOrmKavo(dataSource);
  kavo.createCrud(GuardArticle, {
    operations: {
      findOne: true,
      updateOne: { policy: ownerOnly },
      patchOne: { policy: ownerOnly },
    },
  } as never);
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(GuardArticle).clear();
  await dataSource.query("DELETE FROM guard_blog");
  victimBlog = await dataSource.getRepository(GuardBlog).save({ name: "Victim", ownerId: "victim" });
  victimArticle = await dataSource
    .getRepository(GuardArticle)
    .save({ title: "Victim's", ownerId: "victim", blog: victimBlog });
});

async function articleBlogId(): Promise<number | null> {
  const [row] = (await dataSource.query("SELECT blogId FROM guard_article WHERE id = ?", [victimArticle.id])) as {
    blogId: number | null;
  }[];
  return row?.blogId ?? null;
}

function blogsService(config: object = {}): DefaultKavoService<GuardBlog> {
  return kavo.createCrud(GuardBlog, {
    ...config,
    operations: { createOne: true, findOne: true, updateOne: true, patchOne: { policy: ownerOnly } },
  } as never) as DefaultKavoService<GuardBlog>;
}

describe("to-many association does not bypass the related entity's policy (GHSA-p8cm-xwp6-gvrc)", () => {
  it("does not let a patch of the caller's own parent row reassign a related row they cannot write", async () => {
    const blogs = blogsService();
    const own = await dataSource.getRepository(GuardBlog).save({ name: "Mine", ownerId: "attacker" });

    await blogs.patchOne(own.id, { name: "Mine", articles: [{ id: victimArticle.id }] } as never, asAttacker);

    expect(await articleBlogId()).toBe(victimBlog.id);
  });

  it("does not let a create of a new parent row take over a related row the caller cannot write", async () => {
    const blogs = blogsService();

    await blogs.createOne(
      { name: "Grab", ownerId: "attacker", articles: [{ id: victimArticle.id }] } as never,
      asAttacker,
    );

    expect(await articleBlogId()).toBe(victimBlog.id);
  });

  it("still associates a to-one relation by default", async () => {
    const articles = kavo.createCrud(GuardArticle, {
      operations: { createOne: true, findOne: true },
    } as never) as DefaultKavoService<GuardArticle>;
    const created = (await articles.createOne(
      { title: "Linked", ownerId: "victim", blog: { id: victimBlog.id } } as never,
      asAttacker,
    )) as GuardArticle;
    const [row] = (await dataSource.query("SELECT blogId FROM guard_article WHERE id = ?", [created.id])) as {
      blogId: number;
    }[];
    expect(row?.blogId).toBe(victimBlog.id);
  });

  it("associates a to-many relation once the app opts it in with relations.<name>.write", async () => {
    const blogs = blogsService({ relations: { articles: { write: { strategy: "replace" } } } });
    const own = await dataSource.getRepository(GuardBlog).save({ name: "Mine", ownerId: "attacker" });

    await blogs.patchOne(own.id, { articles: [{ id: victimArticle.id }] } as never, asAttacker);

    expect(await articleBlogId()).toBe(own.id);
  });
});
