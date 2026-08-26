import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module.js";
import { registerCrudE2eSuite } from "./crud-e2e.suite.js";
import { listen } from "./support/listen.js";

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot()],
  }).compile();
  app = moduleRef.createNestApplication();
  await listen(app);
});

afterAll(async () => {
  // Guards against beforeAll throwing before `app` is assigned — without
  // this, a real bootstrap failure (e.g. a DI-wiring regression) is masked
  // by an unrelated TypeError here instead of surfacing its own message.
  if (app !== undefined) {
    await app.close();
  }
});

registerCrudE2eSuite(() => app);
