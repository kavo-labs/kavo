import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import type { MikroORM } from "@mikro-orm/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { AppModule } from "../src/app.module.js";
import { createPostgresOrm } from "../src/database.js";
import { registerCrudE2eSuite } from "./crud-e2e.suite.js";
import { listen } from "./support/listen.js";

/**
 * Same suite as `app-postgres.e2e.spec.ts`, against PGlite instead of a
 * Testcontainers-provisioned Postgres — real Postgres wire-protocol
 * semantics (`ILIKE`, SQLSTATE 23505) with no Docker daemon required.
 *
 * `@mikro-orm/postgresql` speaks the Postgres wire protocol over `pg`, and
 * PGlite has no wire-protocol server of its own — `pglite-socket` is what
 * bridges the two, fronting an in-process `PGlite` instance with a real TCP
 * socket. `maxConnections` is raised above its default of 1 because
 * MikroORM's Postgres driver pools connections; the suite itself issues
 * requests sequentially, but the pool may still open more than one.
 */
let db: PGlite;
let socketServer: PGLiteSocketServer;
let orm: MikroORM;
let app: INestApplication;

beforeAll(async () => {
  db = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", maxConnections: 10 });

  let boundPort = 0;
  socketServer.addEventListener(
    "listening",
    (event) => {
      boundPort = (event as CustomEvent<{ port: number }>).detail.port;
    },
    { once: true },
  );
  await socketServer.start();

  orm = await createPostgresOrm({
    host: "127.0.0.1",
    port: boundPort,
    user: "postgres",
    password: "postgres",
    dbName: "postgres",
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ orm, caseInsensitiveFilters: true })],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
}, 60_000);

afterAll(async () => {
  // Each step is guarded: a failure closing the app must still stop the
  // socket server and the PGlite instance, or the runner leaks both for the
  // rest of the session.
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
      try {
        if (socketServer !== undefined) {
          await socketServer.stop();
        }
      } finally {
        if (db !== undefined) {
          await db.close();
        }
      }
    }
  }
}, 30_000);

registerCrudE2eSuite(
  () => app,
  () => orm,
);
