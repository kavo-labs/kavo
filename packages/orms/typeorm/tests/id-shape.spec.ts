import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from "typeorm";
import { QueryValidationException, type DefaultKavoService } from "@kavo/core";
import { createTypeOrmKavo } from "@kavo/typeorm";

/**
 * `Repository.delete(criteria)` treats an object as a WHERE clause, so an
 * object id reaching the adapter's hard delete would remove every row it
 * matches. The engine refuses a non-scalar id first; this pins that end to
 * end against a real TypeORM repository.
 */

@Entity()
class Ledger {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  tenant!: string;
}

let dataSource: DataSource;
let ledgers: DefaultKavoService<Ledger>;

beforeAll(async () => {
  dataSource = new DataSource({ type: "better-sqlite3", database: ":memory:", entities: [Ledger], synchronize: true });
  await dataSource.initialize();
  ledgers = createTypeOrmKavo(dataSource).createCrud(Ledger) as DefaultKavoService<Ledger>;
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Ledger).clear();
  await dataSource.getRepository(Ledger).save([{ tenant: "a" }, { tenant: "b" }, { tenant: "b" }]);
});

describe("TypeORM — an object id is never delete or update criteria", () => {
  it("rejects deleteOne with an object id and deletes nothing", async () => {
    await expect(ledgers.deleteOne({ tenant: "b" } as never)).rejects.toBeInstanceOf(QueryValidationException);
    expect(await dataSource.getRepository(Ledger).count()).toBe(3);
  });

  it("rejects patchOne and updateOne with an object id and writes nothing", async () => {
    await expect(ledgers.patchOne({ tenant: "b" } as never, { tenant: "z" } as never)).rejects.toBeInstanceOf(
      QueryValidationException,
    );
    await expect(ledgers.updateOne({ tenant: "b" } as never, { tenant: "z" } as never)).rejects.toBeInstanceOf(
      QueryValidationException,
    );
    expect(await dataSource.getRepository(Ledger).countBy({ tenant: "z" })).toBe(0);
  });
});
