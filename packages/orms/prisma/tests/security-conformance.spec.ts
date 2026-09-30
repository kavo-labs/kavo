import { afterAll, beforeAll } from "vitest";
import { type PrismaClient } from "../prisma/generated/client/client.js";
import type { DefaultKavoService } from "@kavo/core";
import { createPrismaKavo } from "@kavo/prisma";
import { VAULT_CONFIG, defineSecuritySuite, engineDriver } from "kavo-security-testkit";
import { newTestPrismaClient } from "./support/client.js";
import { testMetadata } from "./support/datamodel.js";

/**
 * The shared security conformance suite (#491) at the adapter layer: the
 * engine over `@kavo/prisma` and a real SQLite database, no HTTP. The
 * `Vault` model is declared in `prisma/schema.prisma`.
 */
class Vault {
  id!: number;
  name!: string;
  tenant!: string;
  rank!: number;
  apiKey!: string | null;
}

let client: PrismaClient;
let service: DefaultKavoService<Vault>;

beforeAll(() => {
  client = newTestPrismaClient();
  service = createPrismaKavo(client as never, {
    metadata: testMetadata,
    entities: [Vault],
    caseInsensitiveFilters: false,
  }).createCrud(Vault, VAULT_CONFIG as never) as DefaultKavoService<Vault>;
});

afterAll(async () => {
  await client.$disconnect();
});

defineSecuritySuite({
  name: "@kavo/prisma (engine, SQLite)",
  reset: async () => {
    await client.vault.deleteMany();
  },
  driver: () => engineDriver(service),
  seed: async (rows) => {
    const ids: number[] = [];
    for (const row of rows) {
      ids.push((await client.vault.create({ data: { ...row } })).id);
    }
    return ids;
  },
  read: async (id) => client.vault.findUnique({ where: { id: Number(id) } }),
  missingId: 999_999,
});
