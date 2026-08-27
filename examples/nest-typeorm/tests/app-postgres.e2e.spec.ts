import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { AppModule } from "../src/app.module.js";
import { registerCrudE2eSuite } from "./crud-e2e.suite.js";
import { registerCatE2eSuite } from "./cat-e2e.suite.js";
import { registerOwnerE2eSuite } from "./owner-e2e.suite.js";
import { registerDogE2eSuite } from "./dog-e2e.suite.js";
import { registerAddressE2eSuite } from "./address-e2e.suite.js";
import { registerTagE2eSuite } from "./tag-e2e.suite.js";
import { registerPhotoE2eSuite } from "./photo-e2e.suite.js";
import { registerPetTagE2eSuite } from "./pet-tag-e2e.suite.js";
import { registerOwnerSettingE2eSuite } from "./owner-setting-e2e.suite.js";
import { listen } from "./support/listen.js";

/**
 * Same suite as `app.e2e.spec.ts`, run against a real Postgres instead of
 * in-memory SQLite. `AppModule.forRoot(postgres)` takes the connection
 * options directly — no manual Postgres setup needed to run `pnpm check`,
 * since the options come from a container this test provisions itself.
 */
let container: StartedPostgreSqlContainer;
let app: INestApplication;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18-alpine").start();

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        type: "postgres",
        host: container.getHost(),
        port: container.getPort(),
        username: container.getUsername(),
        password: container.getPassword(),
        database: container.getDatabase(),
      }),
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
}, 120_000);

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
  if (container !== undefined) {
    await container.stop();
  }
}, 30_000);

registerCrudE2eSuite(() => app);
registerCatE2eSuite(() => app);
registerOwnerE2eSuite(() => app);
registerDogE2eSuite(() => app);
registerAddressE2eSuite(() => app);
registerTagE2eSuite(() => app);
registerPhotoE2eSuite(() => app);
registerPetTagE2eSuite(() => app);
registerOwnerSettingE2eSuite(() => app);
