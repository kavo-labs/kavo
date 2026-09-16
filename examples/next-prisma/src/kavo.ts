import { NotFoundException } from "@kavo/core";
import { createPrismaKavo } from "@kavo/prisma";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client";
import metadata from "./generated/kavo-metadata";
import { Author } from "./author.entity";
import { Book } from "./book.entity";

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "file:./dev.db" });
const prisma = new PrismaClient({ adapter });

const kavo = createPrismaKavo(prisma as never, {
  metadata,
  entities: [Author, Book],
  // SQLite rejects Prisma's `mode: "insensitive"` string-filter argument.
  caseInsensitiveFilters: false,
});

/**
 * The app's only `@kavo/next` import point, mirroring `examples/nest-*`'s
 * `app.module.ts` role: every entity's `createCrud` call lives here, and
 * `app/api/[...kavo]/route.ts` and `app/api/openapi.json/route.ts` both
 * import the resulting services rather than building their own.
 */
export const authors = kavo.createCrud<Author>(Author, {
  filter: { fields: ["id", "name", "email"] },
  sort: { fields: ["id", "name"] },
  include: { fields: ["books"] },
});

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
