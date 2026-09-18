import type { EntityInput } from "../types/utility.js";
import type { FieldPath } from "../types/field-path.js";
import type { ApplyArgs } from "../policy/kavo-apply.js";

export type { FieldsShorthand } from "../schema/schema-fields-shorthand.js";

/**
 * `create.apply`/`update.apply` (issue #391, ADR-0048's write-side sibling):
 * forces field values into a `createOne`/`updateOne` body, overwriting
 * whatever the client sent for that key — the opposite composition rule
 * from `default`'s. Reuses `ApplyArgs`, the same argument shape
 * `filter.apply`/`sort.apply`/`select.apply`/`include.apply` already take,
 * rather than inventing a second callback shape. A key the returned object
 * omits (or a call returning `undefined`) is left alone — untouched by
 * `apply`, not reset to anything.
 */
export type WriteApply<Entity = unknown> = (
  args: ApplyArgs<Entity>,
) => Partial<EntityInput<Entity>> | undefined | Promise<Partial<EntityInput<Entity>> | undefined>;

/**
 * `EntityConfig.create`/`.update`'s own config shape (issue #388, extended
 * with `default` and, per issue #391, `apply`). Unlike {@link FieldsShorthand},
 * `fields` is optional here — a caller may configure only `default`/`apply`
 * and leave the writable-field list at its entity-derived default, which a
 * bare `{ fields: [...] }` shorthand can't express — and it additionally
 * accepts the `{ exclude: [...] }` form (issue #397) the read-side field
 * groups (`filter.fields`/`sort.fields`/`select.fields`/`include.fields`)
 * take: "every writable field except these", resolved at bootstrap against
 * the ADR-0014 writable projection. An `exclude` entry that names nothing
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
 * `apply` is `default`'s opposite: an unconditional, per-request constraint
 * that overwrites whatever the client sent, the same relationship
 * `filter.apply` already has with the client's own filter (ADR-0048). Scoped
 * the same way `default` is — `create.apply` on `createOne`, `update.apply`
 * on `updateOne` only, never `patchOne`. When a field is named by both,
 * `apply` wins: it is the unconditional constraint, `default` only a
 * fallback for an absent value. Unlike `default`, `apply`'s return value is
 * not validated at bootstrap against the entity's writable columns — it is
 * evaluated per request with an arbitrary runtime value, the same non-goal
 * ADR-0048 already states for `filter.apply`/`select.apply`/`sort.apply`.
 */
export interface WriteFieldsConfig<Entity> {
  readonly fields?: readonly FieldPath<Entity, 1>[] | { readonly exclude: readonly FieldPath<Entity, 1>[] };
  /** Values for fields the request body doesn't set. Validated at bootstrap against the entity's own writable columns. */
  readonly default?: Partial<EntityInput<Entity>>;
  /** Values forced into the request body, overwriting whatever the client sent (issue #391). Not bootstrap-validated — see class doc. */
  readonly apply?: WriteApply<Entity>;
}
