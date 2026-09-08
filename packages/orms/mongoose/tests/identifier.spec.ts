import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Schema } from "mongoose";
import { NotFoundException, type DefaultKavoService, type KavoInstance } from "@kavo/core";
import { createMongooseKavo } from "@kavo/mongoose";
import { clearCollections, startTestDatabase, type TestDatabase } from "./support/database.js";

/**
 * `identifier` config key (ADR-0052), `@kavo/mongoose` round-trip: `…One`
 * routes resolve against `email` instead of the document's `_id`.
 */

interface Author {
  _id: string;
  email: string;
  name: string;
}

function defineModels(connection: TestDatabase["connection"]) {
  return {
    Author: connection.model(
      "Author",
      new Schema({ email: { type: String, required: true, unique: true }, name: String }),
    ),
  };
}

let database: TestDatabase;
let models: ReturnType<typeof defineModels>;
let kavo: KavoInstance;
let authors: DefaultKavoService<Author>;

beforeAll(async () => {
  database = await startTestDatabase();
  models = defineModels(database.connection);
  kavo = createMongooseKavo(database.connection);
  authors = kavo.createCrud(
    models.Author as never,
    { identifier: { field: "email" } } as never,
  ) as DefaultKavoService<Author>;
});

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await clearCollections(database.connection);
});

describe("identifier config key — @kavo/mongoose (ADR-0052)", () => {
  it("resolves findOne/updateOne/patchOne/deleteOne by the configured field, not _id", async () => {
    const created = (await authors.createOne({ email: "ada@x.io", name: "Ada" } as never)) as Author;
    expect(created._id).toBeDefined();

    const found = await authors.findOne("ada@x.io" as never);
    expect(found).toMatchObject({ email: "ada@x.io", name: "Ada" });

    const updated = await authors.updateOne(
      "ada@x.io" as never,
      {
        email: "ada@x.io",
        name: "Ada Lovelace",
      } as never,
    );
    expect(updated).toMatchObject({ name: "Ada Lovelace" });

    const patched = await authors.patchOne("ada@x.io" as never, { name: "AL" } as never);
    expect(patched).toMatchObject({ name: "AL" });

    await authors.deleteOne("ada@x.io" as never);
    await expect(authors.findOne("ada@x.io" as never)).rejects.toThrow(NotFoundException);
  });

  it("404s a lookup by the real _id value once 'identifier' is configured", async () => {
    const created = (await authors.createOne({ email: "grace@x.io", name: "Grace" } as never)) as Author;
    await expect(authors.findOne(created._id as never)).rejects.toThrow(NotFoundException);
  });
});
