import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Controller } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigurationException } from "@kavo/core";
import { Kavo, KavoModule } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";

/**
 * `resolveEntityConfig`'s rejection of a root-level `policy` map
 * (`packages/core/tests/policy.spec.ts` pins the core-level behavior
 * directly) only actually runs once `createCrud` is called — for a
 * `@Kavo`-decorated class that happens in `KavoBinder.onModuleInit`
 * (`kavo.module.ts`), not at decoration time (ADR-0012: routes are
 * generated from the operation registry alone, which never resolves
 * `policy`). This pins that the rejection really does surface through
 * `KavoModule`'s bootstrap sequence, the same integration-check shape
 * `array-mutation-route-reachable.e2e.spec.ts` uses for its own
 * `createCrud`-time bootstrap error.
 */
describe("KavoModule — legacy entity-level 'policy' map (ADR-0033)", () => {
  it("rejects at bootstrap, naming operations.<id>.policy as the replacement", async () => {
    @Kavo(Todo, { policy: { updateOne: ["todo:update"] } } as never)
    @Controller("todos")
    class TodoController {}

    const moduleRef = Test.createTestingModule({
      imports: [
        KavoModule.forRootAsync({
          useFactory: () => ({ infrastructure: fakeInfrastructure(new InMemoryTodoAdapter()) }),
        }),
      ],
      controllers: [TodoController],
    });
    const app = await moduleRef.compile();
    await expect(app.init()).rejects.toBeInstanceOf(ConfigurationException);
    const error = (await app.init().catch((thrown: unknown) => thrown)) as ConfigurationException;
    expect(error.code).toBe("KAVO_CONFIG_INVALID");
    expect(error.context.entityName).toBe("Todo");
    expect(error.messageParams).toMatchObject({ path: "policy" });
    expect(error.detail).toContain("operations.<id>.policy");
  });
});
