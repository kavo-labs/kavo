import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Schema } from "mongoose";
import {
  AlreadyDeletedException,
  ConfigurationException,
  ConflictException,
  NotDeletedException,
  NotFoundException,
  PatchNoChangesException,
  type DefaultKavoService,
  type RepositoryAdapter,
} from "@kavo/core";
import { buildEntityMetadata, createInfrastructure, createMongooseKavo } from "@kavo/mongoose";
import {
  clearCollections,
  ensureIndexes,
  rejectionOf,
  startTestDatabase,
  type TestDatabase,
} from "./support/database.js";

interface Ticket {
  _id: string;
  reference: string;
  title: string;
  deletedAt: Date | null;
}

interface Invoice {
  _id: string;
  number: string;
  archivedAt: Date | null;
}

interface Coupon {
  _id: string;
  label: string;
  retiredAt: Date | null;
}

/** Names `_id` and the configured marker explicitly — the opt-in an
 * explicit write DTO is still allowed to make. */
class UpdateCouponDto {
  _id = "";
  label = "";
  retiredAt: Date | null = null;
}

/**
 * Declared through a factory so the models keep their *inferred* Mongoose
 * types — annotating them with `ReturnType<connection["model"]>` would
 * collapse them to `Model<unknown>`.
 */
function defineModels(connection: TestDatabase["connection"]) {
  return {
    Ticket: connection.model(
      "Ticket",
      new Schema({
        reference: { type: String, unique: true },
        title: String,
        deletedAt: { type: Date, default: null },
      }),
    ),
    Invoice: connection.model("Invoice", new Schema({ number: String, archivedAt: { type: Date, default: null } })),
    Coupon: connection.model("Coupon", new Schema({ label: String, retiredAt: { type: Date, default: null } })),
  };
}

let database: TestDatabase;
let models: ReturnType<typeof defineModels>;
let tickets: DefaultKavoService<Ticket>;
let invoices: DefaultKavoService<Invoice>;
let coupons: DefaultKavoService<Coupon>;

beforeAll(async () => {
  database = await startTestDatabase();
  models = defineModels(database.connection);
  await ensureIndexes(models.Ticket, models.Invoice);

  const kavo = createMongooseKavo(database.connection);
  // Double cast on purpose: Mongoose's model type describes a *hydrated
  // document*, while Kavo serves lean data with `_id` already rendered as a
  // string. The interfaces above are the shape the service actually
  // returns, which is what these tests assert.
  tickets = kavo.createCrud(models.Ticket, {
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
  }) as unknown as DefaultKavoService<Ticket>;
  invoices = kavo.createCrud(models.Invoice, {
    softDelete: { field: "archivedAt" },
  }) as unknown as DefaultKavoService<Invoice>;
  coupons = kavo.createCrud(models.Coupon, {
    softDelete: { field: "retiredAt" },
    dto: { create: UpdateCouponDto, update: UpdateCouponDto, patch: UpdateCouponDto },
  }) as unknown as DefaultKavoService<Coupon>;
});

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await clearCollections(database.connection);
});

async function newTicket(reference = "T-1"): Promise<string> {
  const created = (await tickets.createOne({ reference, title: "broken login" } as never)) as Ticket;
  return created._id;
}

describe("metadata seam — no auto-detected soft-delete field", () => {
  it("reports softDeleteField as null (Mongoose has no @DeleteDateColumn equivalent)", () => {
    expect(buildEntityMetadata(models.Ticket as never, database.connection).softDeleteField).toBeNull();
  });
});

