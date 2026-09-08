import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundException, type DefaultKavoService, type KavoInstance, type RepositoryAdapter } from "@kavo/core";
import { createInfrastructure, createPrismaKavo } from "@kavo/prisma";
import { newTestPrismaClient } from "./support/client.js";

/**
 * `identifier` config key (ADR-0052), `@kavo/prisma` round-trip: `…One`
 * routes resolve against `email` instead of the `id` primary key, while
 * everything else (association-by-id, in particular) still addresses `id`.
 */

class Author {
  id!: number;
  email!: string;
  name!: string;
  age!: number;
  status!: string;
  bio!: string | null;
  role!: string;
  createdAt!: Date;
  books?: Book[];
}

class Book {
  id!: number;
  title!: string;
  authorId!: number | null;
}

class Article {
  id!: number;
  title!: string;
  blogId!: number | null;
  deletedAt!: Date | null;
}

let client: PrismaClient;
let kavo: KavoInstance;
let authors: DefaultKavoService<Author>;
let articles: DefaultKavoService<Article>;

beforeAll(() => {
  client = newTestPrismaClient();
  kavo = createPrismaKavo(client as never, {
    datamodel: Prisma.dmmf.datamodel,
    entities: [Author, Book, Article],
    caseInsensitiveFilters: false,
  });
  authors = kavo.createCrud(Author, { identifier: { field: "email" } } as never) as DefaultKavoService<Author>;
  articles = kavo.createCrud(Article, {
    identifier: { field: "title" },
    delete: { field: "deletedAt", strategy: "soft" },
    // ADR-0038: declaring `operations` at all makes it an exclusive
    // whitelist, so every operation this suite exercises must be named.
    operations: { createOne: true, findOne: true, deleteOne: true, restoreOne: true, purgeOne: true },
  } as never) as DefaultKavoService<Article>;
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.book.deleteMany();
  await client.author.deleteMany();
  await client.article.deleteMany();
});

describe("identifier config key — @kavo/prisma (ADR-0052)", () => {
  it("resolves findOne/updateOne/patchOne/deleteOne by the configured field, not the primary key", async () => {
    const created = (await authors.createOne({
      email: "ada@x.io",
      name: "Ada",
      age: 36,
      status: "active",
    } as never)) as Author;
    expect(created.id).toBeGreaterThan(0);

    const found = await authors.findOne("ada@x.io" as never);
    expect(found).toMatchObject({ email: "ada@x.io", name: "Ada" });

    const updated = await authors.updateOne(
      "ada@x.io" as never,
      {
        email: "ada@x.io",
        name: "Ada Lovelace",
        age: 37,
        status: "active",
      } as never,
    );
    expect(updated).toMatchObject({ name: "Ada Lovelace", age: 37 });

    const patched = await authors.patchOne("ada@x.io" as never, { age: 38 } as never);
    expect(patched).toMatchObject({ age: 38 });

    await authors.deleteOne("ada@x.io" as never);
    await expect(authors.findOne("ada@x.io" as never)).rejects.toThrow(NotFoundException);
  });

  it("still associates relations by the real primary key, not the configured identifier", async () => {
    const created = (await authors.createOne({
      email: "grace@x.io",
      name: "Grace",
      age: 45,
      status: "active",
    } as never)) as Author;

    const book = await client.book.create({ data: { title: "Notes", authorId: created.id } });
    expect(book.authorId).toBe(created.id);
  });

  it("404s a lookup by the real primary key value once 'identifier' is configured", async () => {
    const created = (await authors.createOne({
      email: "alan@x.io",
      name: "Alan",
      age: 41,
      status: "active",
    } as never)) as Author;

    await expect(authors.findOne(String(created.id) as never)).rejects.toThrow(NotFoundException);
  });

  it("soft-deletes, restores, and purges by the configured field, not the primary key", async () => {
    const created = (await articles.createOne({ title: "hello-world" } as never)) as Article;
    expect(created.id).toBeGreaterThan(0);

    await articles.deleteOne("hello-world" as never);
    await expect(articles.findOne("hello-world" as never)).rejects.toThrow(NotFoundException);

    const restored = await articles.restoreOne("hello-world" as never);
    expect(restored).toMatchObject({ title: "hello-world" });
    await expect(articles.findOne("hello-world" as never)).resolves.toMatchObject({ title: "hello-world" });

    await articles.deleteOne("hello-world" as never);
    await articles.purgeOne("hello-world" as never);
    await expect(articles.restoreOne("hello-world" as never)).rejects.toThrow(NotFoundException);
  });

  it("byte-identical when called directly with no identifierField argument, like every pre-existing caller", async () => {
    const created = (await authors.createOne({
      email: "direct-call@x.io",
      name: "Direct",
      age: 30,
      status: "active",
    } as never)) as Author;

    const writer = createInfrastructure(client as never, {
      datamodel: Prisma.dmmf.datamodel,
      entities: [Author, Book, Article],
      caseInsensitiveFilters: false,
    }).adapterFor(Author) as RepositoryAdapter<Author>;
    const context = { entityName: "Author", operation: "findOne", config: { delete: { strategy: "hard" } } };
    // No 4th argument on any of these — the same call every adapter method
    // received before `identifierField` existed, and must still behave
    // exactly the same: addressed by the real primary key, not 'email'.
    const found = await writer.findOneById(created.id, null, context as never);
    expect(found).toMatchObject({ email: "direct-call@x.io" });

    await writer.update(
      created.id,
      { name: "Updated directly" } as never,
      {
        ...context,
        operation: "updateOne",
      } as never,
    );
    await expect(authors.findOne("direct-call@x.io" as never)).resolves.toMatchObject({ name: "Updated directly" });

    await writer.delete(created.id, { ...context, operation: "deleteOne" } as never);
    await expect(authors.findOne("direct-call@x.io" as never)).rejects.toThrow(NotFoundException);
  });
});
