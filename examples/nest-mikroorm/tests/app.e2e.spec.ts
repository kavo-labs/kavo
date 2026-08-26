import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import type { MikroORM } from "@mikro-orm/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { createSqliteOrm } from "../src/database.js";
import { registerCrudE2eSuite } from "./crud-e2e.suite.js";
import { listen } from "./support/listen.js";

/**
 * The default suite: in-memory SQLite, so `pnpm check` gets the full
 * Nest → engine → MikroORM → database path with no Docker daemon, no
 * downloads, and no manual setup.
 *
 * `caseInsensitiveFilters` is left at its default `false` here — `$ilike`
 * is PostgreSQL-only, and on SQLite the degraded `$like` is already ASCII
 * case-insensitive, so the suite's ILIKE assertion holds either way.
 * `app-postgres.e2e.spec.ts` runs the same assertions with the flag on,
 * against the one driver where it is a real `ILIKE`.
 */
let orm: MikroORM;
let app: INestApplication;

beforeAll(async () => {
  orm = await createSqliteOrm();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ orm })],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
}, 60_000);

afterAll(async () => {
  // An `app.close()` rejection must not strand the ORM's connection pool.
  try {
    if (app !== undefined) {
      await app.close();
    }
  } finally {
    if (orm !== undefined) {
      await orm.close();
    }
  }
});

registerCrudE2eSuite(
  () => app,
  () => orm,
);
