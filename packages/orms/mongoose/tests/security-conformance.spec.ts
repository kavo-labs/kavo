import { afterAll, beforeAll } from "vitest";
import { Schema, Types } from "mongoose";
import type { DefaultKavoService } from "@kavo/core";
import { createMongooseKavo } from "@kavo/mongoose";
import { defineSecuritySuite, engineDriver, vaultConfig, type VaultRow } from "kavo-security-testkit";
import { clearCollections, startTestDatabase, type TestDatabase } from "./support/database.js";

/**
 * The shared security conformance suite (#491) at the adapter layer: the
 * engine over `@kavo/mongoose` and a real (in-memory) MongoDB, no HTTP. A
 * Mongoose model's key is `_id`, so the entity runs `vaultConfig("_id")`.
 */
function defineModel(connection: TestDatabase["connection"]) {
  return connection.model(
    "Vault",
    new Schema({
      name: { type: String, required: true },
      tenant: { type: String, required: true },
      rank: { type: Number, default: 0 },
      apiKey: { type: String, default: null },
    }),
  );
}

let database: TestDatabase;
let VaultModel: ReturnType<typeof defineModel>;
let service: DefaultKavoService<object>;

beforeAll(async () => {
  database = await startTestDatabase();
  VaultModel = defineModel(database.connection);
  service = createMongooseKavo(database.connection).createCrud(
    VaultModel as never,
    vaultConfig("_id") as never,
  ) as DefaultKavoService<object>;
});

afterAll(async () => {
  await database.stop();
});

defineSecuritySuite({
  name: "@kavo/mongoose (engine, MongoDB)",
  reset: () => clearCollections(database.connection),
  driver: () => engineDriver(service),
  seed: async (rows) => (await VaultModel.insertMany(rows.map((row) => ({ ...row })))).map((doc) => String(doc._id)),
  read: async (id) => {
    const doc = await VaultModel.findById(String(id)).lean();
    return doc === null ? null : ({ ...doc, id: String(doc._id) } as unknown as VaultRow);
  },
  missingId: new Types.ObjectId().toHexString(),
  idField: "_id",
});
