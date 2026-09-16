import { NotFoundException, createKavo } from "@kavo/core";
import { createInfrastructure } from "@kavo/prisma";
import metadata from "../../src/generated/kavo-metadata";
import { Author } from "../../src/author.entity";
import { Book } from "../../src/book.entity";
import { newTestPrismaClient } from "./db";

/**
 * The same entity wiring `src/kavo.ts` exports, rebuilt per test against a
 * fresh database copy (`newTestPrismaClient`) — duplicated rather than
 * imported because `src/kavo.ts` binds to the checked-out `dev.db` at
 * module load, and parallel test files must not share that file.
 */
export function buildTestApp() {
  const prisma = newTestPrismaClient();
  const kavo = createKavo({
    infrastructure: createInfrastructure(prisma as never, {
      metadata,
      entities: [Author, Book],
      caseInsensitiveFilters: false,
    }),
  });

  const authors = kavo.createCrud<Author>(Author, {
    filter: { fields: ["id", "name", "email"] },
    sort: { fields: ["id", "name"] },
    include: { fields: ["books"] },
  });

  const books = kavo.createCrud<Book>(Book, {
    filter: { fields: ["id", "title", "published", "authorId"] },
    sort: { fields: ["id", "title"] },
    include: { fields: ["author"] },
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
