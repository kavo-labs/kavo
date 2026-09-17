import { NotFoundException } from "@kavo/core";
import { kavo } from "../../lib/kavo";
import { Book } from "../../generated/kavo-metadata";
import { CreateBookSchema, UpdateBookSchema } from "./book.schema";

/**
 * `publishOne` is a custom operation (docs/core/custom-operations.md): its
 * own registry entry, its own route (`POST /books/:id/publish`), dispatched
 * by `createKavoHandler` the same way the standard eight are — no
 * manual-method-wins equivalent needed, since there is no class to
 * override.
 */
export const books = kavo.createCrud<Book>(Book, {
  filter: { fields: ["id", "title", "published", "authorId"] },
  sort: { fields: ["id", "title"] },
  include: { fields: ["author"] },
  schema: {
    input: { create: CreateBookSchema, update: UpdateBookSchema },
  },
  operations: {
    createOne: true,
    findOne: true,
    findMany: true,
    updateOne: true,
    patchOne: true,
    deleteOne: true,
    publishOne: {
      handler: {
        async execute(input: unknown, context) {
          const { id } = input as { id: number };
          const book = await context.repository.findOneById(id as never, null, context);
          if (book === null) {
            throw new NotFoundException({ messageParams: { entity: context.entityName, id: String(id) } });
          }
          return context.repository.patch(id as never, { published: true }, context);
        },
      },
      meta: { routes: { method: "POST", path: ":id/publish" } },
    },
  },
});
