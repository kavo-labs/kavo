import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MikroORM } from "@mikro-orm/core";
import { Entity, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";
import { ConfigurationException, NotFoundException, type DefaultKavoService, type RepositoryAdapter } from "@kavo/core";
import { createInfrastructure, createMikroOrmKavo } from "@kavo/mikroorm";
import { clearDatabase, newTestOrm } from "./support/database.js";

/**
 * `identifier` config key (ADR-0052), `@kavo/mikroorm` round-trip: `…One`
 * routes resolve against `slug`/`email` instead of the primary key.
 */

@Entity()
class Article {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  slug!: string;

  @Property({ type: "string" })
  title!: string;
}

@Entity()
class Page {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  slug!: string;

  @Property({ type: "Date", nullable: true })
  deletedAt: Date | null = null;
}

let orm: MikroORM;
let articles: DefaultKavoService<Article>;
let pages: DefaultKavoService<Page>;

beforeAll(async () => {
  orm = await newTestOrm([Article, Page]);
  const kavo = createMikroOrmKavo(orm);
  articles = kavo.createCrud(Article, { identifier: { field: "slug" } } as never) as DefaultKavoService<Article>;
  pages = kavo.createCrud(Page, {
    identifier: { field: "slug" },
    delete: { field: "deletedAt", strategy: "soft" },
    // ADR-0038: declaring `operations` at all makes it an exclusive
    // whitelist, so every operation this suite exercises must be named.
    operations: { createOne: true, findOne: true, deleteOne: true, restoreOne: true, purgeOne: true },
  } as never) as DefaultKavoService<Page>;
});

afterAll(async () => {
  await orm.close();
});

beforeEach(async () => {
  await clearDatabase(orm);
});

describe("identifier config key — @kavo/mikroorm (ADR-0052)", () => {
  it("resolves findOne/updateOne/patchOne/deleteOne by the configured field, not the primary key", async () => {
    const created = (await articles.createOne({ slug: "hello-world", title: "Hello World" } as never)) as Article;
    expect(created.id).toBeGreaterThan(0);

    const found = await articles.findOne("hello-world" as never);
    expect(found).toMatchObject({ slug: "hello-world", title: "Hello World" });

    const updated = await articles.updateOne(
      "hello-world" as never,
      {
        slug: "hello-world",
        title: "Hello, World!",
      } as never,
    );
    expect(updated).toMatchObject({ title: "Hello, World!" });

    const patched = await articles.patchOne("hello-world" as never, { title: "Updated" } as never);
    expect(patched).toMatchObject({ title: "Updated", slug: "hello-world" });

    await articles.deleteOne("hello-world" as never);
    await expect(articles.findOne("hello-world" as never)).rejects.toThrow(NotFoundException);
  });

  it("404s a lookup by the real primary key value once 'identifier' is configured", async () => {
    const created = (await articles.createOne({ slug: "second-post", title: "Second" } as never)) as Article;
    await expect(articles.findOne(String(created.id) as never)).rejects.toThrow(NotFoundException);
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
    const created = (await articles.createOne({ slug: "direct-call", title: "Direct" } as never)) as Article;

    const writer = createInfrastructure(orm).adapterFor(Article) as RepositoryAdapter<Article>;
    const context = { entityName: "Article", operation: "findOne", config: { delete: { strategy: "hard" } } };
    // No 4th argument on any of these — the same call every adapter method
    // received before `identifierField` existed, and must still behave
    // exactly the same: addressed by the real primary key, not 'slug'.
    const found = await writer.findOneById(created.id, null, context as never);
    expect(found).toMatchObject({ slug: "direct-call" });

    await writer.update(
      created.id,
      { slug: "direct-call", title: "Updated directly" } as never,
      {
        ...context,
        operation: "updateOne",
      } as never,
    );
    await expect(articles.findOne("direct-call" as never)).resolves.toMatchObject({ title: "Updated directly" });

    await writer.delete(created.id, { ...context, operation: "deleteOne" } as never);
    await expect(articles.findOne("direct-call" as never)).rejects.toThrow(NotFoundException);
  });

  it("restore is also byte-identical when called directly with no identifierField argument", async () => {
    const created = (await pages.createOne({ slug: "restore-direct" } as never)) as Page;
    await pages.deleteOne("restore-direct" as never);

    const writer = createInfrastructure(orm).adapterFor(Page) as RepositoryAdapter<Page>;
    const context = {
      entityName: "Page",
      operation: "restoreOne",
      config: { delete: { field: "deletedAt", strategy: "soft" } },
    };
    const restored = await writer.restore(created.id, context as never);
    expect(restored).toMatchObject({ slug: "restore-direct" });
  });

  it("rejects an adapter that never implements supportsIdentifierField", () => {
    // MikroORM's own adapter always implements it — the rejection path is
    // covered generically in packages/core/tests/identifier-config.spec.ts,
    // which is where a non-implementing fake adapter lives. This just pins
    // that @kavo/mikroorm itself never regresses back to "unsupported".
    const adapter = createInfrastructure(orm).adapterFor(Article) as RepositoryAdapter<Article>;
    expect(adapter.supportsIdentifierField?.("slug")).toBe(true);
  });

  it("rejects an unknown field name at bootstrap", () => {
    const kavo = createMikroOrmKavo(orm);
    expect(() => kavo.createCrud(Article, { identifier: { field: "nope" } } as never)).toThrow(ConfigurationException);
  });
});
