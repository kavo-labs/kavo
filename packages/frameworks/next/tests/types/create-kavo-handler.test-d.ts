import { createCrud } from "@kavo/core";
import { createKavoHandler, buildKavoSchemas } from "@kavo/next";

/**
 * Regression for the variance bug this package's own `KavoHandlerEntities`
 * type had to fix: `DefaultKavoService<Entity>.engine` is invariant in
 * `Entity` (`KavoEngine<Entity>.execute` both consumes and produces
 * `Entity`-shaped data), so a caller's own differently-typed `createCrud`
 * results — never pre-erased to `DefaultKavoService<object>` — must all be
 * assignable into one `createKavoHandler`/`buildKavoSchemas` call. This
 * file exercises only the type-checker (`tsc -p tsconfig.tests.json`); it
 * is never executed by vitest (see CLAUDE.md's `*.test-d.ts` convention).
 */

class Author {
  id!: number;
  name!: string;
}

class Book {
  id!: number;
  title!: string;
}

declare const authors: ReturnType<typeof createCrud<Author>>;
declare const books: ReturnType<typeof createCrud<Book>>;

// Two structurally unrelated entity types in one map must type-check with
// no cast at the call site — this is exactly what failed before the
// KavoHandlerEntities widening (examples/next-prisma's { authors, books }
// call is the same shape).
createKavoHandler({ authors, books });
buildKavoSchemas({ authors, books });
