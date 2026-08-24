import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Column, DataSource, DeleteDateColumn, Entity, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";
import {
  AlreadyDeletedException,
  ConfigurationException,
  ConflictException,
  NotDeletedException,
  NotFoundException,
  PatchNoChangesException,
  type DefaultKavoService,
} from "@kavo/core";
import { buildEntityMetadata, createInfrastructure, createTypeOrmKavo } from "@kavo/typeorm";

/** Soft delete the ORM-declared way: one `@DeleteDateColumn`. */
@Entity()
class Ticket {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar", { unique: true })
  reference!: string;

  @Column("varchar")
  title!: string;

  @DeleteDateColumn()
  deletedAt!: Date | null;
}

/** Soft delete over an ordinary column, named through config instead. */
@Entity()
class Invoice {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  number!: string;

  @Column("datetime", { nullable: true })
  archivedAt!: Date | null;
}

/** No delete column at all: rows go away when deleted. */
@Entity()
class Receipt {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column("varchar")
  number!: string;
}

/** An app-assigned (non-generated) primary key, and a soft-delete marker
 * configured over an ordinary column — the shape that lets a client rewrite
 * a row's identity or deleted state unless the deserializer and the
 * adapter's own defence in depth both exclude it. */
@Entity()
class Coupon {
  @PrimaryColumn("varchar")
  code!: string;

  @Column("varchar")
  label!: string;

  @Column("datetime", { nullable: true })
  retiredAt!: Date | null;
}

/** Names the id and the configured marker explicitly — the opt-in an
 * explicit write DTO is still allowed to make. */
class UpdateCouponDto {
  code = "";
  label = "";
  retiredAt: Date | null = null;
}

let dataSource: DataSource;
let tickets: DefaultKavoService<Ticket>;
let invoices: DefaultKavoService<Invoice>;
let receipts: DefaultKavoService<Receipt>;
let coupons: DefaultKavoService<Coupon>;

beforeAll(async () => {
  dataSource = new DataSource({
    type: "better-sqlite3",
    database: ":memory:",
    entities: [Ticket, Invoice, Receipt, Coupon],
    synchronize: true,
  });
  await dataSource.initialize();
  const kavo = createTypeOrmKavo(dataSource);
  tickets = kavo.createCrud(Ticket, {
    softDelete: { strategy: "soft" },
    operations: {
      createOne: true,
      deleteOne: true,
      findMany: true,
      findOne: true,
      patchOne: true,
      restoreOne: true,
      purgeOne: true,
    },
  }) as DefaultKavoService<Ticket>;
  invoices = kavo.createCrud(Invoice, {
    softDelete: { field: "archivedAt" },
  }) as DefaultKavoService<Invoice>;
  receipts = kavo.createCrud(Receipt) as DefaultKavoService<Receipt>;
  coupons = kavo.createCrud(Coupon, {
    softDelete: { field: "retiredAt" },
    dto: { create: UpdateCouponDto, update: UpdateCouponDto, patch: UpdateCouponDto },
  }) as DefaultKavoService<Coupon>;
});

afterAll(async () => {
  await dataSource.destroy();
});

beforeEach(async () => {
  await dataSource.getRepository(Ticket).clear();
  await dataSource.getRepository(Invoice).clear();
  await dataSource.getRepository(Receipt).clear();
  await dataSource.getRepository(Coupon).clear();
});

/**
 * The context a programmatic caller assembles by hand. Core refuses to
 * *enable* `restoreOne`/`purgeOne` on a hard-delete entity at bootstrap, so
 * the adapter's own guards are only reachable this way.
 */
function hardContext(operation: string) {
  return { entityName: "Receipt", operation, config: { softDelete: { strategy: "hard" } } };
}

async function newTicket(reference = "T-1"): Promise<number> {
  const created = await tickets.createOne({ reference, title: "broken login" } as never);
  return (created as Ticket).id;
}

