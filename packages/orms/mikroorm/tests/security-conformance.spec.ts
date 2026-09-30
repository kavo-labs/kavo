import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import { MikroORM } from "@mikro-orm/core";
import { Entity, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";
import type { DefaultKavoService } from "@kavo/core";
import { createMikroOrmKavo } from "@kavo/mikroorm";
import { VAULT_CONFIG, defineSecuritySuite, engineDriver, type VaultRow } from "kavo-security-testkit";
import { clearDatabase, newTestOrm } from "./support/database.js";

/**
 * The shared security conformance suite (#491) at the adapter layer: the
 * engine over `@kavo/mikroorm` and a real SQLite database, no HTTP.
 */
@Entity()
class Vault {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  name!: string;

  @Property({ type: "string" })
  tenant!: string;

  @Property({ type: "number" })
  rank: number = 0;

  @Property({ type: "string", nullable: true })
  apiKey: string | null = null;
}

let orm: MikroORM;
let service: DefaultKavoService<Vault>;

beforeAll(async () => {
  orm = await newTestOrm([Vault]);
  service = createMikroOrmKavo(orm).createCrud(Vault, VAULT_CONFIG as never) as DefaultKavoService<Vault>;
});

afterAll(async () => {
  await orm.close();
});

defineSecuritySuite({
  name: "@kavo/mikroorm (engine, SQLite)",
  reset: () => clearDatabase(orm),
  driver: () => engineDriver(service),
  seed: async (rows) => {
    const em = orm.em.fork();
    const entities = rows.map((row) => em.create(Vault, { ...row } as never));
    await em.flush();
    return entities.map((entity) => (entity as Vault).id);
  },
  read: async (id) => (await orm.em.fork().findOne(Vault, { id: Number(id) })) as VaultRow | null,
  missingId: 999_999,
  knownGaps: {
    // MikroORM's LIKE carries no ESCAPE clause, so SQLite reads the
    // backslash core escapes a wildcard with as a literal (doc 17 §7).
    "search-escapes-wildcards": "#520",
  },
});
