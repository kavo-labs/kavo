import { describe, expect, it } from "vitest";
import {
  AlreadyDeletedException,
  BUILT_IN_DEFAULTS,
  ConfigurationException,
  NotDeletedException,
  NotFoundException,
  QueryValidationException,
  createKavo,
  createOperationRegistry,
  mergeSettings,
  resolveSoftDelete,
} from "@kavo/core";
import type { KavoSettings, EntityConfig } from "@kavo/core";
import {
  Account,
  InMemoryAccountAdapter,
  accountMetadata,
  accountMetadataWithNaturalKey,
  accountMetadataWithoutMarker,
  accountMetadataWithTwoMarkerCandidates,
  accountMetadataWithWritableMarker,
} from "./support/account-fixture.js";
import { InMemoryUserAdapter, User, userMetadata } from "./support/user-fixture.js";

function settings(overrides: Parameters<typeof mergeSettings>[1] = {}): KavoSettings {
  return mergeSettings(BUILT_IN_DEFAULTS, overrides);
}

type AccountConfig = EntityConfig<Account>;

function makeAccountCrud(config?: AccountConfig, metadata = accountMetadata) {
  const adapter = new InMemoryAccountAdapter();
  const crud = createKavo().createCrud(Account, config as never, { adapter, metadata });
  return { crud, adapter };
}

describe("delete strategy resolution", () => {
  it("defaults to soft for an entity carrying the marker field", () => {
    expect(resolveSoftDelete(accountMetadata, settings())).toEqual({
      strategy: "soft",
      field: "deletedAt",
    });
  });

  it("defaults to hard for an entity that carries none — zero cost", () => {
    expect(resolveSoftDelete(userMetadata, settings())).toEqual({
      strategy: "hard",
      field: null,
    });
  });

  it("honors an explicit marker field over the ORM's declaration", () => {
    const metadata = {
      ...accountMetadata,
      fields: [...accountMetadata.fields, { name: "archivedAt", kind: "date", nullable: true, generated: false }],
    } as typeof accountMetadata;
    expect(resolveSoftDelete(metadata, settings({ softDelete: { field: "archivedAt" } }))).toEqual({
      strategy: "soft",
      field: "archivedAt",
    });
  });

  it("resolves hard when soft delete is switched off entirely", () => {
    expect(resolveSoftDelete(accountMetadata, settings({ softDelete: false })).strategy).toBe("hard");
    expect(resolveSoftDelete(accountMetadata, settings({ softDelete: { strategy: "hard" } })).strategy).toBe("hard");
  });

  it("rejects strategy 'soft' on an entity with no marker field", () => {
    expect(() =>
      resolveSoftDelete(accountMetadataWithoutMarker, settings({ softDelete: { strategy: "soft" } })),
    ).toThrow(ConfigurationException);
  });
});

