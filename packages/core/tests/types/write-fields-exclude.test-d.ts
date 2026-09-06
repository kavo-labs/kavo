import { createKavo } from "@kavo/core";
import { Author } from "../support/blog-fixture.js";

/**
 * Issue #397: `EntityConfig.create.fields` / `update.fields` accept the
 * `{ exclude: [...] }` form the read-side field groups take, alongside the
 * plain allowlist array — and reject a name that is not a field path.
 */

const kavo = createKavo();

// Plain allowlist array — still accepted.
kavo.createCrud(Author, { create: { fields: ["name"] } });

// `{ exclude }` form — accepted on both write slots.
kavo.createCrud(Author, {
  create: { fields: { exclude: ["name"] } },
  update: { fields: { exclude: ["name", "posts"] } },
});

// Empty exclude — accepted (resolves to the entity-derived default).
kavo.createCrud(Author, { create: { fields: { exclude: [] } } });

// `{ exclude }` composes with `default` / `apply` on the same slot.
kavo.createCrud(Author, {
  update: { fields: { exclude: ["name"] }, default: { name: "anon" }, apply: () => ({ name: "anon" }) },
});

kavo.createCrud(Author, {
  // @ts-expect-error — a non-field-path string is rejected inside `exclude`.
  create: { fields: { exclude: ["not_a_column"] } },
});

kavo.createCrud(Author, {
  // @ts-expect-error — `exclude` must be an array, not a bare string.
  update: { fields: { exclude: "name" } },
});
