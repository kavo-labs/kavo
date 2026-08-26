import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MariaDbContainer, type StartedMariaDbContainer } from "@testcontainers/mariadb";
import { AppModule } from "../src/app.module.js";
import { registerCrudE2eSuite } from "./crud-e2e.suite.js";
import { listen } from "./support/listen.js";

/**
 * Same suite as `app.e2e.spec.ts`, run against a real MariaDB instead of
 * in-memory SQLite. `AppModule.forRoot(mariadb)` takes the connection
 * options directly — no manual MariaDB setup needed to run `pnpm check`,
 * since the options come from a container this test provisions itself.
 */
let container: StartedMariaDbContainer;
let app: INestApplication;

beforeAll(async () => {
  container = await new MariaDbContainer("mariadb:12").start();

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        type: "mariadb",
        host: container.getHost(),
        port: container.getPort(),
        username: container.getUsername(),
        password: container.getUserPassword(),
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
