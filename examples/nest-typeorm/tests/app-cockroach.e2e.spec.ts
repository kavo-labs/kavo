import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { CockroachDbContainer, type StartedCockroachDbContainer } from "@testcontainers/cockroachdb";
import { AppModule } from "../src/app.module.js";
import { registerCrudE2eSuite } from "./crud-e2e.suite.js";
import { listen } from "./support/listen.js";

/**
 * Same suite as `app.e2e.spec.ts`, run against a real CockroachDB instead of
 * in-memory SQLite. `AppModule.forRoot(cockroach)` takes the connection
 * options directly — no manual CockroachDB setup needed to run `pnpm check`,
 * since the options come from a container this test provisions itself.
 *
 * CockroachDB's `--insecure` mode (what the container and
 * `main-cockroach.ts` both run) has no password, unlike the Postgres and
 * MariaDB flavours.
 */
let container: StartedCockroachDbContainer;
let app: INestApplication;

beforeAll(async () => {
  container = await new CockroachDbContainer("cockroachdb/cockroach:v25.2.22").start();

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        type: "cockroachdb",
        host: container.getHost(),
        port: container.getPort(),
        username: container.getUsername(),
        database: container.getDatabase(),
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
}, 240_000);

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
  if (container !== undefined) {
    await container.stop();
  }
}, 30_000);

registerCrudE2eSuite(() => app);
