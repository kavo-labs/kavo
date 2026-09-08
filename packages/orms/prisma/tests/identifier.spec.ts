import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundException, type DefaultKavoService, type KavoInstance } from "@kavo/core";
import { createPrismaKavo } from "@kavo/prisma";
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

let client: PrismaClient;
let kavo: KavoInstance;
let authors: DefaultKavoService<Author>;

beforeAll(() => {
  client = newTestPrismaClient();
  kavo = createPrismaKavo(client as never, {
    datamodel: Prisma.dmmf.datamodel,
    entities: [Author, Book],
    caseInsensitiveFilters: false,
  });
  authors = kavo.createCrud(Author, { identifier: { field: "email" } } as never) as DefaultKavoService<Author>;
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.book.deleteMany();
  await client.author.deleteMany();
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
});
