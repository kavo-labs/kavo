import type { KavoContext } from "../context/kavo-context.js";

/**
 * One computed (virtual) field: a response-only value derived from an
 * entity that has **already been fetched** (ADR-0019).
 *
 * A computed field has no backing column, so it exists at exactly one
 * stage of the pipeline — response mapping. `DefaultSerializer` calls
 * `resolve` for every served item instead of reading the key off the row,
 * which is what makes it behave identically for a TypeORM class instance
 * and a Prisma/Mongoose plain object. The three invariants that follow
 * from having no column are enforced at bootstrap, not at request time:
 * a computed field is never filterable, never sortable, and never
 * writable.
 *
 * ```ts
 * createCrud(User, {
 *   computed: {
 *     fullName: { resolve: (user) => [user.firstName, user.lastName].filter(Boolean).join(" ") },
 *   },
 * });
 * ```
 */
export interface ComputedFieldDescriptor<Entity = unknown> {
  /**
   * Derive the field's value for one entity. Called once per served item,
   * **synchronously** — the return value is emitted as-is, never awaited
   * (declaring `resolve` `async` is a bootstrap error). Returning
   * `undefined` omits the key; `null` emits it, the same distinction a
   * column draws. Keep it a pure function of `entity` (plus, where a field
   * has to vary by caller, `context.principal`): a resolver that hits the
   * database or the network runs once per row and reintroduces exactly the
   * N+1 the include resolver exists to avoid.
   *
   * It must also be **total** over anything the columns can hold, which is
   * the stronger requirement. `serializeList` maps it over every row and
   * nothing catches it, so one row the resolver cannot handle fails the
   * whole collection response for every caller —
   * `user.firstName?.trim() ?? null`, never `user.firstName.trim()` on a
   * nullable column.
   *
   * It receives the **fully hydrated row**, not the projected object
   * (selection is "kept internally, stripped late"), so a computed field
   * can surface a column a narrowed `item` DTO hides. That is deliberate —
   * `resolve` is server-authored code — but it makes the resolver part of
   * the exposure decision.
   *
   * **On an included relation target, `context` is the *root* request's.**
   * One response is one request, and `KavoContext` describes that request:
   * serving `GET /posts/1?include=author` hands an `Author` computed field
   * a context whose `entityName`, `operation`, `config`, `query` and
   * `repository` are Post's. Only the request-scoped members —
   * `principal`, `correlationId`, `transaction`, `state` — mean what they
   * say from a relation target (ADR-0019).
   *
   * `context.repository` is the sharpest of those, because it is the only
   * one that can *act*: from a relation target it is typed for this entity
   * and holds the root entity's adapter, so a write through it would hit
   * the wrong table under this row's id. A resolver should not reach for
   * it at all — `resolve` is synchronous, so any adapter call is an
   * unawaited promise, and one that ran per row would reintroduce the N+1
   * this stage exists to avoid (ADR-0025).
   */
  resolve(entity: Entity, context: KavoContext<Entity>): unknown;
  /**
   * Whether the field joins the `selectable` allowlist, so `fields=` can
   * name it. Defaults to `true`; `false` keeps the field in the default
   * projection while making its name a 400 in `fields=`.
   *
   * Note what that does *not* buy: a request that sends any `fields=` at
   * all still drops the field, because selection narrows the projection
   * uniformly and there is no way to ask for it back. `false` means "not
   * individually selectable", not "always present".
   *
   * This flag and an explicit `allowlists.selectable` now say different
   * things, and the difference is deliberate (ADR-0026). The flag is a
   * default about *nameability* and leaves the projection alone; an
   * explicit list is a statement about the **response**, so a list that
   * omits (or `exclude`s) the field drops it from responses too. Where
   * both are present the explicit list wins, as it always has.
   */
  readonly selectable?: boolean;
}

/** A declared set of computed fields, keyed by the name they serialize as. */
export type ComputedFieldMap<Entity = unknown> = Readonly<Record<string, ComputedFieldDescriptor<Entity>>>;