describe("MongooseRepositoryAdapter — soft delete", () => {
  it("stamps the marker field and hides the document from every read", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);

    const raw = (await models.Ticket.findById(id).lean()) as unknown as { deletedAt: unknown };
    expect(raw.deletedAt).toBeInstanceOf(Date);

    await expect(tickets.findOne(id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await tickets.findMany()).items).toHaveLength(0);
    expect((await tickets.findMany()).total).toBe(0);
  });

  it("returns deleted documents under withDeleted", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);

    const list = await tickets.findMany({ withDeleted: true });
    expect(list.items).toHaveLength(1);
    expect(list.total).toBe(1);
    expect(await tickets.findOne(id, { withDeleted: true } as never)).toMatchObject({ _id: id });
  });

  it("shows only deleted documents under onlyDeleted, live documents excluded", async () => {
    const deletedId = await newTicket("T-deleted");
    await newTicket("T-live");
    await tickets.deleteOne(deletedId);

    const list = await tickets.findMany({ onlyDeleted: true });
    expect(list.items).toMatchObject([{ _id: deletedId }]);
    expect(list.total).toBe(1);
    expect(await tickets.findOne(deletedId, { onlyDeleted: true } as never)).toMatchObject({ _id: deletedId });
  });

  it("rejects withDeleted and onlyDeleted set together", async () => {
    const error = await rejectionOf(tickets.findMany({ withDeleted: true, onlyDeleted: true }));
    expect(error).toMatchObject({
      issues: [{ field: "onlyDeleted", code: "KAVO_QUERY_CONFLICTING_PARAMS" }],
    });
  });

  it("keeps updates away from deleted documents", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);
    const error = await rejectionOf(tickets.patchOne(id, { title: "resurrected" } as never));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.code).toBe("KAVO_NOT_FOUND");
  });

  it("rejects a second delete with 409 already-deleted", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);
    const error = await rejectionOf(tickets.deleteOne(id));
    expect(error).toBeInstanceOf(AlreadyDeletedException);
    expect(error.code).toBe("KAVO_ALREADY_DELETED");
  });

  it("restores a deleted document and refuses to restore a live one", async () => {
    const id = await newTicket();
    await tickets.deleteOne(id);

    const restored = await tickets.restoreOne(id);
    expect(restored).toMatchObject({ _id: id, deletedAt: null });
    expect((await tickets.findMany()).items).toHaveLength(1);

    const error = await rejectionOf(tickets.restoreOne(id));
    expect(error).toBeInstanceOf(NotDeletedException);
    expect(error.code).toBe("KAVO_NOT_DELETED");
  });

  it("purges a deleted document for good, but never a live one", async () => {
    const id = await newTicket();
    const error = await rejectionOf(tickets.purgeOne(id));
    expect(error).toBeInstanceOf(NotDeletedException);
    expect(error.code).toBe("KAVO_NOT_DELETED");

    await tickets.deleteOne(id);
    await tickets.purgeOne(id);
    expect(await models.Ticket.countDocuments({})).toBe(0);
  });

  it("reports a missing document as 404 rather than already-deleted", async () => {
    const absent = "507f1f77bcf86cd799439011";
    await expect(tickets.deleteOne(absent)).rejects.toBeInstanceOf(NotFoundException);
    await expect(tickets.restoreOne(absent)).rejects.toBeInstanceOf(NotFoundException);
    await expect(tickets.purgeOne(absent)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lets exactly one of two concurrent deletes win, and keeps the first timestamp", async () => {
    // The marker predicate lives in the update filter, so the transition is
    // atomic: a read-then-write would let both callers pass the
    // `isDeleted` check, both report success, and the later write overwrite
    // the recorded deletion time.
    const id = await newTicket("T-race");
    const outcomes = await Promise.allSettled([tickets.deleteOne(id), tickets.deleteOne(id)]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyDeletedException);
  });

  it("lets exactly one of two concurrent restores win", async () => {
    const id = await newTicket("T-race-2");
    await tickets.deleteOne(id);
    const outcomes = await Promise.allSettled([tickets.restoreOne(id), tickets.restoreOne(id)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(NotDeletedException);
  });

  it("still conflicts on a unique index held by a deleted document", async () => {
    // A soft-deleted document keeps occupying its unique indexes — the
    // documented fix is a partial index scoped to live documents.
    const id = await newTicket("T-dup");
    await tickets.deleteOne(id);
    await expect(tickets.createOne({ reference: "T-dup", title: "again" } as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("MongooseRepositoryAdapter — configured marker field", () => {
  it("soft-deletes, excludes, and restores over an ordinary field", async () => {
    const created = (await invoices.createOne({ number: "INV-1" } as never)) as Invoice;

    await invoices.deleteOne(created._id);
    const raw = (await models.Invoice.findById(created._id).lean()) as unknown as { archivedAt: unknown };
    expect(raw.archivedAt).toBeInstanceOf(Date);
    expect((await invoices.findMany()).items).toHaveLength(0);
    expect((await invoices.findMany({ withDeleted: true })).items).toHaveLength(1);

    expect(await invoices.restoreOne(created._id)).toMatchObject({ _id: created._id, archivedAt: null });
    expect((await invoices.findMany()).items).toHaveLength(1);
  });

  it("shows only deleted documents under onlyDeleted over an ordinary field", async () => {
    const deleted = (await invoices.createOne({ number: "INV-deleted" } as never)) as Invoice;
    await invoices.createOne({ number: "INV-live" } as never);
    await invoices.deleteOne(deleted._id);

    const list = await invoices.findMany({ onlyDeleted: true });
    expect(list.items).toMatchObject([{ _id: deleted._id }]);
  });
});

describe("MongooseRepositoryAdapter — id and soft-delete marker mass assignment", () => {
  it("never reassigns an existing document's id through update/patch, even when a write DTO names it", async () => {
    const created = (await coupons.createOne({ label: "10% off", retiredAt: null } as never)) as Coupon;

    const patched = await coupons.patchOne(created._id, { _id: "hijacked", label: "changed" } as never);
    expect(patched).toMatchObject({ _id: created._id, label: "changed" });

    await expect(coupons.findOne("hijacked")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("never soft-deletes or revives through update/patch, even when a write DTO names the marker", async () => {
    const created = (await coupons.createOne({ label: "welcome", retiredAt: null } as never)) as Coupon;

    // The marker is stripped as immutable, leaving no field changes — a
    // patch body naming only it is KAVO_PATCH_NO_CHANGES, not a silent
    // no-op (issue #287).
    await expect(coupons.patchOne(created._id, { retiredAt: new Date(0) } as never)).rejects.toBeInstanceOf(
      PatchNoChangesException,
    );
    expect(await coupons.findOne(created._id)).toMatchObject({ retiredAt: null });
    expect((await coupons.findMany()).items).toHaveLength(1);

    await coupons.deleteOne(created._id);
    expect((await coupons.findMany()).items).toHaveLength(0);
  });
});

describe("MongooseRepositoryAdapter — hard-delete contexts assembled by hand", () => {
  // Core refuses to *enable* `restoreOne` or `purgeOne` on a hard-delete
  // entity at bootstrap, so neither guard below is reachable through
  // `createCrud`. They are the adapter's second line, for a programmatic
  // caller that assembles its own context and calls the adapter directly.

  function invoiceAdapter(): RepositoryAdapter<Invoice> {
    return createInfrastructure(database.connection).adapterFor(models.Invoice as never) as RepositoryAdapter<Invoice>;
  }

  function hardContext(operation: string) {
    return { entityName: "Invoice", operation, config: { softDelete: { strategy: "hard" } } };
  }

  it("refuses restore outright on a hard-delete entity instead of silently no-opping", async () => {
    const created = (await invoices.createOne({ number: "INV-guard" } as never)) as Invoice;

    const error = await rejectionOf(invoiceAdapter().restore(created._id, hardContext("restoreOne") as never));
    expect(error).toBeInstanceOf(ConfigurationException);
    expect(error.code).toBe("KAVO_CONFIG_INVALID");
    expect(error.message).toMatch(/hard delete strategy/);
  });

  it("purges a hard-delete document outright, then reports it as 404 once it is gone", async () => {
    // Under a hard strategy `purge` has no delete marker to check, so its
    // existence pre-check is the only thing between a second call and a
    // `deleteOne` that quietly matches nothing and reports success.
    const created = (await invoices.createOne({ number: "INV-purge" } as never)) as Invoice;
    const adapter = invoiceAdapter();

    await adapter.purge(created._id, hardContext("purgeOne") as never);
    expect(await models.Invoice.countDocuments({})).toBe(0);

    const error = await rejectionOf(adapter.purge(created._id, hardContext("purgeOne") as never));
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.code).toBe("KAVO_NOT_FOUND");
  });
});
