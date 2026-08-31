import { expectTypeOf } from "vitest";
import { createCrud } from "@kavo/core";
import type { EntityInput, ListResultDto } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * Usage example 1 of 3: **zero-config**.
 *
 * This is the shape issue #6 requires to work with no manual generic
 * arguments, and it is the file the guide quotes — so if the surface moves,
 * the typecheck gate fails before the docs can rot. Nothing here executes
 * (`.test-d.ts` is compile-only), so no infrastructure is needed.
 */

const authors = createCrud(Author);

// Reads: the entity itself, and the envelope around it.
expectTypeOf(authors.findOne).returns.resolves.toEqualTypeOf<Author>();
expectTypeOf(authors.findMany).returns.resolves.toEqualTypeOf<ListResultDto<Author>>();

// Writes: the derived partial-scalar body. `createOne({ name })` is exactly
// the call that did not compile before — `EntityInput` required every key,
// so zero-config demanded `id` and `posts`.
expectTypeOf(authors.createOne).parameter(0).toEqualTypeOf<EntityInput<Author>>();
void authors.createOne({ name: "Ada" });
void authors.updateOne(1, { name: "Ada Lovelace" });
void authors.patchOne(1, { name: "Ada L." });

async function envelope(): Promise<void> {
  // The destructuring from the issue, verbatim: spell-checked include path
  // and the relation-keyed fieldset, both inferred from `Author` alone.
  const { items, total, limit, offset } = await authors.findMany({
    include: ["posts.comments"],
    select: { posts: ["id", "title"] },
  });

  expectTypeOf(items).toEqualTypeOf<readonly Author[]>();
  // `total` is nullable on purpose: counting can be switched off.
  expectTypeOf(total).toEqualTypeOf<number | null>();
  expectTypeOf(limit).toEqualTypeOf<number>();
  expectTypeOf(offset).toEqualTypeOf<number>();
}
void envelope;

// @ts-expect-error — a misspelled include path fails at compile time.
void authors.findMany({ include: ["posts.commentz"] });

// @ts-expect-error — relations are associated by id, never written inline (ADR-0014).
void authors.createOne({ posts: [] });
