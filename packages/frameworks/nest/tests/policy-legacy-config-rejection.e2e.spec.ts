import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Controller } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigurationException } from "@kavo/core";
import { Kavo, KavoModule } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";

/**
 * `resolveEntityConfig`'s two `policy` bootstrap rejections
 * (`packages/core/tests/policy.spec.ts` pins both directly) only actually
 * run once `createCrud` is called — for a `@Kavo`-decorated class that
 * happens in `KavoBinder.onModuleInit` (`kavo.module.ts`), not at
 * decoration time (ADR-0012: routes are generated from the operation
 * registry alone, which never resolves `policy`). This pins that both
 * rejections really do surface through `KavoModule`'s bootstrap sequence,
 * the same integration-check shape `array-mutation-route-reachable.e2e.spec.ts`
 * uses for its own `createCrud`-time bootstrap error.
 */
describe("KavoModule — 'policy' bootstrap rejection (ADR-0037)", () => {
  it("rejects a non-function entity-level 'policy' default — including a per-operation map shape", async () => {
    @Kavo(Todo, { policy: { updateOne: () => false } } as never)
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
    expect(error.detail).toContain("must be a function");
  });

  it("rejects a non-function 'operations.<id>.policy'", async () => {
    @Kavo(Todo, { operations: { updateOne: { policy: "todo:update" } } } as never)
    @Controller("todos2")
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
    expect(error.detail).toContain("operations.updateOne.policy");
  });
});
