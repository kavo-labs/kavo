import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Column, DataSource, Entity, PrimaryGeneratedColumn } from "typeorm";
import { NotFoundException, type DefaultKavoService, type KavoAppContext } from "@kavo/core";
import { createTypeOrmKavo } from "@kavo/typeorm";

/**
 * `filter.apply` (ADR-0048) is a mandatory row scope: a row outside it must
 * be as absent from an id-addressed read or write as it is from `findMany`.
 * The engine hands the scope to the adapter as `findOneById`'s
 * `query.filter`, so the adapter has to honour it there.
 */

@Entity()
class Memo {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  tenantId!: string;

  @Column("varchar")
  title!: string;
}

let dataSource: DataSource;
let memos: DefaultKavoService<Memo>;
let theirs: Memo;
const asTenantA = { app: { tenant: "A" } as KavoAppContext };

beforeAll(async () => {
  dataSource = new DataSource({ type: "better-sqlite3", database: ":memory:", entities: [Memo], synchronize: true });
  await dataSource.initialize();
  memos = createTypeOrmKavo(dataSource).createCrud(Memo, {
    filter: {
      apply: ({ context }: { context: { app: unknown } }) => ({
        kind: "condition",
        field: "tenantId",
        operator: "EQ",
        value: (context.app as { tenant: string }).tenant,
      }),
    },
  } as never) as DefaultKavoService<Memo>;
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Memo).clear();
  theirs = await dataSource.getRepository(Memo).save({ tenantId: "B", title: "secret" });
});

describe("TypeORM — filter.apply scopes every id-addressed operation", () => {
  it("answers findOne on another tenant's id with 404", async () => {
    await expect(memos.findOne(theirs.id as never, undefined, asTenantA)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("answers patchOne, updateOne and deleteOne on another tenant's id with 404 and leaves the row intact", async () => {
    await expect(memos.patchOne(theirs.id as never, { title: "x" } as never, asTenantA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      memos.updateOne(theirs.id as never, { tenantId: "B", title: "x" } as never, asTenantA),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(memos.deleteOne(theirs.id as never, asTenantA)).rejects.toBeInstanceOf(NotFoundException);
    expect(await dataSource.getRepository(Memo).findOneBy({ id: theirs.id })).toMatchObject({ title: "secret" });
  });

  it("still serves the caller's own row", async () => {
    const mine = await dataSource.getRepository(Memo).save({ tenantId: "A", title: "mine" });
    await expect(memos.findOne(mine.id as never, undefined, asTenantA)).resolves.toMatchObject({ title: "mine" });
    await expect(memos.patchOne(mine.id as never, { title: "edited" } as never, asTenantA)).resolves.toMatchObject({
      title: "edited",
    });
  });
});
