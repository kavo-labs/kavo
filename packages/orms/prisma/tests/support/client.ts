import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { SCRATCH_ROOT_ENV } from "./global-setup.js";

/**
 * The SQLite file `pnpm generate` (`prisma db push`) builds from
 * `prisma/schema.prisma`. No test ever opens it: it is a *template*, copied
 * per client, which is what keeps the spec files from sharing one database.
 *
 * Must name the same file as `DATABASE_URL` in `prisma/.env`, which is what
 * `prisma db push` writes; `database-isolation.spec.ts` pins the pair.
 */
export const TEMPLATE_DATABASE = fileURLToPath(new URL("../../prisma/template.db", import.meta.url));

/**
 * A finished `db push` leaves a checkpointed, sidecar-free database behind,
 * but copy whatever recovery sidecars do exist so the copy carries every
 * committed transaction the template does. `-shm` is deliberately *not*
 * copied: it is a derived wal-index that SQLite rebuilds on open, and a
 * copied one can be stale enough to make SQLite skip recovering the `-wal`.
 *
 * `-wal` and the `-shm` exclusion are pinned by
 * `database-isolation.spec.ts`. `-journal` is not: a rollback journal only
 * outlives its transaction after a crash mid-`db push`, and the only test
 * that could cover it would restate this array rather than exercise SQLite.
 */
const DATABASE_FILE_SUFFIXES = ["", "-journal", "-wal"];

/**
 * Copies the template database to a fresh directory under this run's scratch
 * root (`tests/support/global-setup.ts`, which also removes it afterwards) and
 * returns the copy's path. Exported for its own error path; specs want
 * {@link newTestPrismaClient}.
 */
export function provisionTestDatabase(templatePath: string = TEMPLATE_DATABASE): string {
  if (!existsSync(templatePath)) {
    throw new Error(`No Prisma test-fixture database at ${templatePath} — run \`pnpm generate\` first.`);
  }
  // No silent fallback to the OS temp directory: a copy made outside this
  // run's scratch root has nothing to delete it, so a missing global setup
  // would leak a fixture database per client instead of being noticed.
  const scratchRoot = process.env[SCRATCH_ROOT_ENV];
  if (scratchRoot === undefined) {
    throw new Error(
      `${SCRATCH_ROOT_ENV} is unset — vitest's globalSetup (tests/support/global-setup.ts) did not run for this process.`,
    );
  }
  const directory = mkdtempSync(join(scratchRoot, "db-"));
  const databasePath = join(directory, basename(templatePath));
  for (const suffix of DATABASE_FILE_SUFFIXES) {
    if (existsSync(`${templatePath}${suffix}`)) {
      copyFileSync(`${templatePath}${suffix}`, `${databasePath}${suffix}`);
    }
  }
  return databasePath;
}

/**
 * A Prisma Client bound to a database file of its own.
 *
 * Vitest runs spec files in parallel workers and SQLite admits one writer at a
 * time, so pointing every spec at one file made the suite a lottery on a
 * loaded CI runner: a `beforeEach` write chain in one file could hold the file
 * lock long enough for another file's query to die with `P1008` (issue #101).
 * Copying the template per client removes the contended resource rather than
 * widening the timeout around it, so the specs still run in parallel.
 *
 * `datasourceUrl` is passed explicitly — bypassing `env("DATABASE_URL")` —
 * because a plain `vitest run` has no reason to have that variable set; the
 * CLI commands that build the template (`generate`, `db push`) load it from
 * `prisma/.env` on their own.
 *
 * `databasePath` exists for the one case a fresh copy cannot serve: two
 * clients that must meet on the same file, which is how
 * `database-isolation.spec.ts` builds a database with an unfinished WAL.
 */
export function newTestPrismaClient(databasePath: string = provisionTestDatabase()): PrismaClient {
  return new PrismaClient({ datasourceUrl: `file:${databasePath}` });
}
