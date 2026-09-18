import { expectTypeOf } from "vitest";
import { createKavo } from "@kavo/core";
import type { EntityInput, ListResultDto, QueryContext } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * Usage example 2 of 3: **partially configured** — global defaults plus two
 * DTO slots, which is the second shape issue #6 spells out.
 *
 * The load-bearing assertion is the last one: registering `item` and `list`
 * must narrow *exactly* those two slots and leave the write and query slots
 * on their derived defaults. A generic-default chain that leaks would show
 * up here as `createOne` demanding an item DTO.
 */

class AuthorItemDto {
  id = 0;
  name = "";
}

class AuthorListDto {
  id = 0;
}

const kavo = createKavo({ defaults: { pagination: { maxLimit: 50 } } });

const authors = kavo.createCrud(Author, {
  schema: { output: { item: AuthorItemDto, list: AuthorListDto } },
});

// The two registered slots, narrowed.
expectTypeOf(authors.findOne).returns.resolves.toEqualTypeOf<AuthorItemDto>();
expectTypeOf(authors.findMany).returns.resolves.toEqualTypeOf<ListResultDto<AuthorListDto>>();

// `item` also types the write *responses* — one slot, both directions.
expectTypeOf(authors.createOne).returns.resolves.toEqualTypeOf<AuthorItemDto>();

// …and nothing else moved: the write and query slots stay derived.
expectTypeOf(authors.createOne).parameter(0).toEqualTypeOf<EntityInput<Author>>();
expectTypeOf(authors.updateOne).parameter(1).toEqualTypeOf<EntityInput<Author>>();
expectTypeOf(authors.patchOne).parameter(1).toEqualTypeOf<Partial<EntityInput<Author>>>();
expectTypeOf(authors.findMany).parameter(0).toEqualTypeOf<QueryContext<Author> | undefined>();

// The query slot still being `QueryContext<Author>` is what keeps include
// paths spell-checked in a partially configured setup.
void authors.findMany({ include: ["posts.comments"] });

// @ts-expect-error — still spell-checked here.
void authors.findMany({ include: ["posts.commentz"] });
