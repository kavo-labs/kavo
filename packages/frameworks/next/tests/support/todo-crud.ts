import { createCrud, createKavo, type DefaultKavoService, type KavoInstance } from "@kavo/core";
import "../../src/route-metadata.js";
import { fakeInfrastructure, InMemoryTodoAdapter, Todo, todoMetadata } from "./fake-infrastructure.js";

/**
 * A bound `Todo` service wired for route-dispatch tests: standard CRUD,
 * soft delete (`restoreOne` on by default once `delete.strategy` is
 * declared, `purgeOne` opted in explicitly), and one custom operation
 * (`markPaidOne`) with an explicit `meta.routes` — the same
 * `operations.markPaidOne` shape `@kavo/core`'s own registry tests use
 * (issue #145), so dispatch here is proven against the same contract
 * `@kavo/nest`'s route generation reads.
 */
export function buildTodoCrud(): { service: DefaultKavoService<object>; adapter: InMemoryTodoAdapter } {
  const adapter = new InMemoryTodoAdapter();
  const service = createCrud(
    Todo,
    {
      delete: { strategy: "soft" },
      search: { fields: ["title"] },
      operations: {
        createOne: true,
        findOne: true,
        findMany: true,
        updateOne: true,
        patchOne: true,
        deleteOne: true,
        restoreOne: true,
        purgeOne: true,
        markPaidOne: {
          handler: {
            async execute(input: unknown) {
              const { id } = input as { id: number };
              const row = adapter.rows.find((candidate) => candidate.id === id);
              if (row === undefined) {
                throw new Error("not found");
              }
              row.done = true;
              return row;
            },
          },
          meta: { routes: { method: "POST", path: ":id/mark-paid" } },
        },
      },
    } as never,
    { metadata: todoMetadata, adapter },
  ) as unknown as DefaultKavoService<object>;
  return { service, adapter };
}

/**
 * Same shape as {@link buildTodoCrud}, but with `EntityConfig.schema`
 * set to whatever the caller passes — for `createKavoHandler`'s
 * `EntityConfig.schema` dispatch tests (ADR-0056), which need a schema
 * registered on the entity itself rather than on `buildTodoCrud`'s fixed
 * config.
 */
export function buildTodoCrudWithSchema(schema: {
  readonly create?: unknown;
  readonly update?: unknown;
  readonly patch?: unknown;
}): { service: DefaultKavoService<object>; adapter: InMemoryTodoAdapter } {
  const adapter = new InMemoryTodoAdapter();
  const service = createCrud(
    Todo,
    {
      delete: { strategy: "soft" },
      schema,
      operations: {
        createOne: true,
        findOne: true,
        findMany: true,
        updateOne: true,
        patchOne: true,
        deleteOne: true,
      },
    } as never,
    { metadata: todoMetadata, adapter },
  ) as unknown as DefaultKavoService<object>;
  return { service, adapter };
}

/**
 * A `Todo` service registered against a real `KavoInstance` root (rather
 * than the bare-`createCrud` sugar `buildTodoCrud` uses), for the
 * `createKavoHandler(instance)` auto-discovery form — `instance` is what a
 * test hands to `createKavoHandler` directly, `service`/`adapter` are for
 * asserting against the same registration `instance.services()` sees.
 */
export function buildTodoCrudOnInstance(): {
  instance: KavoInstance;
  service: DefaultKavoService<object>;
  adapter: InMemoryTodoAdapter;
} {
  const adapter = new InMemoryTodoAdapter();
  const instance = createKavo({ infrastructure: fakeInfrastructure(adapter) });
  const service = instance.createCrud(Todo, {
    delete: { strategy: "soft" },
  } as never) as unknown as DefaultKavoService<object>;
  return { instance, service, adapter };
}

/**
 * A variant with a custom read operation configured to collide with
 * `findOne`'s own route (`GET :id`) — for pinning down which one
 * `createKavoHandler` dispatches to when two registry entries resolve the
 * identical method+path (ADR-0012: registration order is route-generation
 * order, and a custom id registers ahead of the standard table).
 */
export function buildTodoCrudWithCollidingCustomOp(): {
  service: DefaultKavoService<object>;
  adapter: InMemoryTodoAdapter;
} {
  const adapter = new InMemoryTodoAdapter();
  const service = createCrud(
    Todo,
    {
      operations: {
        createOne: true,
        findOne: true,
        findMany: true,
        updateOne: true,
        patchOne: true,
        deleteOne: true,
        findOneCollision: {
          kind: "read",
          handler: {
            // Marks a real Todo column so the assertion survives
            // projection through the entity's own columns (custom
            // operations with no `dto.output` are projected that way —
            // an ad-hoc extra field would be silently dropped).
            async execute(input: unknown) {
              const { id } = input as { id: number };
              const row = adapter.rows.find((candidate) => candidate.id === id);
              return { ...row, title: "custom-operation-won" };
            },
          },
          meta: { routes: { method: "GET", path: ":id" } },
        },
      },
    } as never,
    { metadata: todoMetadata, adapter },
  ) as unknown as DefaultKavoService<object>;
  return { service, adapter };
}
