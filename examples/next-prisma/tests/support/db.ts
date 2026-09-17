import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../generated/prisma/client";
import { SCRATCH_ROOT_ENV } from "./global-setup.js";

/** The SQLite file `pnpm generate` (`prisma db push`) builds — never opened directly, only copied. */
const TEMPLATE_DATABASE = fileURLToPath(new URL("../../dev.db", import.meta.url));

/**
 * A Prisma Client bound to a fresh copy of the generated database, so this
 * spec never mutates the checked-out `dev.db` a developer might also be
 * running `next dev` against. The copy lives under this run's scratch root
 * (`global-setup.ts`), which removes it — and every sibling copy — when the
 * run ends, rather than leaking one directory per test into the OS temp
 * directory the way an un-cleaned `tmpdir()` copy would.
 */
export function newTestPrismaClient(): PrismaClient {
  if (!existsSync(TEMPLATE_DATABASE)) {
    throw new Error(`No test-fixture database at ${TEMPLATE_DATABASE} — run \`pnpm generate\` first.`);
  }
  const scratchRoot = process.env[SCRATCH_ROOT_ENV];
  if (scratchRoot === undefined) {
    throw new Error(`${SCRATCH_ROOT_ENV} is unset — vitest's globalSetup (tests/support/global-setup.ts) did not run.`);
  }
  const directory = mkdtempSync(join(scratchRoot, "db-"));
  const databasePath = join(directory, "dev.db");
  copyFileSync(TEMPLATE_DATABASE, databasePath);
  const adapter = new PrismaBetterSqlite3({ url: `file:${databasePath}` });
  return new PrismaClient({ adapter });
}
