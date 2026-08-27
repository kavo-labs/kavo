import "reflect-metadata";
import { afterAll, beforeAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
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
registerCatE2eSuite(() => app);
registerOwnerE2eSuite(() => app);
registerDogE2eSuite(() => app);
registerAddressE2eSuite(() => app);
registerTagE2eSuite(() => app);
registerPhotoE2eSuite(() => app);
registerPetTagE2eSuite(() => app);
registerOwnerSettingE2eSuite(() => app);
