import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MikroORM } from "@mikro-orm/core";
import { Entity, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";
import { NotFoundException, type DefaultKavoService, type KavoAppContext } from "@kavo/core";
import { createMikroOrmKavo } from "@kavo/mikroorm";
import { clearDatabase, newTestOrm } from "./support/database.js";

/**
 * `filter.apply` (ADR-0048) is a mandatory row scope: a row outside it must
 * be as absent from an id-addressed read or write as it is from `findMany`.
 * The engine hands the scope to the adapter as `findOneById`'s
 * `query.filter`, so the adapter has to honour it there.
 */

@Entity()
class Memo {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  tenantId!: string;

  @Property({ type: "string" })
  title!: string;
}

let orm: MikroORM;
let memos: DefaultKavoService<Memo>;
const asTenantA = { app: { tenant: "A" } as KavoAppContext };

async function seed(tenantId: string, title: string): Promise<number> {
  const em = orm.em.fork();
  const row = em.create(Memo, { tenantId, title } as never);
  await em.flush();
  return (row as Memo).id;
}

async function titleOf(id: number): Promise<string | undefined> {
  return (await orm.em.fork().findOne(Memo, { id }))?.title;
}

beforeAll(async () => {
  orm = await newTestOrm([Memo]);
  memos = createMikroOrmKavo(orm).createCrud(Memo, {
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
  await orm.close();
});

beforeEach(async () => {
  await clearDatabase(orm);
});

describe("MikroORM — filter.apply scopes every id-addressed operation", () => {
  it("answers findOne, patchOne and deleteOne on another tenant's id with 404 and leaves the row intact", async () => {
    const theirs = await seed("B", "secret");
    await expect(memos.findOne(theirs as never, undefined, asTenantA)).rejects.toBeInstanceOf(NotFoundException);
    await expect(memos.patchOne(theirs as never, { title: "x" } as never, asTenantA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(memos.deleteOne(theirs as never, asTenantA)).rejects.toBeInstanceOf(NotFoundException);
    expect(await titleOf(theirs)).toBe("secret");
  });

  it("still serves the caller's own row", async () => {
    const mine = await seed("A", "mine");
    await expect(memos.findOne(mine as never, undefined, asTenantA)).resolves.toMatchObject({ title: "mine" });
  });
});
