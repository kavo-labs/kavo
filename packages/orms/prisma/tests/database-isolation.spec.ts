import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { TEMPLATE_DATABASE, newTestPrismaClient, provisionTestDatabase } from "./support/client.js";
import setup, { SCRATCH_ROOT_ENV } from "./support/global-setup.js";

const PRISMA_DIRECTORY = fileURLToPath(new URL("../prisma/", import.meta.url));

/**
 * The fixture-provisioning contract itself. Every other spec file in this
 * package opens a `beforeEach` with a chain of `deleteMany()` writes, and
 * vitest runs those files in parallel workers; SQLite admits one writer at a
 * time, so a single shared file made the suite fail with `P1008` under CI load
 * (issue #101). These tests pin the properties that removed the contention —
 * one database per client — and the two that keep the fix from decaying
 * silently: copies land where something deletes them, and a copy carries every
 * committed transaction the template does.
 */
describe("test-fixture database provisioning", () => {
  it("gives every client a database of its own", async () => {
    const first = newTestPrismaClient();
    const second = newTestPrismaClient();
    try {
      await first.scratch.create({ data: { label: "isolation" } });

      expect(await first.scratch.count()).toBe(1);
      expect(await second.scratch.count()).toBe(0);
    } finally {
      await first.$disconnect();
      await second.$disconnect();
    }
  });

  it("copies the template into the run's scratch root, byte for byte", () => {
    const scratchRoot = process.env[SCRATCH_ROOT_ENV];
    const first = provisionTestDatabase();
    const second = provisionTestDatabase();

    expect(first).not.toBe(second);
    for (const copy of [first, second]) {
      // Containment is the half of the design that fails silently: a copy
      // outside the scratch root works, and leaks, because nothing deletes it.
      expect(copy.startsWith(`${scratchRoot}${sep}`)).toBe(true);
      expect(readFileSync(copy).equals(readFileSync(TEMPLATE_DATABASE))).toBe(true);
    }
  });

  it("carries committed-but-uncheckpointed WAL frames to the copy, without the rebuild-on-open wal-index", async () => {
    const staging = provisionTestDatabase();
    // A read, not just the pragma, is what maps the wal-index and takes
    // SQLite's deadman-switch lock — that lock is why the writer's close
    // below skips its checkpoint and leaves the WAL on disk to be copied.
    const holder = newTestPrismaClient(staging);
    await holder.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await holder.scratch.count();
    try {
      const writer = newTestPrismaClient(staging);
      await writer.scratch.create({ data: { label: "uncheckpointed" } });
      await writer.$disconnect();

      // Without this the assertions below would pass vacuously if a future
      // SQLite or Prisma checkpointed on close after all.
      expect(existsSync(`${staging}-wal`)).toBe(true);
      expect(existsSync(`${staging}-shm`)).toBe(true);

      const copy = provisionTestDatabase(staging);
      // The wal-index is derived state SQLite rebuilds on open. Copying a
      // stale one can make SQLite treat it as authoritative and skip
      // recovering the frames below — silent row loss, which is the failure
      // this whole change exists to remove.
      expect(existsSync(`${copy}-shm`)).toBe(false);

      const reader = newTestPrismaClient(copy);
      try {
        expect(await reader.scratch.findMany()).toEqual([{ id: expect.any(Number), label: "uncheckpointed" }]);
      } finally {
        await reader.$disconnect();
      }
    } finally {
      await holder.$disconnect();
    }
  });

  it("opens the database `pnpm generate` was told to push", () => {
    const declared = /^DATABASE_URL="file:(?<path>.+)"$/m.exec(readFileSync(join(PRISMA_DIRECTORY, ".env"), "utf8"));

    // Two files have to name one database. When they drift, `pnpm generate`
    // still succeeds and the suite fails with "run `pnpm generate` first".
    expect(resolve(PRISMA_DIRECTORY, declared?.groups?.path ?? "")).toBe(TEMPLATE_DATABASE);
  });

  it("fails with a fixable message when the template has not been generated", () => {
    const missing = join(tmpdir(), "kavo-prisma-no-such-template.db");

    expect(() => provisionTestDatabase(missing)).toThrow(/pnpm generate/);
    expect(() => provisionTestDatabase(missing)).toThrow(missing);
  });

  it("refuses to provision outside the run's scratch root", () => {
    // Falling back to the OS temp directory here would work, and leak a
    // fixture database per client forever — nothing else deletes those.
    vi.stubEnv(SCRATCH_ROOT_ENV, undefined);
    try {
      expect(() => provisionTestDatabase()).toThrow(new RegExp(SCRATCH_ROOT_ENV));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the run's scratch root", () => {
  it("is a directory while the run lasts and is gone afterwards", () => {
    // `setup()` assigns the variable itself, so `vi.stubEnv` cannot stand in
    // here; the save-and-restore window is synchronous and cannot interleave.
    const runRoot = process.env[SCRATCH_ROOT_ENV];
    const teardown = setup();
    const root = process.env[SCRATCH_ROOT_ENV] ?? "";
    try {
      expect(root).not.toBe(runRoot);
      expect(statSync(root).isDirectory()).toBe(true);
    } finally {
      teardown();
      if (runRoot !== undefined) {
        process.env[SCRATCH_ROOT_ENV] = runRoot;
      }
    }

    // Teardown is the entire reason this hook sits in the root vitest config:
    // drop it and every run leaves a tree of SQLite copies behind.
    expect(existsSync(root)).toBe(false);
    expect(process.env[SCRATCH_ROOT_ENV]).toBe(runRoot);
  });
});
