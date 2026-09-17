import { expectTypeOf } from "vitest";
import { createKavo } from "@kavo/core";
import type { KavoSchema, ListResultDto, SchemaParseResult } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * ADR-0055: `schema.input.<slot>`/`schema.output.<slot>` narrow
 * `KavoService`'s typed surface via `SchemaOutput<S>` inference, the same
 * way a registered `dto` class does — at the entity's root `schema` map,
 * and independently per operation via `operations.<id>.schema`.
 */

interface CreateAuthorRequest {
  readonly name: string;
}

interface AuthorCreated {
  readonly id: number;
}

interface AuthorProfile {
  readonly id: number;
  readonly name: string;
  readonly bio: string;
}

function schemaOf<Output>(): KavoSchema<Output> {
  return {
    safeParse: (input: unknown): SchemaParseResult<Output> => ({ success: true, data: input as Output }),
  };
}

const kavo = createKavo();

// Root `schema.input`/`schema.output` narrow the entity-wide generics, the
// same way `dto.create`/`dto.item` do.
const authors = kavo.createCrud(Author, {
  schema: {
    input: { create: schemaOf<CreateAuthorRequest>() },
    output: { item: schemaOf<AuthorProfile>() },
  },
});
expectTypeOf(authors.createOne).parameter(0).toEqualTypeOf<CreateAuthorRequest>();
expectTypeOf(authors.createOne).returns.resolves.toEqualTypeOf<AuthorProfile>();
expectTypeOf(authors.findOne).returns.resolves.toEqualTypeOf<AuthorProfile>();
expectTypeOf(authors.findMany).returns.resolves.toEqualTypeOf<ListResultDto<AuthorProfile>>();

// A per-operation `schema` override narrows just that operation,
// independently of the entity's root `schema` (and of `dto`).
const overridden = kavo.createCrud(Author, {
  operations: {
    createOne: { schema: { input: schemaOf<CreateAuthorRequest>(), output: schemaOf<AuthorCreated>() } },
  },
});
expectTypeOf(overridden.createOne).parameter(0).toEqualTypeOf<CreateAuthorRequest>();
expectTypeOf(overridden.createOne).returns.resolves.toEqualTypeOf<AuthorCreated>();

// An operation with neither `schema` nor `dto` configured keeps the
// entity-derived default.
expectTypeOf(overridden.updateOne).returns.resolves.toEqualTypeOf<Author>();
