import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  AlreadyDeletedException,
  ConfigurationException,
  ConflictException,
  NotDeletedException,
  NotFoundException,
  type DefaultKavoService,
} from "@kavo/core";
import { buildEntityMetadata, createInfrastructure, createPrismaKavo } from "@kavo/prisma";
import { newTestPrismaClient } from "./support/client.js";

/** Soft delete over a marker column named through config. */
class Ticket {
  id!: number;
  reference!: string;
  title!: string;
  deletedAt!: Date | null;
}

/** Soft delete over an ordinary column, also named through config. */
class Invoice {
  id!: number;
  number!: string;
  archivedAt!: Date | null;
}

/** A natural (non-auto) primary key, plus a configured soft-delete marker —
 * both are ordinary `generated: false` columns Prisma reports the same way. */
class Coupon {
  code!: string;
  label!: string;
  retiredAt!: Date | null;
}

/** Names the id and the configured marker explicitly — the opt-in an
 * explicit write DTO is still allowed to make. */
class UpdateCouponDto {
  code = "";
  label = "";
  retiredAt: Date | null = null;
}

let client: PrismaClient;
let tickets: DefaultKavoService<Ticket>;
let invoices: DefaultKavoService<Invoice>;
let coupons: DefaultKavoService<Coupon>;

beforeAll(() => {
  client = newTestPrismaClient();
  const kavo = createPrismaKavo(client as never, {
    datamodel: Prisma.dmmf.datamodel,
    entities: [Ticket, Invoice, Coupon],
    caseInsensitiveFilters: false,
  });
  tickets = kavo.createCrud(Ticket, {
    softDelete: { field: "deletedAt" },
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
  coupons = kavo.createCrud(Coupon, {
    softDelete: { field: "retiredAt" },
    dto: { create: UpdateCouponDto, update: UpdateCouponDto, patch: UpdateCouponDto },
  }) as DefaultKavoService<Coupon>;
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  await client.ticket.deleteMany();
  await client.invoice.deleteMany();
  await client.coupon.deleteMany();
});

async function newTicket(reference = "T-1"): Promise<number> {
  const created = await tickets.createOne({ reference, title: "broken login" } as never);
  return (created as Ticket).id;
}

/** The adapter on its own, so a caller can hand it a context `createCrud` refuses to build. */
function invoiceAdapter() {
  return createInfrastructure(client as never, {
    datamodel: Prisma.dmmf.datamodel,
    entities: [Ticket, Invoice],
    caseInsensitiveFilters: false,
  }).adapterFor(Invoice);
}

function hardDeleteContext(operation: string) {
  return { entityName: "Invoice", operation, config: { softDelete: { strategy: "hard" } } };
}

describe("metadata seam — no auto-detected soft-delete column", () => {
  it("reports softDeleteField as null (Prisma has no @DeleteDateColumn equivalent)", () => {
    expect(buildEntityMetadata(Prisma.dmmf.datamodel, Ticket, new Map()).softDeleteField).toBeNull();
  });
});

describe("PrismaRepositoryAdapter — soft delete", () => {
  it("stamps the marker column and hides the row from every read", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);

    const raw = await client.ticket.findUnique({ where: { id } });
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

  it("404s a delete of an id that never existed, rather than 409ing it as already deleted", async () => {
    // The two say opposite things to a client: 409 already-deleted describes
    // a row that is still there and invites a `restore`, while a row that
    // never existed can never be reached by any follow-up call.
    await expect(tickets.deleteOne(4242)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a restore of an id that never existed", async () => {
    // Absent and present-but-live are separate answers: 404 says no such row,
    // and the 409 not-deleted above says the row is there but was never
    // deleted. The existence check is what keeps the two apart.
    await expect(tickets.restoreOne(4242)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a purge of an id that never existed", async () => {
    // Same split as restore, over the same marker column read.
    await expect(tickets.purgeOne(4242)).rejects.toBeInstanceOf(NotFoundException);
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
    expect(await client.ticket.count()).toBe(0);
  });

  it("still conflicts on a unique index held by a deleted row", async () => {
    const id = await newTicket("T-dup");
    await tickets.deleteOne(id);
    await expect(tickets.createOne({ reference: "T-dup", title: "again" } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("PrismaRepositoryAdapter — configured marker column", () => {
  it("soft-deletes, excludes, and restores over an ordinary column", async () => {
    const created = await invoices.createOne({ number: "INV-1" } as never);
    const id = (created as Invoice).id;

    await invoices.deleteOne(id);
    const raw = await client.invoice.findUnique({ where: { id } });
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

/**
 * Core refuses to *enable* `restoreOne` or `purgeOne` on a hard-delete entity
 * at bootstrap, so neither branch below is reachable through `createCrud`.
 * They are the adapter's second line of defence, for a programmatic caller
 * that assembles its own context.
 */
describe("PrismaRepositoryAdapter — hard-delete strategy guards", () => {
  it("refuses restore under a hand-built hard-delete context", async () => {
    // A hard-delete entity names no marker column, so "restore" has nothing
    // to clear — refusing loudly beats writing null into a column chosen at
    // random or silently reporting success.
    const created = (await invoices.createOne({ number: "INV-guard" } as never)) as Invoice;

    let thrown: unknown;
    try {
      await invoiceAdapter().restore(created.id, hardDeleteContext("restoreOne") as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationException);
    expect((thrown as ConfigurationException).code).toBe("KAVO_CONFIG_INVALID");
    expect((thrown as Error).message).toMatch(/hard delete strategy/);
  });

  it("purges a hard-delete row outright, and 404s by id when it is already gone", async () => {
    // Under a hard strategy `purge` skips the already-deleted check and is
    // just a delete — but it still pre-checks existence, and that is what
    // names the missing row. Letting Prisma's own P2025 answer instead still
    // maps to a 404, just one whose `id` is blank (see `mapDriverError`), so
    // the id in `messageParams` is what pins the pre-check.
    const created = (await invoices.createOne({ number: "INV-purge" } as never)) as Invoice;
    const adapter = invoiceAdapter();

    await adapter.purge(created.id, hardDeleteContext("purgeOne") as never);
    expect(await client.invoice.count()).toBe(0);

    let thrown: unknown;
    try {
      await adapter.purge(created.id, hardDeleteContext("purgeOne") as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).messageParams).toMatchObject({
      entity: "Invoice",
      id: String(created.id),
    });
  });
});

describe("PrismaRepositoryAdapter — id and soft-delete marker mass assignment", () => {
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

    const patched = await coupons.patchOne("WELCOME", { retiredAt: new Date(0) } as never);
    expect(patched).toMatchObject({ retiredAt: null });
    expect((await coupons.findMany()).items).toHaveLength(1);

    await coupons.deleteOne("WELCOME");
    expect((await coupons.findMany()).items).toHaveLength(0);
  });
});
