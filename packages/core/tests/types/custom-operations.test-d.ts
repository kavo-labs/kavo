import { expectTypeOf } from "vitest";
import { createKavo } from "@kavo/core";
import type { KavoContext, ListResultDto, OperationHandler } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * Custom operation ids (issue #145): an `operations` key outside the
 * standard eight declares a whole operation, and the standard eight keep
 * every bit of the per-operation `dto` narrowing from issue #131.
 */

class MarkFeaturedDto {
  reason = "";
}

class AuthorReceiptDto {
  id = 0;
  featuredAt = "";
}

class AuthorProfileDto {
  id = 0;
  name = "";
}

class AuthorSearchQueryDto {
  q?: string;
}

const kavo = createKavo();

// ── The well-formed shape ─────────────────────────────────────────────

const authors = kavo.createCrud(Author, {
  operations: {
    // Standard entries keep their narrowing, side by side with a custom one.
    findOne: { dto: { output: AuthorProfileDto } },
    markFeaturedOne: {
      handler: {
        async execute(_input: { id: number; body: MarkFeaturedDto }, _context: KavoContext<Author>) {
          return new AuthorReceiptDto();
        },
      },
      meta: { routes: { method: "POST", path: ":id/mark-featured" } },
    },
    findFeaturedMany: {
      kind: "read",
      cardinality: "many",
      handler: {
        async execute(_input: null, _context: KavoContext<Author>) {
          return { entities: [] as AuthorProfileDto[], total: null };
        },
      },
    },
  },
});

// `run` accepts the declared custom ids and types the result from the
// registered handler. (Asserted through a call rather than
// `expectTypeOf(authors.run).parameter(0)`: `run` is generic in its
// operation id, and `expectTypeOf` reads an unresolved type parameter as
// `never`.)
expectTypeOf(authors.run("markFeaturedOne")).resolves.toEqualTypeOf<AuthorReceiptDto>();
// @ts-expect-error — an id nothing registered is not a custom operation on this entity.
await authors.run("archiveOne");

// The body a caller passes is the handler's own input, unwrapped from the
// `{ id, body }` pair the engine assembles for an id-addressed operation.
expectTypeOf(
  authors.run("markFeaturedOne", { id: 1, body: new MarkFeaturedDto() }),
).resolves.toEqualTypeOf<AuthorReceiptDto>();
// @ts-expect-error — the body is `MarkFeaturedDto`, not an arbitrary object.
await authors.run("markFeaturedOne", { body: { nope: true } });

// A many-cardinality custom operation resolves to the list envelope, the
// same shape `findMany` returns.
expectTypeOf(authors.run("findFeaturedMany")).resolves.toEqualTypeOf<ListResultDto<AuthorProfileDto>>();

// The standard eight are untouched by the presence of a custom id.
expectTypeOf(authors.findOne).returns.resolves.toEqualTypeOf<AuthorProfileDto>();
expectTypeOf(authors.updateOne).returns.resolves.toEqualTypeOf<Author>();

// A `dto.output` override wins over the handler's return type, because that
// is the order the engine serializes in.
const overridden = kavo.createCrud(Author, {
  operations: {
    markFeaturedOne: {
      handler: { async execute() {} },
      dto: { input: MarkFeaturedDto, output: AuthorProfileDto },
    },
  },
});
expectTypeOf(overridden.run("markFeaturedOne")).resolves.toEqualTypeOf<AuthorProfileDto>();
// …and `dto.input` types the body the same way, ahead of the handler's own
// parameter (which declares nothing here).
expectTypeOf(
  overridden.run("markFeaturedOne", { body: new MarkFeaturedDto() }),
).resolves.toEqualTypeOf<AuthorProfileDto>();
// @ts-expect-error — the body is `MarkFeaturedDto`, whatever the handler takes.
await overridden.run("markFeaturedOne", { body: new AuthorProfileDto() });

// ── The malformed shapes ──────────────────────────────────────────────

kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — a custom operation has no built-in behavior, so `handler` is required.
    markFeaturedOne: { meta: { routes: { method: "POST" } } },
  },
});

kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — the boolean shorthand only enables an operation that already exists.
    markFeaturedOne: true,
  },
});

kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — 'readonly' is not an operation kind.
    markFeaturedOne: { handler: { async execute() {} }, kind: "readonly" },
  },
});

kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — a handler for an unrelated entity does not fit.
    markFeaturedOne: { handler: {} as OperationHandler<{ sku: string }> },
  },
});

// ── The standard eight keep their #131 narrowing ──────────────────────

kavo.createCrud(Author, {
  operations: {
    markFeaturedOne: { handler: { async execute() {} } },
    // @ts-expect-error — `deleteOne` is a void result with no query; it has no `dto` key to set.
    deleteOne: { dto: { input: MarkFeaturedDto } },
  },
});

kavo.createCrud(Author, {
  operations: {
    markFeaturedOne: { handler: { async execute() {} } },
    // @ts-expect-error — `findOne` has no `input` position (no request body).
    findOne: { dto: { input: MarkFeaturedDto } },
  },
});

kavo.createCrud(Author, {
  operations: {
    markFeaturedOne: { handler: { async execute() {} } },
    // @ts-expect-error — `createOne` has no `query` position.
    createOne: { dto: { query: AuthorSearchQueryDto } },
  },
});

// A standard id is configured, never redefined: its kind is fixed.
kavo.createCrud(Author, {
  operations: {
    // @ts-expect-error — `kind` is not a key on a standard operation's entry.
    deleteOne: { kind: "read" },
  },
});
