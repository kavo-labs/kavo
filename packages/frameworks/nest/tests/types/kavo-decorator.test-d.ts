import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import type { KavoContext, OperationHandler } from "@kavo/core";
import { expectTypeOf } from "vitest";

/**
 * Type-level acceptance tests for `@Kavo`.
 *
 * Before the decorator was generic its config parameter was
 * `EntityConfig<object>`, so *nothing* inside a controller's config was
 * checked against its entity: a misspelled allowlist field, a DTO slot for
 * the wrong entity and a handler typed to another entity were all silently
 * accepted. These assertions are what keeps that closed.
 *
 * Compile-only (`.test-d.ts`), so no Nest application is bootstrapped —
 * decoration itself is the test.
 */

class Todo {
  id = 0;
  title = "";
  done = false;
  tags: string[] = [];
}

class CreateTodoDto {
  title = "";
}

class TodoItemDto {
  id = 0;
  title = "";
}

// The entity types the handler's context with no annotation ceremony: this
// is the assignment that needed a cast while `config` was `EntityConfig<object>`.
const complete: OperationHandler<Todo> = {
  async execute(_input, context) {
    expectTypeOf(context).toEqualTypeOf<KavoContext<Todo>>();
    return null;
  },
};

@Kavo(Todo, {
  dto: { create: CreateTodoDto, item: TodoItemDto },
  filter: { fields: ["title", "done"] },
  sort: { fields: ["title"] },
  operations: {
    deleteOne: false,
    patchOne: { handler: complete, meta: { routes: { method: "POST", path: ":id/complete" } } },
  },
})
@Controller("todos")
class TodosController {}
void TodosController;

// Zero-config decoration stays zero-config.
@Kavo(Todo)
@Controller("bare-todos")
class BareController {}
void BareController;

// @ts-expect-error — a misspelled allowlist field is now a compile error.
@Kavo(Todo, { filter: { fields: ["titel"] } })
@Controller("typo-todos")
class TypoController {}
void TypoController;

// @ts-expect-error — an unknown standard operation id is rejected.
@Kavo(Todo, { operations: { findAll: false } })
@Controller("unknown-op-todos")
class UnknownOperationController {}
void UnknownOperationController;

class Invoice {
  sku = "";
}

// A handler for a *structurally compatible* entity is still accepted — that
// is ordinary structural typing, not a hole: anything valid for `Todo` is
// valid for a shape `Todo` satisfies.
@Kavo(Todo, { operations: { updateOne: { handler: {} as OperationHandler<{ title: string }> } } })
@Controller("compatible-handler-todos")
class CompatibleHandlerController {}
void CompatibleHandlerController;

// @ts-expect-error — a handler for an unrelated entity does not fit.
@Kavo(Todo, { operations: { updateOne: { handler: {} as OperationHandler<Invoice> } } })
@Controller("wrong-entity-todos")
class WrongEntityController {}
void WrongEntityController;

// An ORM-derived field (issue #373 — a TypeORM `@VirtualColumn`, say) is a
// real class property, so it already type-checks as an ordinary `FieldPath`
// with no separate `Extra`/`Computed` widening: naming it in `select.fields`
// (opt-in, ADR-0050), `filter.fields`, or `sort.fields` needs no cast.
class TodoWithDerivedField {
  id = 0;
  title = "";
  slug = "";
}

@Kavo(TodoWithDerivedField, { select: { fields: ["id", "title", "slug"] } })
@Controller("derived-todos")
class DerivedController {}
void DerivedController;

@Kavo(TodoWithDerivedField, { filter: { fields: ["slug"] } })
@Controller("derived-filter-todos")
class DerivedFilterController {}
void DerivedFilterController;

@Kavo(TodoWithDerivedField, { sort: { fields: ["slug"] } })
@Controller("derived-sort-todos")
class DerivedSortController {}
void DerivedSortController;
