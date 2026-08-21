import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MikroORM } from "@mikro-orm/core";
import { Entity, PrimaryKey, Property } from "@mikro-orm/decorators/legacy";
import {
  AlreadyDeletedException,
  ConfigurationException,
  ConflictException,
  NotDeletedException,
  NotFoundException,
  type DefaultKavoService,
} from "@kavo/core";
import { buildEntityMetadata, createInfrastructure, createMikroOrmKavo } from "@kavo/mikroorm";
import { clearDatabase, newTestOrm } from "./support/database.js";

/**
 * Soft delete over an ordinary nullable column. Unlike `@kavo/typeorm` there
 * is only one shape to test: MikroORM declares no delete-date column of its
 * own, so the marker is always an ordinary property and the strategy is
 * always named in Kavo config.
 */
@Entity()
class Ticket {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string", unique: true })
  reference!: string;

  @Property({ type: "string" })
  title!: string;

  @Property({ type: "Date", nullable: true })
  deletedAt: Date | null = null;
}

@Entity()
class Invoice {
  @PrimaryKey({ type: "number" })
  id!: number;

  @Property({ type: "string" })
  number!: string;

  @Property({ type: "Date", nullable: true })
  archivedAt: Date | null = null;
}

/** An app-assigned (non-auto-increment) primary key — `isGenerated` reads
 * none of MikroORM's generated flags for this shape. */
@Entity()
class Coupon {
  @PrimaryKey({ type: "string" })
  code!: string;

  @Property({ type: "string" })
  label!: string;

  @Property({ type: "Date", nullable: true })
  retiredAt: Date | null = null;
}

/** Names the id and the configured marker explicitly — the opt-in an
 * explicit write DTO is still allowed to make. */
class UpdateCouponDto {
  code = "";
  label = "";
  retiredAt: Date | null = null;
}

let orm: MikroORM;
let tickets: DefaultKavoService<Ticket>;
let invoices: DefaultKavoService<Invoice>;
let coupons: DefaultKavoService<Coupon>;

beforeAll(async () => {
  orm = await newTestOrm([Ticket, Invoice, Coupon]);
  const kavo = createMikroOrmKavo(orm);
  tickets = kavo.createCrud(Ticket, {
    softDelete: { strategy: "soft", field: "deletedAt" },
    operations: {
      createOne: {},
      deleteOne: {},
      findMany: {},
      findOne: {},
      patchOne: {},
      restoreOne: {},
      purgeOne: {},
    },
  }) as DefaultKavoService<Ticket>;
  invoices = kavo.createCrud(Invoice, {
    softDelete: { strategy: "soft", field: "archivedAt" },
  }) as DefaultKavoService<Invoice>;
  coupons = kavo.createCrud(Coupon, {
    softDelete: { strategy: "soft", field: "retiredAt" },
    dto: { create: UpdateCouponDto, update: UpdateCouponDto, patch: UpdateCouponDto },
  }) as DefaultKavoService<Coupon>;
});

afterAll(async () => {
  await orm.close();
});

beforeEach(async () => {
  await clearDatabase(orm);
});

async function newTicket(reference = "T-1"): Promise<number> {
  const created = await tickets.createOne({ reference, title: "broken login" } as never);
  return (created as Ticket).id;
}

describe("delete-marker detection", () => {
  it("reports no ORM-declared delete column, because MikroORM declares none", () => {
    // MikroORM's soft-delete pattern is a user-defined `@Filter`, a query
    // concern rather than a column declaration — so there is nothing for the
    // metadata seam to detect and `softDelete.field` must be configured.
    expect(buildEntityMetadata(orm, Ticket).softDeleteField).toBeNull();
    expect(buildEntityMetadata(orm, Invoice).softDeleteField).toBeNull();
  });
});

