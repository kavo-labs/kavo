import { createKavo } from "@kavo/core";
import type { FilterApply, IncludeApply, SelectApply, SortApply } from "@kavo/core";
import { Post } from "../support/blog-fixture.js";

/**
 * `filter`/`sort`/`select`/`include`'s `apply` (ADR-0048) each take a plain
 * function returning that axis's own existing shape — never a new
 * predicate DSL, never `any`. Entity-scope only (there is no per-operation
 * or global `apply` to type-check here — see ADR-0048's Non-goals).
 */

const kavo = createKavo();

kavo.createCrud(Post, {
  // @ts-expect-error — 'filter.apply' takes a function, not a plain object.
  filter: { apply: { userId: "u-1" } },
});

kavo.createCrud(Post, {
  // @ts-expect-error — 'sort.apply' returns a `Sort<Entity>[]`, not bare field names.
  sort: { apply: () => ["title"] },
});

const filterApply: FilterApply<Post> = ({ context }) => ({
  kind: "condition",
  field: "authorId",
  operator: "EQ",
  value: (context.app as { userId?: number }).userId ?? 0,
});

const sortApply: SortApply<Post> = () => [{ field: "id", direction: "asc" }];
const selectApply: SelectApply<Post> = () => ["authorId"];
const includeApply: IncludeApply<Post> = () => ["author"];

// `undefined` — "no additional constraint" — is a legal return from every one of them.
const filterApplyEmpty: FilterApply<Post> = () => undefined;
const sortApplyEmpty: SortApply<Post> = () => undefined;
const selectApplyEmpty: SelectApply<Post> = () => undefined;
const includeApplyEmpty: IncludeApply<Post> = () => undefined;

kavo.createCrud(Post, {
  filter: { apply: filterApply },
  sort: { apply: sortApply },
  select: { apply: selectApply },
  include: { fields: ["author"], apply: includeApply },
});

kavo.createCrud(Post, {
  filter: { apply: filterApplyEmpty },
  sort: { apply: sortApplyEmpty },
  select: { apply: selectApplyEmpty },
  include: { fields: ["author"], apply: includeApplyEmpty },
});

kavo.createCrud(Post, {
  // @ts-expect-error — 'include.apply' returns relation paths, not a boolean.
  include: { fields: ["author"], apply: () => true },
});
