import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from "typeorm";
import type { DefaultKavoService } from "@kavo/core";
import { createTypeOrmKavo } from "@kavo/typeorm";
import { VAULT_CONFIG, defineSecuritySuite, engineDriver } from "kavo-security-testkit";

/**
 * The shared security conformance suite (#491) at the adapter layer: the
 * engine over `@kavo/typeorm` and a real SQLite database, no HTTP.
 */
@Entity()
class Vault {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;

  @Column("varchar")
  tenant!: string;

  @Column({ type: "integer", default: 0 })
  rank!: number;

  @Column({ type: "varchar", nullable: true })
  apiKey!: string | null;
}

let dataSource: DataSource;
let service: DefaultKavoService<Vault>;

beforeAll(async () => {
  dataSource = new DataSource({ type: "better-sqlite3", database: ":memory:", entities: [Vault], synchronize: true });
  await dataSource.initialize();
  service = createTypeOrmKavo(dataSource).createCrud(Vault, VAULT_CONFIG as never) as DefaultKavoService<Vault>;
});

afterAll(async () => {
  await dataSource.destroy();
});

defineSecuritySuite({
  name: "@kavo/typeorm (engine, SQLite)",
  reset: async () => {
    await dataSource.getRepository(Vault).clear();
  },
  driver: () => engineDriver(service),
  seed: async (rows) =>
    (await dataSource.getRepository(Vault).save(rows.map((row) => ({ ...row })))).map((row) => row.id),
  read: async (id) => dataSource.getRepository(Vault).findOneBy({ id: Number(id) }),
  missingId: 999_999,
});