describe("zero-config soft delete", () => {
  it("is auto-enabled by a `deletedAt` property alone, with no config at all", async () => {
    // `softDelete` defaults to `{ field: "deletedAt", strategy: "auto" }`, and
    // `resolveSoftDelete` matches that name against the entity's own columns.
    // So an adapter reporting `softDeleteField: null` does NOT mean "soft
    // delete is off until configured" — the conventional column name turns it
    // on by itself.
    const zeroConfig = createMikroOrmKavo(orm).createCrud(Ticket) as DefaultKavoService<Ticket>;
    const created = (await zeroConfig.createOne({ reference: "T-zero", title: "x" } as never)) as Ticket;

    await zeroConfig.deleteOne(created.id);

    const raw = await orm.em.fork().findOne(Ticket, { id: created.id });
    expect(raw).not.toBeNull(); // still there — soft, not hard
    expect(raw?.deletedAt).toBeInstanceOf(Date);
    expect((await zeroConfig.findMany()).total).toBe(0);
  });

  it("keeps the marker out of the derived writable projection with no config at all", async () => {
    // With no `dto` block, `deletedAt` is an ordinary non-generated column —
    // `DefaultDeserializer` excludes it by name (the resolved
    // `softDelete.field`), not just by `generated`, so a plain patch cannot
    // stamp it and bypass `deleteOne`'s already-deleted check.
    const zeroConfig = createMikroOrmKavo(orm).createCrud(Ticket) as DefaultKavoService<Ticket>;
    const created = (await zeroConfig.createOne({ reference: "T-writable", title: "x" } as never)) as Ticket;

    await zeroConfig.patchOne(created.id, { deletedAt: new Date() } as never);
    expect((await zeroConfig.findMany()).total).toBe(1);
  });
});

