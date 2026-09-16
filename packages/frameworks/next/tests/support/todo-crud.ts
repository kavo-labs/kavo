import { createCrud, type DefaultKavoService } from "@kavo/core";
import "../../src/route-metadata.js";
import { InMemoryTodoAdapter, Todo, todoMetadata } from "./fake-infrastructure.js";

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
