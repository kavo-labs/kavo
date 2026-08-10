import { expectTypeOf } from "vitest";
import { builtInHandlers, createKavo, createKavoContext } from "@kavo/core";
import type {
  KavoContext,
  RepositoryAdapter,
  ResolvedEntityConfig,
  StandardHandlerFactory,
  KavoContextInit,
} from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * The type surface of handler data access (ADR-0025, issue #152):
 * `KavoContext.repository` is the entity's own adapter, typed, and
 * `builtInHandlers` no longer needs one handed to it.
 */

const kavo = createKavo();

kavo.createCrud(Author, {
  operations: {
    banOne: {
      handler: {
        async execute(_input: unknown, context: KavoContext<Author>) {
          // Entity-typed, so a write is checked against the entity's own
          // columns rather than against `unknown`.
          expectTypeOf(context.repository).toEqualTypeOf<RepositoryAdapter<Author>>();
          expectTypeOf(context.repository.findOneById(1, null, context)).resolves.toEqualTypeOf<Author | null>();
          expectTypeOf(context.repository.patch(1, { name: "Ada" }, context)).resolves.toEqualTypeOf<Author>();
          // @ts-expect-error — `sku` is not a column on Author.
          await context.repository.patch(1, { sku: "x" }, context);
          return null;
        },
      },
    },
  },
});

// The adapter argument is optional, and the entity parameter carries the
// typing on its own — this is the call a `@Kavo` config makes, where no
// adapter exists to pass.
expectTypeOf(builtInHandlers<Author>()).toEqualTypeOf<StandardHandlerFactory<Author>>();
expectTypeOf(builtInHandlers({} as RepositoryAdapter<Author>)).toEqualTypeOf<StandardHandlerFactory<Author>>();

// `repository` is required on a context, not an optional extra: a context
// without one would hand some handler a field that is not there.
expectTypeOf<KavoContextInit<Author>["repository"]>().toEqualTypeOf<RepositoryAdapter<Author>>();
// @ts-expect-error — `repository` is missing from the init.
createKavoContext<Author>({ operation: "findOne", config: {} as ResolvedEntityConfig<Author>, principal: null });
