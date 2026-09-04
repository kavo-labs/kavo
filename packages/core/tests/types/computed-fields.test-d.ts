import { expectTypeOf } from "vitest";
import { createKavo } from "@kavo/core";
import type { ComputedFieldDescriptor, KavoContext } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * The type-level half of ADR-0019. `EntityConfig` grows an eighth
 * parameter, `Computed`, inferred from the keys of `computed` alone
 * (`allowed` is a `NoInfer` position, so listing a real column there
 * cannot widen it). That is what lets an explicit `selectable` list name a
 * computed field without a cast, while `filterable`/`sortable` — which
 * stay typed to real entity paths — reject one outright.
 */

const kavo = createKavo();

// `resolve` is typed to the entity and to the request context, with no
// manual generic argument at the call site.
void kavo.createCrud(Author, {
  computed: {
    initials: {
      resolve: (author, context) => {
        expectTypeOf(author).toEqualTypeOf<Author>();
        expectTypeOf(context).toEqualTypeOf<KavoContext<Author>>();
        return author.name.slice(0, 2);
      },
    },
  },
});

// ADR-0019's one explicit *negative* claim: declaring a computed field does
// not change the static response type — the entity-derived `ItemDto` stays
// `Entity`. Every runtime test casts its way past this, so a drift in either
// direction (silently growing the key, or losing `Author`) is invisible
// without a type-level assertion.
const derived = kavo.createCrud(Author, {
  computed: { initials: { resolve: (author) => author.name.slice(0, 2) } },
});
expectTypeOf(derived.findOne).returns.resolves.toEqualTypeOf<Author>();

// A declared computed name is usable in `selectable` alongside real paths.
void kavo.createCrud(Author, {
  computed: { initials: { resolve: (author) => author.name.slice(0, 2) } },
  allowed: { selectable: ["id", "name", "initials"] },
});

// A descriptor can be declared standalone and still infer the key.
const initials: ComputedFieldDescriptor<Author> = {
  resolve: (author) => author.name.slice(0, 2),
};
void kavo.createCrud(Author, { computed: { initials }, allowed: { selectable: ["id", "initials"] } });

void kavo.createCrud(Author, {
  computed: {
    // @ts-expect-error — `resolve` is typed to the entity, so a misspelled
    // property is caught here rather than as `undefined` in a response.
    initials: { resolve: (author) => author.nmae },
  },
});

void kavo.createCrud(Author, {
  computed: { initials: { resolve: (author) => author.name } },
  // @ts-expect-error — the `{ exclude }` form is barred from filterable too:
  // excluding a name that could never be in the list is a confusion, not a
  // no-op worth silently accepting.
  allowed: { filterable: { exclude: ["initials"] } },
});

// `{ exclude }` on `selectable` accepts a computed name, because that list
// really does contain one to remove.
void kavo.createCrud(Author, {
  computed: { initials: { resolve: (author) => author.name } },
  allowed: { selectable: { exclude: ["initials"] } },
});

void kavo.createCrud(Author, {
  computed: { initials: { resolve: (author) => author.name } },
  // @ts-expect-error — a computed field can never be filterable: no column.
  allowed: { filterable: ["initials"] },
});

void kavo.createCrud(Author, {
  computed: { initials: { resolve: (author) => author.name } },
  // @ts-expect-error — nor sortable, for the same reason.
  allowed: { sortable: ["initials"] },
});

void kavo.createCrud(Author, {
  computed: { initials: { resolve: (author) => author.name } },
  // @ts-expect-error — `selectable` still spell-checks real entity paths.
  allowed: { selectable: ["nmae"] },
});

// @ts-expect-error — and a name no `computed` entry declares stays rejected.
void kavo.createCrud(Author, { allowed: { selectable: ["initials"] } });

// @ts-expect-error — a descriptor without `resolve` is not a descriptor.
void kavo.createCrud(Author, { computed: { initials: { selectable: true } } });