describe("@DeleteDateColumn detection", () => {
  it("surfaces the declared delete column on the metadata seam", () => {
    expect(buildEntityMetadata(dataSource, Ticket).softDeleteField).toBe("deletedAt");
    expect(buildEntityMetadata(dataSource, Invoice).softDeleteField).toBeNull();
  });
});

describe("TypeOrmRepositoryAdapter — soft delete", () => {
  it("stamps the marker column and hides the row from every read", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);

    const raw = await dataSource.getRepository(Ticket).findOne({ where: { id }, withDeleted: true });
    expect(raw?.deletedAt).toBeInstanceOf(Date);

    await expect(tickets.findOne(id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await tickets.findMany()).items).toHaveLength(0);
    expect((await tickets.findMany()).total).toBe(0);
  });

  it("returns deleted rows under withDeleted", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);

    const list = await tickets.findMany({ withDeleted: true });
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);
    expect(await tickets.findOne(id, { withDeleted: true } as never)).toMatchObject({ id });
  });

  it("shows only deleted rows under onlyDeleted, live rows excluded", async () => {
    const deletedId = await newTicket("T-deleted");
    await newTicket("T-live");
    await tickets.deleteOne(deletedId);

    const list = await tickets.findMany({ onlyDeleted: true });
    expect(list.items).toMatchObject([{ id: deletedId }]);
    expect(list.total).toBe(1);
    expect(await tickets.findOne(deletedId, { onlyDeleted: true } as never)).toMatchObject({ id: deletedId });
  });

  it("rejects withDeleted and onlyDeleted set together", async () => {
    await expect(tickets.findMany({ withDeleted: true, onlyDeleted: true })).rejects.toMatchObject({
      issues: [{ field: "onlyDeleted", code: "KAVO_QUERY_CONFLICTING_PARAMS" }],
    });
  });

  it("keeps updates away from deleted rows", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);
    await expect(tickets.patchOne(id, { title: "resurrected" } as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a second delete with 409 already-deleted", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);
    await expect(tickets.deleteOne(id)).rejects.toBeInstanceOf(AlreadyDeletedException);
  });

  it("restores a deleted row and refuses to restore a live one", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);

    const restored = await tickets.restoreOne(id);
    expect(restored).toMatchObject({ id, deletedAt: null });
    expect((await tickets.findMany()).items).toHaveLength(1);
    await expect(tickets.restoreOne(id)).rejects.toBeInstanceOf(NotDeletedException);
  });

  it("purges a deleted row for good, but never a live one", async () => {
    const id = await newTicket();
    await expect(tickets.purgeOne(id)).rejects.toBeInstanceOf(NotDeletedException);

    await tickets.deleteOne(id);
    await tickets.purgeOne(id);
    expect(await dataSource.getRepository(Ticket).count({ withDeleted: true } as never)).toBe(0);
  });

  it("still conflicts on a unique index held by a deleted row", async () => {
    // Documented adapter guidance: a soft-deleted row keeps its unique
    // index entries, and the fix is a partial index — not a Kavo rewrite.
    const id = await newTicket("T-dup");
    await tickets.deleteOne(id);
    await expect(tickets.createOne({ reference: "T-dup", title: "again" } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("TypeOrmRepositoryAdapter — configured marker column", () => {
  it("soft-deletes, excludes, and restores over an ordinary column", async () => {
    const created = await invoices.createOne({ number: "INV-1" } as never);
    const id = (created as Invoice).id;

    await invoices.deleteOne(id);
    const raw = await dataSource.getRepository(Invoice).findOneBy({ id });
    expect(raw?.archivedAt).toBeInstanceOf(Date);
    expect((await invoices.findMany()).items).toHaveLength(0);
    expect((await invoices.findMany({ withDeleted: true })).items).toHaveLength(1);

    expect(await invoices.restoreOne(id)).toMatchObject({ id, archivedAt: null });
    expect((await invoices.findMany()).items).toHaveLength(1);
  });

  it("shows only deleted rows under onlyDeleted over an ordinary column", async () => {
    const deleted = await invoices.createOne({ number: "INV-deleted" } as never);
    await invoices.createOne({ number: "INV-live" } as never);
    const deletedId = (deleted as Invoice).id;
    await invoices.deleteOne(deletedId);

    const list = await invoices.findMany({ onlyDeleted: true });
    expect(list.items).toMatchObject([{ id: deletedId }]);
  });
});

describe("TypeOrmRepositoryAdapter — an id that is not there", () => {
  // A missing row and an already-deleted row are different answers: 404
  // versus 409. Conflating them would tell a client to retry a restore that
  // can never succeed.
  it("404s on soft delete of an absent id, rather than reporting a conflict", async () => {
    await expect(tickets.deleteOne(9999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s on restore of an absent id", async () => {
    await expect(tickets.restoreOne(9999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s on purge of an absent id under the soft strategy", async () => {
    await expect(tickets.purgeOne(9999)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("TypeOrmRepositoryAdapter — the adapter's own hard-delete guards", () => {
  it("refuses restore on a hard-delete entity instead of silently no-opping", async () => {
    const created = (await receipts.createOne({ number: "R-1" } as never)) as Receipt;
    const adapter = createInfrastructure(dataSource).adapterFor(Receipt);

    await expect(adapter.restore(created.id, hardContext("restoreOne") as never)).rejects.toBeInstanceOf(
      ConfigurationException,
    );
    await expect(adapter.restore(created.id, hardContext("restoreOne") as never)).rejects.toThrow(
      /hard delete strategy/,
    );
  });

  it("purges a hard-delete row outright, then 404s once it is gone", async () => {
    // Under a hard strategy `purge` skips the already-deleted check and is
    // just a delete, so the missing-row answer comes from the row count.
    const created = (await receipts.createOne({ number: "R-2" } as never)) as Receipt;
    const adapter = createInfrastructure(dataSource).adapterFor(Receipt);

    await adapter.purge(created.id, hardContext("purgeOne") as never);
    expect(await dataSource.getRepository(Receipt).countBy({ id: created.id })).toBe(0);

    await expect(adapter.purge(created.id, hardContext("purgeOne") as never)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("TypeOrmRepositoryAdapter — id and soft-delete marker mass assignment", () => {
  it("never reassigns an existing row's id through update/patch, even when a write DTO names it", async () => {
    await coupons.createOne({ code: "SAVE10", label: "10% off", retiredAt: null } as never);

    const patched = await coupons.patchOne("SAVE10", { code: "STOLEN", label: "hijacked" } as never);
    expect(patched).toMatchObject({ code: "SAVE10", label: "hijacked" });

    await expect(coupons.findOne("STOLEN")).rejects.toBeInstanceOf(NotFoundException);
    expect(await coupons.findOne("SAVE10")).toMatchObject({ code: "SAVE10", label: "hijacked" });
  });

  it("never soft-deletes or revives through update/patch, even when a write DTO names the marker", async () => {
    const created = await coupons.createOne({ code: "WELCOME", label: "welcome", retiredAt: null } as never);
    expect(created).toMatchObject({ retiredAt: null });

    // The marker is stripped as immutable, leaving no field changes — a
    // patch body naming only it is KAVO_PATCH_NO_CHANGES, not a silent
    // no-op (issue #287).
    await expect(coupons.patchOne("WELCOME", { retiredAt: new Date(0) } as never)).rejects.toBeInstanceOf(
      PatchNoChangesException,
    );
    expect((await coupons.findOne("WELCOME"))).toMatchObject({ retiredAt: null });
    expect((await coupons.findMany()).items).toHaveLength(1);

    // The dedicated operation is unaffected — this closes a bypass, not the
    // feature itself.
    await coupons.deleteOne("WELCOME");
    expect((await coupons.findMany()).items).toHaveLength(0);
  });
});
