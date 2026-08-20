import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Controller } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigurationException } from "@kavo/core";
import { Kavo, KavoModule } from "@kavo/nest";
import { InMemoryTodoAdapter, Todo, fakeInfrastructure } from "./support/fake-infrastructure.js";

/**
 * `resolveEntityConfig`'s rejection of a malformed `policy` value
 * (`packages/core/tests/policy.spec.ts` pins the core-level behavior
 * directly) only actually runs once `createCrud` is called — for a
 * `@Kavo`-decorated class that happens in `KavoBinder.onModuleInit`
 * (`kavo.module.ts`), not at decoration time (ADR-0012: routes are
 * generated from the operation registry alone, which never resolves
 * `policy`). This pins that the rejection really does surface through
 * `KavoModule`'s bootstrap sequence, the same integration-check shape
 * `array-mutation-route-reachable.e2e.spec.ts` uses for its own
 * `createCrud`-time bootstrap error.
 *
 * The entity-scope `policy` field is real again since ADR-0036, but the
 * pre-ADR-0033 shape — a `Partial<Record<StandardOperationId,
 * PolicyShorthand>>` map — is still not a `PolicyNode` (it has no `type`
 * discriminant), so it still fails, just with a different message: "not a
 * PolicyNode" rather than "entity-scope map no longer supported."
 */
describe("KavoModule — malformed entity-level 'policy' value (the pre-ADR-0033 per-operation map shape)", () => {
  it("rejects at bootstrap, naming 'policy' and requiring a PolicyNode", async () => {
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
    expect(error.detail).toContain("PolicyNode");
  });
});
