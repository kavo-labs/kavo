import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Schema } from "mongoose";
import { NotFoundException, type DefaultKavoService, type KavoAppContext } from "@kavo/core";
import { createMongooseKavo } from "@kavo/mongoose";
import { clearCollections, startTestDatabase, type TestDatabase } from "./support/database.js";

/**
 * `filter.apply` (ADR-0048) is a mandatory row scope: a row outside it must
 * be as absent from an id-addressed read or write as it is from `findMany`.
 * The engine hands the scope to the adapter as `findOneById`'s
 * `query.filter`, so the adapter has to honour it there.
 */

interface Memo {
  _id: string;
  tenantId: string;
  title: string;
}

function defineModel(connection: TestDatabase["connection"]) {
  return connection.model("Memo", new Schema({ tenantId: String, title: String }));
}

let database: TestDatabase;
let MemoModel: ReturnType<typeof defineModel>;
let memos: DefaultKavoService<Memo>;
const asTenantA = { app: { tenant: "A" } as KavoAppContext };

beforeAll(async () => {
  database = await startTestDatabase();
  MemoModel = defineModel(database.connection);
  memos = createMongooseKavo(database.connection).createCrud(
    MemoModel as never,
    {
      filter: {
        apply: ({ context }: { context: { app: unknown } }) => ({
          kind: "condition",
          field: "tenantId",
          operator: "EQ",
          value: (context.app as { tenant: string }).tenant,
        }),
      },
    } as never,
  ) as DefaultKavoService<Memo>;
});

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await clearCollections(database.connection);
});

describe("Mongoose — filter.apply scopes every id-addressed operation", () => {
  it("answers findOne, patchOne and deleteOne on another tenant's id with 404 and leaves the row intact", async () => {
    const theirs = String((await MemoModel.create({ tenantId: "B", title: "secret" }))._id);
    await expect(memos.findOne(theirs as never, undefined, asTenantA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(memos.patchOne(theirs as never, { title: "x" } as never, asTenantA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(memos.deleteOne(theirs as never, asTenantA)).rejects.toBeInstanceOf(NotFoundException);
    expect((await MemoModel.findById(theirs).lean()) as { title?: string } | null).toMatchObject({ title: "secret" });
  });

  it("still serves the caller's own row", async () => {
    const mine = String((await MemoModel.create({ tenantId: "A", title: "mine" }))._id);
    await expect(memos.findOne(mine as never, undefined, asTenantA)).resolves.toMatchObject({ title: "mine" });
  });
});