describe("soft delete lifecycle", () => {
  it("marks the row instead of removing it, and hides it from reads", async () => {
    const { crud, adapter } = makeAccountCrud();
    await crud.createOne({ name: "acme" } as never);

    await crud.deleteOne(1);

    expect(adapter.rows).toHaveLength(1);
    expect(adapter.rows[0]!.deletedAt).toBeInstanceOf(Date);
    await expect(crud.findOne(1)).rejects.toBeInstanceOf(NotFoundException);
    expect((await crud.findMany()).items).toHaveLength(0);
  });

  it("shows deleted rows again under withDeleted", async () => {
    const { crud } = makeAccountCrud();
    await crud.createOne({ name: "acme" } as never);
    await crud.deleteOne(1);

    const list = await crud.findMany({ withDeleted: true });
    expect(list.items).toHaveLength(1);
    expect(await crud.findOne(1, { withDeleted: true } as never)).toMatchObject({ id: 1 });
  });

  it("rejects withDeleted on an entity that is not soft-deletable", async () => {
    const crud = createKavo().createCrud(User, undefined, {
      adapter: new InMemoryUserAdapter(),
      metadata: userMetadata,
    });
    await expect(crud.findMany({ withDeleted: true })).rejects.toMatchObject({
      issues: [{ field: "withDeleted", code: "KAVO_QUERY_UNSUPPORTED_PARAM" }],
    });
  });

  it("shows only deleted rows under onlyDeleted, and neither live nor deleted otherwise mixed in", async () => {
    const { crud } = makeAccountCrud();
    await crud.createOne({ name: "acme" } as never);
    await crud.createOne({ name: "globex" } as never);
    await crud.deleteOne(1);

    const list = await crud.findMany({ onlyDeleted: true });
    expect(list.items).toMatchObject([{ id: 1 }]);
    expect(await crud.findOne(1, { onlyDeleted: true } as never)).toMatchObject({ id: 1 });
    await expect(crud.findOne(2, { onlyDeleted: true } as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects onlyDeleted on an entity that is not soft-deletable", async () => {
    const crud = createKavo().createCrud(User, undefined, {
      adapter: new InMemoryUserAdapter(),
      metadata: userMetadata,
    });
    await expect(crud.findMany({ onlyDeleted: true })).rejects.toMatchObject({
      issues: [{ field: "onlyDeleted", code: "KAVO_QUERY_UNSUPPORTED_PARAM" }],
    });
  });

  it("rejects withDeleted and onlyDeleted set together as a conflicting combination", async () => {
    const { crud } = makeAccountCrud();
    await crud.createOne({ name: "acme" } as never);
    await expect(crud.findMany({ withDeleted: true, onlyDeleted: true })).rejects.toMatchObject({
      issues: [{ field: "onlyDeleted", code: "KAVO_QUERY_CONFLICTING_PARAMS" }],
    });
  });

  it("refuses to delete an already-deleted row", async () => {
    const { crud } = makeAccountCrud();
    await crud.createOne({ name: "acme" } as never);
    await crud.deleteOne(1);
    await expect(crud.deleteOne(1)).rejects.toBeInstanceOf(AlreadyDeletedException);
  });

  it("restores a deleted row into the item slot, and refuses to restore a live one", async () => {
    const { crud } = makeAccountCrud({ softDelete: { strategy: "soft" } });
    await crud.createOne({ name: "acme" } as never);
    await crud.deleteOne(1);

    expect(await crud.restoreOne(1)).toMatchObject({ id: 1, name: "acme" });
    expect((await crud.findMany()).items).toHaveLength(1);
    await expect(crud.restoreOne(1)).rejects.toBeInstanceOf(NotDeletedException);
  });

  it("purges only an already-deleted row, and only when enabled", async () => {
    const disabled = makeAccountCrud();
    await disabled.crud.createOne({ name: "acme" } as never);
    await expect(disabled.crud.purgeOne(1)).rejects.toMatchObject({ code: "KAVO_OPERATION_DISABLED" });

    const { crud, adapter } = makeAccountCrud({ operations: { createOne: true, deleteOne: true, purgeOne: true } });
    await crud.createOne({ name: "acme" } as never);
    await expect(crud.purgeOne(1)).rejects.toBeInstanceOf(NotDeletedException);

    await crud.deleteOne(1);
    await crud.purgeOne(1);
    expect(adapter.rows).toHaveLength(0);
  });

  it("hard-deletes when the entity opts out, leaving restore unavailable", async () => {
    const { crud, adapter } = makeAccountCrud({ softDelete: false });
    await crud.createOne({ name: "acme" } as never);
    await crud.deleteOne(1);
    expect(adapter.rows).toHaveLength(0);
    await expect(crud.restoreOne(1)).rejects.toMatchObject({ code: "KAVO_OPERATION_DISABLED" });
  });

  it("applies a per-operation strategy override", async () => {
    const { crud, adapter } = makeAccountCrud({
      operations: { createOne: true, deleteOne: { softDelete: { strategy: "hard" } } },
    });
    await crud.createOne({ name: "acme" } as never);
    await crud.deleteOne(1);
    expect(adapter.rows).toHaveLength(0);
  });
});

describe("soft-delete operation enablement (ADR-0013)", () => {
  it("keeps restoreOne and purgeOne off by default", () => {
    const registry = createOperationRegistry<Account>(undefined);
    expect(registry.get("restoreOne")?.enabled).toBe(false);
    expect(registry.get("purgeOne")?.enabled).toBe(false);
  });

  it("enables restoreOne when the config declares soft delete", () => {
    for (const config of [{ softDelete: { strategy: "soft" } }, { softDelete: { field: "archivedAt" } }] as const) {
      const registry = createOperationRegistry<Account>(config as AccountConfig);
      expect(registry.get("restoreOne")?.enabled).toBe(true);
      expect(registry.get("purgeOne")?.enabled).toBe(false);
    }
  });

  it("treats an inherited 'auto' strategy as no declaration", () => {
    const registry = createOperationRegistry<Account>({ softDelete: { strategy: "auto" } } as AccountConfig);
    expect(registry.get("restoreOne")?.enabled).toBe(false);
  });

  it("still resolves soft delete for an undeclared entity — deletes and reads adapt", async () => {
    const { crud, adapter } = makeAccountCrud();
    await crud.createOne({ name: "acme" } as never);
    await crud.deleteOne(1);
    expect(adapter.rows[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it("fails at bootstrap when a soft-delete operation is enabled on a hard-delete entity", () => {
    expect(() => makeAccountCrud({ operations: { purgeOne: true } }, accountMetadataWithoutMarker)).toThrow(
      ConfigurationException,
    );
  });

  it("rejects a non-boolean withDeleted value", async () => {
    const { crud } = makeAccountCrud();
    await expect(crud.findMany({ withDeleted: "yes" } as never)).rejects.toBeInstanceOf(QueryValidationException);
  });
});

describe("the soft-delete marker and primary key are not mass-assignable", () => {
  it("cannot be soft-deleted or revived through a plain PATCH, even when the marker is an ordinary column", async () => {
    // `accountMetadataWithWritableMarker` reports `softDeleteField: null`
    // and `generated: false` on `deletedAt` — exactly what
    // Prisma/Mongoose/MikroORM (and `@kavo/typeorm` with a plain-column
    // `softDelete.field`) report, the shape a `generated`-only exclusion
    // cannot see.
    const { crud, adapter } = makeAccountCrud(undefined, accountMetadataWithWritableMarker);
    await crud.createOne({ name: "acme" } as never);

    await crud.updateOne(1, { name: "acme", deletedAt: new Date(0) } as never);

    expect(adapter.rows[0]!.deletedAt).toBeNull();
    // The dedicated operation still works — this isn't a broken feature,
    // just a route the generic write can no longer bypass it through.
    await crud.deleteOne(1);
    expect(adapter.rows[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it("cannot reassign an existing row's id through a plain PATCH", async () => {
    const { crud, adapter } = makeAccountCrud(undefined, accountMetadataWithNaturalKey);
    await crud.createOne({ name: "acme" } as never);

    await crud.patchOne(1, { id: 999, name: "acme corp" } as never);

    expect(adapter.rows).toMatchObject([{ id: 1, name: "acme corp" }]);
  });

  it("excludes the marker a per-operation override actually resolves, not the entity-scope default", async () => {
    // The regression this pins: the entity declares `deletedAt` as its
    // soft-delete field, but `createOne` is configured to resolve a
    // *different* marker (`archivedAt`) — an ordinary, legal per-operation
    // override (ADR-0013's precedence chain). A `DefaultDeserializer` that
    // excluded only the entity-scope name would let `archivedAt` straight
    // through on `createOne`, reopening exactly the bug this file otherwise
    // covers — for the one config shape where "the marker" isn't fixed at
    // bootstrap.
    const adapter = new InMemoryAccountAdapter();
    const crud = createKavo().createCrud(
      Account,
      {
        softDelete: { field: "deletedAt" },
        operations: { createOne: { softDelete: { field: "archivedAt" } } },
      } as never,
      { adapter, metadata: accountMetadataWithTwoMarkerCandidates },
    );

    const created = (await crud.createOne({ name: "acme", archivedAt: new Date(0) } as never)) as Account & {
      archivedAt?: unknown;
    };

    expect(created.archivedAt).toBeUndefined();
  });
});
