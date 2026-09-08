import { bench, describe } from "vitest";
import { createFixture } from "./create-fixture.js";

const { service } = createFixture(1_000);

describe("readOne", () => {
  bench("find by id", async () => {
    await service.findOne(500);
  });
});

describe("readMany", () => {
  bench("list 20 (default pagination)", async () => {
    await service.findMany({ pagination: { limit: 20, offset: 0 } });
  });

  bench("list 100", async () => {
    await service.findMany({ pagination: { limit: 100, offset: 0 } });
  });
});

describe("createOne", () => {
  bench("insert", async () => {
    await service.createOne({ title: "bench", done: false, priority: 1 });
  });
});

describe("updateOne", () => {
  bench("full update", async () => {
    await service.updateOne(500, { title: "updated", done: true, priority: 9 });
  });
});

describe("patchOne", () => {
  bench("partial update", async () => {
    await service.patchOne(500, { done: true });
  });
});

describe("deleteOne", () => {
  bench("delete", async () => {
    await service.deleteOne(500);
  });
});
