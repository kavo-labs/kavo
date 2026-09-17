import { NotFoundException, createKavo } from "@kavo/core";
import { createInfrastructure } from "@kavo/prisma";
import metadata, { entities, Author, Book } from "../../generated/kavo-metadata";
import { newTestPrismaClient } from "./db";
import { createAuthorSchema, patchAuthorSchema, updateAuthorSchema } from "../../entities/author/author.schema";
import { createBookSchema, patchBookSchema, updateBookSchema } from "../../entities/book/book.schema";

/**
 * The same entity wiring `lib/kavo.ts` + `entities/*.service.ts` export,
 * rebuilt per test against a fresh database copy (`newTestPrismaClient`) —
 * duplicated rather than imported because `lib/kavo.ts` binds to the
 * checked-out `dev.db` at module load, and parallel test files must not
 * share that file.
 */
export function buildTestApp() {
  const prisma = newTestPrismaClient();
  const kavo = createKavo({
    infrastructure: createInfrastructure(prisma as never, {
      metadata,
      entities,
      caseInsensitiveFilters: false,
    }),
  });

  const authors = kavo.createCrud<Author>(Author, {
    filter: { fields: ["id", "name", "email"] },
    sort: { fields: ["id", "name"] },
    include: { fields: ["books"] },
    validate: { create: createAuthorSchema, update: updateAuthorSchema, patch: patchAuthorSchema },
  });

  const books = kavo.createCrud<Book>(Book, {
    filter: { fields: ["id", "title", "published", "authorId"] },
    sort: { fields: ["id", "title"] },
    include: { fields: ["author"] },
    validate: { create: createBookSchema, update: updateBookSchema, patch: patchBookSchema },
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

  return { authors, books };
}
