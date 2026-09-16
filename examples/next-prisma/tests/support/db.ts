import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../src/generated/prisma/client";

/** The SQLite file `pnpm generate` (`prisma db push`) builds — never opened directly, only copied. */
const TEMPLATE_DATABASE = fileURLToPath(new URL("../../dev.db", import.meta.url));

/**
 * A Prisma Client bound to a fresh copy of the generated database, so this
 * spec never mutates the checked-out `dev.db` a developer might also be
 * running `next dev` against.
 */
export function newTestPrismaClient(): PrismaClient {
  if (!existsSync(TEMPLATE_DATABASE)) {
    throw new Error(`No test-fixture database at ${TEMPLATE_DATABASE} — run \`pnpm generate\` first.`);
  }
  const directory = mkdtempSync(join(tmpdir(), "kavo-next-prisma-"));
  const databasePath = join(directory, "dev.db");
  copyFileSync(TEMPLATE_DATABASE, databasePath);
  const adapter = new PrismaBetterSqlite3({ url: `file:${databasePath}` });
  return new PrismaClient({ adapter });
}
