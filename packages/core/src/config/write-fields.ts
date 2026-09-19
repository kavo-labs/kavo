import type { EntityInput } from "../types/utility.js";
import type { ApplyArgs } from "../policy/kavo-apply.js";

export type { FieldsShorthand } from "../schema/schema-fields-shorthand.js";

/**
 * `set`/`set.create`/`set.update` (issue #476, ADR-0048's write-side
 * sibling; supersedes the issue #391 `create.apply`/`update.apply`): forces
 * field values into a `createOne`/`updateOne` body, overwriting whatever the
 * client sent for that key. Reuses `ApplyArgs`, the same argument shape
 * `filter.apply`/`sort.apply`/`select.apply`/`include.apply` already take,
 * rather than inventing a second callback shape. A key the returned object
 * omits (or a call returning `undefined`) is left alone — untouched by
 * `set`, not reset to anything.
 */
export type WriteApply<Entity = unknown> = (
  args: ApplyArgs<Entity>,
) => Partial<EntityInput<Entity>> | undefined | Promise<Partial<EntityInput<Entity>> | undefined>;

/**
 * `EntityConfig.set`'s own shape (issue #476): a bare function forces the
 * same values on both `createOne` and `updateOne`; the `{ create?, update? }`
 * form lets the two diverge. Not bootstrap-validated beyond "is it callable"
 * — see {@link WriteApply}'s doc for why.
 */
export type SetConfig<Entity> =
  WriteApply<Entity> | { readonly create?: WriteApply<Entity>; readonly update?: WriteApply<Entity> };
