import type { EntityInput } from "../types/utility.js";
import type { FieldPath } from "../types/field-path.js";
import type { ApplyArgs } from "../policy/kavo-apply.js";

export type { FieldsShorthand } from "../schema/schema-fields-shorthand.js";

/**
 * `set`/`set.create`/`set.update` (issue #476, ADR-0048's write-side
 * sibling; supersedes the issue #391 `create.apply`/`update.apply`): forces
 * field values into a `createOne`/`updateOne` body, overwriting whatever the
 * client sent for that key — the opposite composition rule from `default`'s.
 * Reuses `ApplyArgs`, the same argument shape `filter.apply`/`sort.apply`/
 * `select.apply`/`include.apply` already take, rather than inventing a
 * second callback shape. A key the returned object omits (or a call
 * returning `undefined`) is left alone — untouched by `set`, not reset to
 * anything.
 */
export type WriteApply<Entity = unknown> = (
  args: ApplyArgs<Entity>,
) => Partial<EntityInput<Entity>> | undefined | Promise<Partial<EntityInput<Entity>> | undefined>;

/**
 * `EntityConfig.create`/`.update`'s own config shape (issue #388, extended
 * with `default`). Unlike {@link FieldsShorthand}, `fields` is optional
 * here — a caller may configure only `default` and leave the writable-field
 * list at its entity-derived default, which a bare `{ fields: [...] }`
 * shorthand can't express — and it additionally accepts the
 * `{ exclude: [...] }` form (issue #397) the read-side field groups
 * (`filter.fields`/`sort.fields`/`select.fields`/`include.fields`) take:
 * "every writable field except these", resolved at bootstrap against the
 * ADR-0014 writable projection. An `exclude` entry that names nothing
 * writable is a bootstrap error, and `{ exclude: [] }` (or any `{ exclude }`
 * that removes nothing) is exactly equivalent to omitting the key.
 *
 * `default` fills in a value for any writable field the request body omits
 * — `createOne` only for `create.default`, `updateOne` only (never
 * `patchOne`) for `update.default`: a `PATCH` omitting a field means "leave
 * it unchanged", so filling it in there would silently overwrite a value
 * the caller never touched. A `createOne`/`updateOne` body that *does* send
 * the field always wins outright — `default` never overrides an explicit
 * value, the same one-way relationship `sort.default`/`select.default`/
 * `include.default` already have with their own client-supplied values.
 *
 * The top-level `set` key (see {@link WriteApply}) is `default`'s
 * opposite — an unconditional, per-request constraint that overwrites
 * whatever the client sent. When a field is named by both, `set` wins: it
 * is the unconditional constraint, `default` only a fallback for an absent
 * value.
 */
export interface WriteFieldsConfig<Entity> {
  readonly fields?: readonly FieldPath<Entity, 1>[] | { readonly exclude: readonly FieldPath<Entity, 1>[] };
  /** Values for fields the request body doesn't set. Validated at bootstrap against the entity's own writable columns. */
  readonly default?: Partial<EntityInput<Entity>>;
}

/**
 * `EntityConfig.set`'s own shape (issue #476): a bare function forces the
 * same values on both `createOne` and `updateOne`; the `{ create?, update? }`
 * form lets the two diverge. Not bootstrap-validated beyond "is it callable"
 * — see {@link WriteApply}'s doc for why.
 */
export type SetConfig<Entity> =
  WriteApply<Entity> | { readonly create?: WriteApply<Entity>; readonly update?: WriteApply<Entity> };
