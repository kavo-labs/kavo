import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataSource, Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { ConfigurationException, NotFoundException, type DefaultKavoService, type KavoInstance } from "@kavo/core";
import { createInfrastructure, createTypeOrmKavo } from "@kavo/typeorm";

/**
 * `identifier` config key (ADR-0052), `@kavo/typeorm` round-trip: `…One`
 * routes resolve against `slug` instead of the auto-increment `id` primary
 * key, while writes still key the storage row by `id` under the hood, and
 * association-by-id (ADR-0014) still targets the real PK.
 */

@Entity()
class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;
}

@Entity()
class Article {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  slug!: string;

  @Column("varchar")
  title!: string;

  @ManyToOne(() => Owner)
  @JoinColumn({ name: "owner_id" })
  owner!: Owner;
}

@Entity()
class Page {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  slug!: string;

  @Column("datetime", { nullable: true })
  deletedAt!: Date | null;
}

let dataSource: DataSource;
let kavo: KavoInstance;
let articles: DefaultKavoService<Article>;
let owners: DefaultKavoService<Owner>;
let pages: DefaultKavoService<Page>;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Owner, Article, Page],
    synchronize: true,
  });
  await dataSource.initialize();
  kavo = createTypeOrmKavo(dataSource);
  owners = kavo.createCrud(Owner) as DefaultKavoService<Owner>;
  articles = kavo.createCrud(Article, { identifier: { field: "slug" } } as never) as DefaultKavoService<Article>;
  pages = kavo.createCrud(Page, {
    identifier: { field: "slug" },
    delete: { field: "deletedAt", strategy: "soft" },
    // ADR-0038: declaring `operations` at all makes it an exclusive
    // whitelist, so every operation this test exercises must be named.
    operations: { createOne: true, findOne: true, deleteOne: true, restoreOne: true, purgeOne: true },
  } as never) as DefaultKavoService<Page>;
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Article).clear();
  await dataSource.getRepository(Owner).clear();
  await dataSource.getRepository(Page).clear();
});

describe("identifier config key — @kavo/typeorm (ADR-0052)", () => {
  it("resolves findOne/updateOne/patchOne/deleteOne by the configured field, not the primary key", async () => {
    const owner = await owners.createOne({ name: "Ada" } as never);
    const created = (await articles.createOne({
      slug: "hello-world",
      title: "Hello World",
      owner: { id: (owner as { id: number }).id },
    } as never)) as Article;
    expect(created.id).toBeGreaterThan(0);

    const found = await articles.findOne("hello-world" as never);
    expect(found).toMatchObject({ slug: "hello-world", title: "Hello World" });

    const updated = await articles.updateOne(
      "hello-world" as never,
      {
        slug: "hello-world",
        title: "Hello, World!",
        owner: { id: (owner as { id: number }).id },
      } as never,
    );
    expect(updated).toMatchObject({ title: "Hello, World!" });

    const patched = await articles.patchOne("hello-world" as never, { title: "Updated" } as never);
    expect(patched).toMatchObject({ title: "Updated", slug: "hello-world" });

    await articles.deleteOne("hello-world" as never);
    await expect(articles.findOne("hello-world" as never)).rejects.toThrow(NotFoundException);
  });

  it("404s a lookup by the real primary key value once 'identifier' is configured", async () => {
    const owner = await owners.createOne({ name: "Grace" } as never);
    const created = (await articles.createOne({
      slug: "second-post",
      title: "Second",
      owner: { id: (owner as { id: number }).id },
    } as never)) as Article;

    await expect(articles.findOne(String(created.id) as never)).rejects.toThrow(NotFoundException);
  });

  it("404s a deleteOne for a slug that doesn't exist, on a hard-delete entity", async () => {
    await expect(articles.deleteOne("no-such-slug" as never)).rejects.toThrow(NotFoundException);
  });

  it("soft-deletes, restores, and purges by the configured field, not the primary key", async () => {
    const created = (await pages.createOne({ slug: "about" } as never)) as Page;
    expect(created.id).toBeGreaterThan(0);

    await pages.deleteOne("about" as never);
    await expect(pages.findOne("about" as never)).rejects.toThrow(NotFoundException);

    const restored = await pages.restoreOne("about" as never);
    expect(restored).toMatchObject({ slug: "about" });
    await expect(pages.findOne("about" as never)).resolves.toMatchObject({ slug: "about" });

    await pages.deleteOne("about" as never);
    await pages.purgeOne("about" as never);
    await expect(pages.restoreOne("about" as never)).rejects.toThrow(NotFoundException);
  });

  it("byte-identical when called directly with no identifierField argument, like every pre-existing caller", async () => {
    const owner = await owners.createOne({ name: "Direct" } as never);
    const created = (await articles.createOne({
      slug: "direct-call",
      title: "Direct",
      owner: { id: (owner as { id: number }).id },
    } as never)) as Article;

    const writer = createInfrastructure(dataSource).adapterFor(Article);
    const context = { entityName: "Article", operation: "deleteOne", config: { delete: { strategy: "hard" } } };
    // No 4th argument — the same call every adapter method received before
    // `identifierField` existed, and must still behave exactly the same:
    // addressed by the real primary key, not the configured 'slug'.
    await writer.delete(created.id, context as never);
    await expect(articles.findOne("direct-call" as never)).rejects.toThrow(NotFoundException);
  });

  it("rejects 'identifier' on a composite-key entity at bootstrap", async () => {
    @Entity()
    class Membership {
      @Column("varchar", { primary: true })
      userId!: string;

      @Column("varchar", { primary: true })
      groupId!: string;

      @Column("varchar")
      role!: string;
    }
    const compositeDataSource = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Membership],
      synchronize: true,
    });
    await compositeDataSource.initialize();
    try {
      expect(() =>
        createTypeOrmKavo(compositeDataSource).createCrud(Membership, {
          identifier: { field: "role" },
        } as never),
      ).toThrow(ConfigurationException);
    } finally {
      await compositeDataSource.destroy();
    }
  });
});
