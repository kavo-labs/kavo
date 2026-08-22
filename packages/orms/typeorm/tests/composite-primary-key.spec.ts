import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";
import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";
import { ConfigurationException, NotFoundException, type DefaultKavoService, type KavoInstance } from "@kavo/core";
import { createTypeOrmKavo } from "@kavo/typeorm";

/**
 * The motivating shape for issue #261: a join-table-style entity with a
 * natural composite key and no surrogate `id`, mirroring the `UserSentence`
 * example the issue was filed against — a `@ManyToOne` to a single-key
 * owner, plus two `@PrimaryColumn`s of its own.
 */
@Entity()
class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  name!: string;
}

@Entity()
class Grant {
  @PrimaryColumn("varchar")
  userId!: string;

  @PrimaryColumn("varchar")
  topic!: string;

  @Column("varchar")
  note!: string;

  @ManyToOne(() => Owner)
  @JoinColumn({ name: "owner_id" })
  owner!: Owner;
}

let dataSource: DataSource;
let kavo: KavoInstance;
let grants: DefaultKavoService<Grant>;
let owners: DefaultKavoService<Owner>;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Owner, Grant],
    synchronize: true,
  });
  await dataSource.initialize();
  kavo = createTypeOrmKavo(dataSource);
  owners = kavo.createCrud(Owner) as DefaultKavoService<Owner>;
  grants = kavo.createCrud(Grant) as DefaultKavoService<Grant>;
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Grant).clear();
  await dataSource.getRepository(Owner).clear();
});

describe("composite primary keys — @kavo/typeorm (issue #261)", () => {
  it("creates, reads, updates, patches, and deletes by the composite route id", async () => {
    const owner = await owners.createOne({ name: "Ada" } as never);

    const created = await grants.createOne({
      userId: "u1",
      topic: "billing",
      note: "initial",
      owner: { id: (owner as { id: number }).id },
    } as never);
    expect(created).toMatchObject({ userId: "u1", topic: "billing", note: "initial" });
    // No synthetic `id` field — the real key columns speak for themselves.
    expect(created).not.toHaveProperty("id");

    const routeId = "u1~billing";
    const fetched = await grants.findOne(routeId);
    expect(fetched).toMatchObject({ userId: "u1", topic: "billing", note: "initial" });

    const updated = await grants.updateOne(routeId, {
      userId: "u1",
      topic: "billing",
      note: "replaced",
    } as never);
    expect(updated).toMatchObject({ note: "replaced" });

    const patched = await grants.patchOne(routeId, { note: "patched" } as never);
    expect(patched).toMatchObject({ note: "patched", userId: "u1", topic: "billing" });

    await grants.deleteOne(routeId);
    await expect(grants.findOne(routeId)).rejects.toThrow(NotFoundException);
  });

  it("ignores an attempt to change the key columns through patch — they are creatable but not updatable", async () => {
    await grants.createOne({ userId: "u2", topic: "shipping", note: "n" } as never);
    const patched = await grants.patchOne("u2~shipping", { userId: "u2", topic: "renamed", note: "n2" } as never);
    // The default writable projection excludes composite key fields from
    // `updatable`, so `topic` in the body is silently dropped, not applied.
    expect(patched).toMatchObject({ userId: "u2", topic: "shipping", note: "n2" });
  });

  it("round-trips a key value containing the wire separator", async () => {
    await grants.createOne({ userId: "u~3", topic: "a~b", note: "n" } as never);
    const routeId = "u~~3~a~~b";
    const fetched = await grants.findOne(routeId);
    expect(fetched).toMatchObject({ userId: "u~3", topic: "a~b" });
  });

  it("finds many and filters/sorts normally (offset pagination is unaffected)", async () => {
    await grants.createOne({ userId: "u1", topic: "a", note: "1" } as never);
    await grants.createOne({ userId: "u1", topic: "b", note: "2" } as never);
    await grants.createOne({ userId: "u2", topic: "a", note: "3" } as never);
    const page = await grants.findMany({
      filter: { kind: "condition", field: "userId", operator: "EQ", value: "u1" },
    });
    expect(page.items).toHaveLength(2);
  });

  it("400s on a malformed route id rather than a driver error", async () => {
    await expect(grants.findOne("not-enough-parts")).rejects.toThrow();
  });

  it("rejects cursor pagination on the composite entity at bootstrap", () => {
    expect(() => kavo.createCrud(Grant, { pagination: { strategy: "cursor" } } as never)).toThrow(
      ConfigurationException,
    );
  });
});
