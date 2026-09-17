import { createPrismaKavo } from "@kavo/prisma";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import metadata, { entities } from "../generated/kavo-metadata";

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "file:./dev.db" });
const prisma = new PrismaClient({ adapter });

/**
 * The app's only `@kavo/next` root import point, mirroring `examples/nest-*`'s
 * `app.module.ts` role: every entity's `<entity>.service.ts` calls
 * `kavo.createCrud` against this one instance, and
 * `app/api/[...kavo]/route.ts` and `app/api/openapi.json/route.ts` both
 * import the resulting services rather than building their own.
 */
export const kavo = createPrismaKavo(prisma as never, {
  metadata,
  entities,
  // SQLite rejects Prisma's `mode: "insensitive"` string-filter argument.
  caseInsensitiveFilters: false,
});
