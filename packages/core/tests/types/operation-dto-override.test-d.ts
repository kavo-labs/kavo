import { expectTypeOf } from "vitest";
import { createKavo } from "@kavo/core";
import type { EntityInput, ListResultDto } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * Per-operation DTO override (issue #131): `operations.<id>.dto.<field>`
 * narrows one operation's request body, response, or query independently
 * of the entity's root `dto` slot and of every other operation.
 */

class CreateAuthorRequestDto {
  name = "";
}

class AuthorCreatedDto {
  id = 0;
}

class AuthorProfileDto {
  id = 0;
  name = "";
  bio = "";
}

class AuthorSearchQueryDto {
  q?: string;
}

class AuthorListItemDto {
  id = 0;
}

const kavo = createKavo();

const authors = kavo.createCrud(Author, {
  operations: {
    createOne: { schema: { input: CreateAuthorRequestDto, output: AuthorCreatedDto } },
    findOne: { schema: { output: AuthorProfileDto, query: AuthorSearchQueryDto } },
    findMany: { schema: { output: AuthorListItemDto, query: AuthorSearchQueryDto } },
  },
});

// `createOne`'s request body and response follow its own override, not the
// entity-derived default (`EntityInput<Author>` / `Author`).
expectTypeOf(authors.createOne).parameter(0).toEqualTypeOf<CreateAuthorRequestDto>();
expectTypeOf(authors.createOne).returns.resolves.toEqualTypeOf<AuthorCreatedDto>();

// `findOne`'s response and query follow its own override — a *different*
// shape from createOne's, on the same entity.
expectTypeOf(authors.findOne).parameter(1).toEqualTypeOf<AuthorSearchQueryDto | undefined>();
expectTypeOf(authors.findOne).returns.resolves.toEqualTypeOf<AuthorProfileDto>();
expectTypeOf(authors.findOne).returns.resolves.not.toEqualTypeOf<AuthorCreatedDto>();

// `findMany`'s element type and query follow its own override too — the
// list envelope still wraps it in `ListResultDto`.
expectTypeOf(authors.findMany).parameter(0).toEqualTypeOf<AuthorSearchQueryDto | undefined>();
expectTypeOf(authors.findMany).returns.resolves.toEqualTypeOf<ListResultDto<AuthorListItemDto>>();

// An operation that declares no override keeps the entity-wide default —
// `updateOne` was never mentioned, so it stays `EntityInput<Author>` in and
// `Author` out.
expectTypeOf(authors.updateOne).parameter(1).toEqualTypeOf<EntityInput<Author>>();
expectTypeOf(authors.updateOne).returns.resolves.toEqualTypeOf<Author>();

// An override on a position an operation lacks (`deleteOne`'s output,
// `createOne`'s query, `findOne`'s input) is no longer a type error: it is
// rejected at bootstrap with a `ConfigurationException` (see engine.spec.ts).

// `restoreOne` narrows independently too, reusing the `item` slot's
// *position* but not necessarily its type.
const restorable = kavo.createCrud(Author, {
  operations: { restoreOne: { schema: { output: AuthorProfileDto } } },
});
expectTypeOf(restorable.restoreOne).returns.resolves.toEqualTypeOf<AuthorProfileDto>();
