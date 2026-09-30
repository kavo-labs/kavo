import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "../prisma/generated/client/client.js";
import { NotFoundException, type DefaultKavoService, type KavoAppContext } from "@kavo/core";
import { createPrismaKavo } from "@kavo/prisma";
import { newTestPrismaClient } from "./support/client.js";
import { testMetadata } from "./support/datamodel.js";

/**
 * `filter.apply` (ADR-0048) is a mandatory row scope: a row outside it must
 * be as absent from an id-addressed read or write as it is from `findMany`.
 * The engine hands the scope to the adapter as `findOneById`'s
 * `query.filter`, so the adapter has to honour it there. `status` stands in
 * for a tenant column.
 */

class Author {
  id!: number;
  email!: string;
  name!: string;
  age!: number;
  status!: string;
}

let client: PrismaClient;
let authors: DefaultKavoService<Author>;
const asTenantA = { app: { tenant: "A" } as KavoAppContext };

beforeAll(() => {
  client = newTestPrismaClient();
  authors = createPrismaKavo(client as never, {
    metadata: testMetadata,
    entities: [Author],
    caseInsensitiveFilters: false,
  }).createCrud(Author, {
    filter: {
      apply: ({ context }: { context: { app: unknown } }) => ({
        kind: "condition",
        field: "status",
        operator: "EQ",
        value: (context.app as { tenant: string }).tenant,
      }),
    },
  } as never) as DefaultKavoService<Author>;
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.book.deleteMany();
  await client.author.deleteMany();
});

describe("Prisma — filter.apply scopes every id-addressed operation", () => {
  it("answers findOne, patchOne and deleteOne on another tenant's id with 404 and leaves the row intact", async () => {
    const theirs = await client.author.create({ data: { email: "b@x", name: "secret", age: 1, status: "B" } });
    await expect(authors.findOne(theirs.id as never, undefined, asTenantA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(authors.patchOne(theirs.id as never, { name: "x" } as never, asTenantA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(authors.deleteOne(theirs.id as never, asTenantA)).rejects.toBeInstanceOf(NotFoundException);
    expect(await client.author.findUnique({ where: { id: theirs.id } })).toMatchObject({ name: "secret" });
  });

  it("still serves the caller's own row", async () => {
    const mine = await client.author.create({ data: { email: "a@x", name: "mine", age: 1, status: "A" } });
    await expect(authors.findOne(mine.id as never, undefined, asTenantA)).resolves.toMatchObject({ name: "mine" });
  });
});
