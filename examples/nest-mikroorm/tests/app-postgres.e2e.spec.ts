import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import type { MikroORM } from "@mikro-orm/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { AppModule } from "../src/app.module.js";
import { createPostgresOrm } from "../src/database.js";
import { registerCrudE2eSuite } from "./crud-e2e.suite.js";
import { listen } from "./support/listen.js";

/**
 * Same suite as `app.e2e.spec.ts`, against a real Postgres provisioned by
 * Testcontainers instead of in-memory SQLite.
 *
 * This is the only place `caseInsensitiveFilters: true` is exercised, and
 * it is the reason this spec exists rather than being a second connection
 * string. `$ilike` reaches PostgreSQL verbatim, so the suite's ILIKE
 * assertion is a genuine `ILIKE` here and a degraded `$like` on SQLite —
 * both passing is what the flag's `false` default rests on. It also puts
 * the adapter's conflict mapping in front of a real Postgres unique index
 * (SQLSTATE 23505) rather than SQLite's.
 */
let container: StartedPostgreSqlContainer;
let orm: MikroORM;
let app: INestApplication;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  orm = await createPostgresOrm({
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
    dbName: container.getDatabase(),
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ orm, caseInsensitiveFilters: true })],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
}, 120_000);

afterAll(async () => {
  // Each step is guarded: a failure closing the app must still stop the
  // container, or the runner leaks a Postgres for the rest of the session.
  try {
    if (app !== undefined) {
      await app.close();
    }
  } finally {
    try {
      if (orm !== undefined) {
        await orm.close();
      }
    } finally {
      if (container !== undefined) {
        await container.stop();
      }
    }
  }
}, 30_000);

registerCrudE2eSuite(
  () => app,
  () => orm,
);
