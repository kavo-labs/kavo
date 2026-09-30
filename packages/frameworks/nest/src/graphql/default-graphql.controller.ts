import { Body, Controller, HttpCode, Post, UseGuards, type CanActivate, type Type } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { BaseKavoGraphQLController } from "./base-kavo-graphql.controller.js";

/** `KavoModule.forRoot`/`forRootAsync({ graphql: true })`'s default mount path when no `path` override is given. */
export const DEFAULT_GRAPHQL_PATH = "graphql";

/**
 * Builds the zero-config GraphQL controller at `path` — one `POST <path>`,
 * mounted by `KavoModule.forRoot`/`forRootAsync` when `graphql` is set,
 * with no hand-written controller needed. A fresh class per call (never a
 * shared singleton) so two independently-configured Kavo modules in the
 * same process — two apps, or two test files sharing a module cache —
 * never fight over one `@Controller` path.
 *
 * The class is declared with real `@Controller`/`@Post`/`@HttpCode`
 * decorator syntax (closing over `path`), not built by calling those
 * decorators as plain functions afterward: `emitDecoratorMetadata` only
 * emits `design:paramtypes` for a class tsc sees an actual decorator
 * applied to, so the constructor's `ModuleRef` injection silently breaks
 * without it.
 *
 * Carries exactly the `guards` it is handed (`graphql: { guards }`, issue
 * #498), applied with `UseGuards` so Nest resolves guard classes through DI.
 * That one decorator is applied after the class body, which is safe: the
 * real `@Controller` above already made tsc emit `design:paramtypes`, and
 * `UseGuards` writes guard metadata only.
 * With no guards the route is unguarded — mutations included — and a guard
 * on an entity's REST controller does not extend to it.
 *
 * A consumer wanting a different method or transport (subscriptions,
 * batched requests) writes their own controller extending
 * `BaseKavoGraphQLController` instead and leaves `graphql` unset — this
 * factory and a custom controller are alternatives, never both at once.
 */
export function createDefaultGraphQLController(
  path: string = DEFAULT_GRAPHQL_PATH,
  guards: readonly (Type<CanActivate> | CanActivate)[] = [],
): Type<BaseKavoGraphQLController> {
  @Controller(path)
  class DefaultGraphQLController extends BaseKavoGraphQLController {
    constructor(moduleRef: ModuleRef) {
      super(moduleRef);
    }

    @Post()
    @HttpCode(200)
    handle(@Body() body: { query: string; variables?: Record<string, unknown> }) {
      return this.execute(body.query, body.variables);
    }
  }

  if (guards.length > 0) {
    UseGuards(...guards)(DefaultGraphQLController);
  }
  return DefaultGraphQLController;
}
