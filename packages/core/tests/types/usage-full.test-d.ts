import { expectTypeOf } from "vitest";
import { createKavo } from "@kavo/core";
import type { KavoContext, ListResultDto, OperationHandler, QueryContext } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * Usage example 3 of 3: **fully configured** — global defaults, all six DTO
 * slots, allowlists, relation edges and an overridden handler.
 *
 * Two things this pins that the other two files cannot: registering a
 * `create` DTO restores full strictness on the write path (the counterweight
 * to `EntityInput` being all-optional), and `patchOne` follows the
 * *overridden* `update` DTO through the `UpdateDto → PatchDto` default.
 */

class CreateAuthorDto {
  name = "";
}

class UpdateAuthorDto {
  name = "";
  bio = "";
}

class AuthorQueryDto {
  limit?: number;
}

class AuthorItemDto {
  id = 0;
  name = "";
}

class AuthorListDto {
  id = 0;
}

const kavo = createKavo({
  defaults: { pagination: { defaultLimit: 20, maxLimit: 100 } },
});

const promote: OperationHandler<Author> = {
  async execute(_input, context) {
    // The handler's context is typed to the entity, not to `object`.
    expectTypeOf(context).toEqualTypeOf<KavoContext<Author>>();
    return { promoted: true };
  },
};

const authors = kavo.createCrud(Author, {
  dto: {
    create: CreateAuthorDto,
    update: UpdateAuthorDto,
    query: AuthorQueryDto,
    item: AuthorItemDto,
    list: AuthorListDto,
  },
  allowlists: { filterable: ["name"], sortable: ["name"], selectable: ["id", "name"], includable: ["posts"] },
  operations: {
    findMany: { handler: promote },
  },
});

// Every slot resolves to the registered class.
expectTypeOf(authors.createOne).parameter(0).toEqualTypeOf<CreateAuthorDto>();
expectTypeOf(authors.updateOne).parameter(1).toEqualTypeOf<UpdateAuthorDto>();
expectTypeOf(authors.findOne).returns.resolves.toEqualTypeOf<AuthorItemDto>();
expectTypeOf(authors.findMany).returns.resolves.toEqualTypeOf<ListResultDto<AuthorListDto>>();

// `patch` was left unregistered, so it follows the overridden `update` —
// not the entity-derived default. This is the chain working end to end.
expectTypeOf(authors.patchOne).parameter(1).toEqualTypeOf<Partial<UpdateAuthorDto>>();

// A registered `query` DTO replaces `QueryContext` wholesale, which is the
// escape hatch for a hand-written query contract.
expectTypeOf(authors.findMany).parameter(0).toEqualTypeOf<AuthorQueryDto | undefined>();
expectTypeOf(authors.findMany).parameter(0).not.toEqualTypeOf<QueryContext<Author> | undefined>();

// Registering a `create` DTO restores strictness: `name` is required now.
void authors.createOne({ name: "Ada" });

// @ts-expect-error — the create DTO governs the body once registered.
void authors.createOne({});

// @ts-expect-error — and unknown keys are rejected against the DTO, not the entity.
void authors.createOne({ name: "Ada", bio: "x" });

// @ts-expect-error — an allowlist entry has to name a real field.
void kavo.createCrud(Author, { allowlists: { filterable: ["nmae"] } });

// `{ exclude }` is accepted wherever an explicit array is, and still
// type-checks each excluded path against the entity.
void kavo.createCrud(Author, { allowlists: { filterable: { exclude: ["name"] } } });

// @ts-expect-error — `{ exclude }` names have to be real fields too.
void kavo.createCrud(Author, { allowlists: { sortable: { exclude: ["nmae"] } } });

// `{ exclude }` on `selectable` type-checks the same way.
void kavo.createCrud(Author, { allowlists: { selectable: { exclude: ["name"] } } });

// @ts-expect-error — including `selectable`.
void kavo.createCrud(Author, { allowlists: { selectable: { exclude: ["nmae"] } } });

// `selectable` is capped to depth 1 (ADR-0045): a relation-dotted path does
// not type-check, unlike `filterable`/`sortable`, which take one.
// @ts-expect-error — `posts.title` is a relation-dotted path.
void kavo.createCrud(Author, { allowlists: { selectable: ["id", "posts.title"] } });
// @ts-expect-error — and the same in the `{ exclude }` form.
void kavo.createCrud(Author, { allowlists: { selectable: { exclude: ["posts.title"] } } });
// `filterable` still accepts the dotted path it always did.
void kavo.createCrud(Author, { allowlists: { filterable: ["posts.title"] } });

// Overridden and default operations dispatch through the engine, one pipeline either way.
void authors.engine.execute({ operation: "findMany", id: null, body: null, query: null, options: null });

// A global default may set the (boolean-only) operations map...
createKavo({ defaults: { operations: { deleteOne: false, restoreOne: true } } });

// @ts-expect-error — but not the richer per-entity shape (handler/meta):
// `KavoSettings.operations` is boolean-only global state (issue #38).
createKavo({ defaults: { operations: { deleteOne: { handler: promote } } } });

// @ts-expect-error — nesting `operations` inside an `OperationConfig` is a
// type error now that `OperationConfig` no longer inherits `operations`
// from `DeepPartial<KavoSettings>` (issue #38).
kavo.createCrud(Author, { operations: { findMany: { operations: {} } } });
