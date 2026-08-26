import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import mongoose from "mongoose";
import { MongoDBContainer, type StartedMongoDBContainer } from "@testcontainers/mongodb";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { registerCrudE2eSuite } from "./crud-e2e.suite.js";
import { listen } from "./support/listen.js";

/**
 * Same suite as `app.e2e.spec.ts`, run against a real, pinned MongoDB
 * instead of `mongodb-memory-server`'s standalone `mongod` — the document
 * counterpart to `nest-typeorm`'s Testcontainers Postgres and MariaDB
 * suites. No manual MongoDB setup is needed to run `pnpm check`, since this
 * test provisions the server itself; it does need a running Docker daemon.
 *
 * `AppModule.forRoot()` takes no connection options, unlike its TypeORM
 * counterpart: `mongoose.connection` *is* the model registry the app hands
 * to `createInfrastructure` (ADR-0018), so pointing the app at this
 * container is just connecting the default `mongoose` instance to it.
 */
let container: StartedMongoDBContainer;
let app: INestApplication;

beforeAll(async () => {
  container = await new MongoDBContainer("mongo:8").start();

  // `MongoDBContainer` always starts a single-node replica set, and
  // `rs.initiate()` advertises that member under the *container's* own
  // hostname. `directConnection` keeps the driver talking to the mapped
  // port it was given rather than chasing that unroutable address —
  // `getConnectionString()` does not set it.
  await mongoose.connect(container.getConnectionString(), {
    dbName: "kavo-examples",
    directConnection: true,
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot()],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
}, 240_000);

afterAll(async () => {
  // Each step runs even if an earlier one rejects. A half-initialized app
  // whose `close()` throws would otherwise strand the open socket — keeping
  // the worker's event loop alive — and leak the container until Ryuk
  // reaps it, turning one failed test into a hung run.
  try {
    if (app !== undefined) {
      await app.close();
    }
  } finally {
    try {
      await mongoose.disconnect();
    } finally {
      if (container !== undefined) {
        await container.stop();
      }
    }
  }
}, 30_000);

registerCrudE2eSuite(() => app);