describe("MikroOrmRepositoryAdapter — soft delete", () => {
  it("stamps the marker column and hides the row from every read", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);

    const raw = await orm.em.fork().findOne(Ticket, { id });
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

  it("keeps the soft-delete scope alongside a filter rather than replacing it", async () => {
    const deletedId = await newTicket("T-deleted");
    await newTicket("T-live");
    await tickets.deleteOne(deletedId);

    // Both predicates must survive the AND: a filter that matches the deleted
    // row must still not return it.
    const list = await tickets.findMany({
      filter: { kind: "condition", field: "reference", operator: "LIKE", value: "T-%" },
    });
    expect(list.items).toMatchObject([{ reference: "T-live" }]);
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

  it("throws NotFound restoring a row that never existed", async () => {
    await expect(tickets.restoreOne(4242)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("purges a deleted row for good, but never a live one", async () => {
    const id = await newTicket();
    await expect(tickets.purgeOne(id)).rejects.toBeInstanceOf(NotDeletedException);

    await tickets.deleteOne(id);
    await tickets.purgeOne(id);
    expect(await orm.em.fork().count(Ticket, {})).toBe(0);
  });

  it("still conflicts on a unique index held by a deleted row", async () => {
    // Documented adapter guidance: a soft-deleted row keeps its unique index
    // entries, and the fix is a partial index — not a Kavo rewrite.
    const id = await newTicket("T-dup");
    await tickets.deleteOne(id);
    await expect(tickets.createOne({ reference: "T-dup", title: "again" } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("MikroOrmRepositoryAdapter — an id that is not there", () => {
  // A missing row and an already-deleted one are different answers: 404
  // versus 409. Conflating them would tell a client to retry something that
  // can never succeed, because there is no row to act on in the first place.
  it("404s on soft delete of an absent id, rather than reporting a conflict", async () => {
    await expect(tickets.deleteOne(9999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s on purge of an absent id under the soft strategy", async () => {
    // The hard-strategy sibling gets its 404 from `nativeDelete` reporting
    // zero affected rows; under soft the answer has to come earlier, from the
    // lookup the already-deleted check does — otherwise a missing id would
    // surface as "not deleted" (409) instead.
    await expect(tickets.purgeOne(9999)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("MikroOrmRepositoryAdapter — a differently named marker column", () => {
  it("soft-deletes, excludes, and restores over an ordinary column", async () => {
    const created = await invoices.createOne({ number: "INV-1" } as never);
    const id = (created as Invoice).id;

    await invoices.deleteOne(id);
    const raw = await orm.em.fork().findOne(Invoice, { id });
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

describe("MikroOrmRepositoryAdapter — hard delete", () => {
  it("removes the row outright and refuses a missing one", async () => {
    const kavo = createMikroOrmKavo(orm);
    const hard = kavo.createCrud(Invoice, {
      softDelete: { strategy: "hard" },
    }) as DefaultKavoService<Invoice>;

    const created = (await hard.createOne({ number: "INV-hard" } as never)) as Invoice;
    await hard.deleteOne(created.id);
    expect(await orm.em.fork().count(Invoice, {})).toBe(0);
    // `nativeDelete` reports zero affected rows for a row that is already
    // gone, which is what turns a repeat delete into a 404 rather than a
    // silent success.
    await expect(hard.deleteOne(created.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses to enable restoreOne on a hard-delete entity at bootstrap", () => {
    // Core catches this at `createCrud` rather than leaving the adapter to
    // fail per request — the adapter's own `requireSoftDelete` guard is the
    // second line, for a hand-built context.
    let thrown: unknown;
    try {
      createMikroOrmKavo(orm).createCrud(Invoice, {
        softDelete: { strategy: "hard" },
        operations: { restoreOne: {} },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationException);
    expect((thrown as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
    expect((thrown as Error).message).toMatch(/hard delete strategy/);
  });

  it("refuses restore at the adapter too, for a hand-built hard-delete context", async () => {
    // The second line of defence the bootstrap check above makes unreachable
    // through `createCrud` — a programmatic caller assembling its own context
    // reaches the adapter directly, and must not silently no-op.
    const created = (await invoices.createOne({ number: "INV-guard" } as never)) as Invoice;
    const adapter = createInfrastructure(orm).adapterFor(Invoice);
    const hardContext = {
      entityName: "Invoice",
      operation: "restoreOne",
      config: { softDelete: { strategy: "hard" } },
    };

    let thrown: unknown;
    try {
      await adapter.restore(created.id, hardContext as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationException);
    expect((thrown as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
  });

  it("purges a hard-delete row outright, and 404s when it is already gone", async () => {
    // Under a hard strategy `purge` skips the already-deleted check entirely
    // and is just a delete. Core refuses to *enable* `purgeOne` on a
    // hard-delete entity at bootstrap (same guard as `restoreOne`), so this
    // branch is only reachable the way `requireSoftDelete`'s is: a
    // programmatic caller assembling its own context.
    const created = (await invoices.createOne({ number: "INV-purge" } as never)) as Invoice;
    const adapter = createInfrastructure(orm).adapterFor(Invoice);
    const hardContext = {
      entityName: "Invoice",
      operation: "purgeOne",
      config: { softDelete: { strategy: "hard" } },
    };

    await adapter.purge(created.id, hardContext as never);
    expect(await orm.em.fork().count(Invoice, {})).toBe(0);
    await expect(adapter.purge(created.id, hardContext as never)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("MikroOrmRepositoryAdapter — id and soft-delete marker mass assignment", () => {
  it("never reassigns an existing row's id through update/patch, even when a write DTO names it", async () => {
    await coupons.createOne({ code: "SAVE10", label: "10% off", retiredAt: null } as never);

    const patched = await coupons.patchOne("SAVE10", { code: "STOLEN", label: "hijacked" } as never);
    expect(patched).toMatchObject({ code: "SAVE10", label: "hijacked" });

    await expect(coupons.findOne("STOLEN")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("never soft-deletes or revives through update/patch, even when a write DTO names the marker", async () => {
    const created = await coupons.createOne({ code: "WELCOME", label: "welcome", retiredAt: null } as never);
    expect(created).toMatchObject({ retiredAt: null });

    const patched = await coupons.patchOne("WELCOME", { retiredAt: new Date(0) } as never);
    expect(patched).toMatchObject({ retiredAt: null });
    expect((await coupons.findMany()).items).toHaveLength(1);

    await coupons.deleteOne("WELCOME");
    expect((await coupons.findMany()).items).toHaveLength(0);
  });
});
