import type { KavoSettings } from "./settings.js";
import type { DeepPartial } from "../types/utility.js";
import type { FieldPath } from "../types/field-path.js";
import type { QueryContext } from "../query/query-context.js";
import type { OperationDtoMap, OperationDtoOverride } from "../dto/dto.js";
import type { EntityInput } from "../types/utility.js";
import type { OperationHandler, OperationMetadata } from "../operations/operation-handler.js";
import type { OperationCardinality, OperationKind, StandardOperationId } from "../operations/operation.js";
import type { ComputedFieldDescriptor } from "./computed-field.js";

/**
 * One allowlist key's raw configuration: either the explicit set of paths
 * to allow, or `{ exclude }` — every own column except the ones named.
 * `exclude` is resolved against the entity's own columns at bootstrap
 * (`resolveAllowlists`), never evaluated eagerly here — the `@Kavo(...)`
 * config object is built at class-decoration time, before any ORM metadata
 * exists (ADR-0013), so there is nothing to resolve `exclude` against yet.
 *
 * `Extra` widens both forms with names that are not paths on the entity —
 * only ever the entity's declared computed-field names, and only on
 * `selectable` (ADR-0019).
 */
export type QueryFieldSelector<Entity, Extra extends string = never> =
  readonly (FieldPath<Entity> | Extra)[] | { readonly exclude: readonly (FieldPath<Entity> | Extra)[] };

/**
 * Security allowlists: what a request may filter, sort, and
 * select on — including relation paths. Anything outside an allowlist is
 * rejected with a 400 (`QueryValidationException`), never silently
 * dropped. When omitted, the allowlists derive from the `query` DTO or
 * entity metadata at bootstrap.
 *
 * `selectable` is the only key computed-field names may appear in:
 * `filterable`/`sortable` stay typed to real paths, because a computed
 * field has no column to translate to `WHERE`/`ORDER BY` (ADR-0019). The
 * bootstrap check in `resolveAllowlists` catches the same mistake from an
 * erased or cast config, where the type is not there to help.
 */
export interface QueryAllowlists<Entity = unknown, Computed extends string = never> {
  readonly filterable?: QueryFieldSelector<Entity>;
  readonly sortable?: QueryFieldSelector<Entity>;
  readonly selectable?: QueryFieldSelector<Entity, Computed>;
}

/**
 * Per-operation configuration.
 * Settings keys override entity scope for this operation only; `false` in
 * the parent `operations` record disables the operation outright.
 *
 * `DtoOverride` is `StandardOperationsConfig`'s per-id `Pick` of
 * `OperationDtoOverride` — only the fields that operation actually
 * supports (issue #131). It defaults to the full override shape so a bare
 * `OperationConfig<Entity>` (used where no specific operation id is in
 * scope) still type-checks.
 */
export interface OperationConfig<Entity = unknown, DtoOverride = OperationDtoOverride> extends Omit<
  DeepPartial<KavoSettings>,
  "operations"
> {
  /**
   * Turn the operation on or off explicitly, overriding its default. The
   * long form of the `false` / `true` shorthands in the parent
   * `operations` record — spell it out when the entry also carries
   * settings or `meta`.
   */
  readonly enabled?: boolean;
  /** Replacement handler — keeps the default DTO/serialization scaffolding. */
  readonly handler?: OperationHandler<Entity>;
  /** Opaque metadata consumed by the framework layer (route options). */
  readonly meta?: OperationMetadata;
  /**
   * Overrides the entity's root `dto` slot for this operation only —
   * `input`/`output`/`query` as applicable to the operation's shape.
   * Fallback order: this field → the entity's root `dto.<slot>` →
   * entity-derived default (doc 04 §8).
   */
  readonly dto?: DtoOverride;
}

/**
 * The `operations` map's per-id DTO override shapes (issue #131): each
 * standard operation `Pick`s only the `OperationDtoOverride` fields it
 * actually has — a write op gets `input`/`output`, a read gets
 * `output`/`query`, and `deleteOne`/`purgeOne` (void results, no query)
 * get neither, so setting `dto` on them is a type error before it is ever
 * a bootstrap one. `false`/`true` (the enable/disable shorthand) is still
 * accepted at every id, unchanged.
 *
 * Unlike the root `dto` map, a per-operation override is **not** narrowed
 * against the entity's own `CreateDto`/`ItemDto`/etc. — those generics are
 * inferred from the root `dto` slots alone, so constraining an override to
 * them here would force it to structurally equal the *default* (usually
 * `Entity` itself) instead of letting the registered class's own shape
 * flow through to `KavoService`'s `Ops`-based positions (`DtoInputOf`/
 * `DtoOutputOf`/`DtoQueryOf`, `dto.ts`). Each field is simply `DtoClass<Dto>`
 * — any class — which is what lets `AuthorProfileDto` (fewer fields than
 * `Author`) narrow `findOne`'s response independently of `createOne`'s.
 */
export interface StandardOperationsConfig<
  Entity,
  // Unused by this interface's own fields (see the comment above) — kept as
  // generic parameters, `_`-prefixed where the linter would otherwise flag
  // them as unused, purely so `EntityConfig`'s
  // `Ops extends StandardOperationsConfig<Entity, CreateDto, ..., ListDto>`
  // constraint keeps the same shape it always has; the DTO generics stay
  // meaningful for the *root* `dto` map, just not for this per-operation one.
  _CreateDto = EntityInput<Entity>,
  UpdateDto = EntityInput<Entity>,
  _PatchDto = Partial<UpdateDto>,
  _QueryDto = QueryContext<Entity>,
  ItemDto = Entity,
  _ListDto = ItemDto,
> {
  readonly createOne?: OperationConfig<Entity, Pick<OperationDtoOverride, "input" | "output">> | boolean;
  readonly findOne?: OperationConfig<Entity, Pick<OperationDtoOverride, "output" | "query">> | boolean;
  readonly findMany?: OperationConfig<Entity, Pick<OperationDtoOverride, "output" | "query">> | boolean;
  readonly updateOne?: OperationConfig<Entity, Pick<OperationDtoOverride, "input" | "output">> | boolean;
  readonly patchOne?: OperationConfig<Entity, Pick<OperationDtoOverride, "input" | "output">> | boolean;
  /** Void result, no query — no `dto` override is representable. */
  readonly deleteOne?: OperationConfig<Entity, never> | boolean;
  readonly restoreOne?: OperationConfig<Entity, Pick<OperationDtoOverride, "output">> | boolean;
  /** Void result, no query — no `dto` override is representable. */
  readonly purgeOne?: OperationConfig<Entity, never> | boolean;
}

/**
 * One **custom** operation: an entity-scope operation id that is not one of
 * the standard eight (issue #145). The registry has always accepted an
 * arbitrary id (ADR-0006) and `@kavo/nest` has always routed one; this is
 * the config surface that reaches it.
 *
 * The shape differs from `OperationConfig` in exactly the ways a new
 * operation differs from an override of an existing one:
 *
 * - `handler` is **required**. There is no built-in behavior to fall back
 *   to, so an entry without one describes an operation that cannot run.
 * - `kind`/`cardinality` are declared rather than looked up. They are not
 *   labels: `kind` decides whether the request goes through query
 *   resolution and arrives as `@Query` rather than `@Body`, and
 *   `cardinality` decides whether the response is mapped as one item or as
 *   the list envelope. Both default to the common case — a write against
 *   one row (`markPaidOne`, `publishOne`) — so the motivating operations
 *   declare neither.
 * - `dto` is the full `OperationDtoOverride`; which of its three fields
 *   apply follows from `kind` (a read has no request body, a write runs no
 *   query resolution), and the mismatch is a bootstrap
 *   `ConfigurationException` rather than a type error, because `kind` is a
 *   value here and the standard eight's `Pick` is not available.
 *
 * A custom operation is reachable over HTTP through `meta.routes`
 * (`@kavo/nest`) and in code through `KavoService.run`.
 */
export interface CustomOperationConfig<Entity = unknown> extends Omit<DeepPartial<KavoSettings>, "operations"> {
  /** Registered but inert when `false` — the same seam a standard id has. */
  readonly enabled?: boolean;
  /** The operation's behavior. Required: nothing else can supply it. */
  readonly handler: OperationHandler<Entity>;
  /** Defaults to `"write"`. A `"read"` runs query resolution and takes no body. */
  readonly kind?: OperationKind;
  /** Defaults to `"one"`. A `"many"` handler must return a `FindManyResult`. */
  readonly cardinality?: OperationCardinality;
  /**
   * Overrides the DTO used for this operation's body/response/query.
   * A custom operation has no root slot of its own — `input` falls back to
   * the entity's writable projection and `output` to the `item`/`list`
   * slot — so this is the only way to give it a shape of its own.
   */
  readonly dto?: OperationDtoOverride;
  /** Opaque metadata consumed by the framework layer (route options). */
  readonly meta?: OperationMetadata;
}

/**
 * The whole `operations` map: the standard eight at their own precise
 * types, plus any number of custom ids (issue #145). This is the
 * **constraint** on `EntityConfig`'s `Ops` parameter; `Ops` itself is still
 * inferred from the caller's object literal, which is what keeps the
 * per-operation `dto` narrowing (`DtoInputOf`/`DtoOutputOf`/`DtoQueryOf`)
 * reading real classes back rather than the constraint's wider shape.
 *
 * The intersection is what admits a custom id at all: the eight declared
 * properties come from `StandardOperationsConfig`, so each keeps exactly
 * the type issue #131 gave it, and the index signature turns every *other*
 * key from an excess property into a permitted one. Assignability to an
 * intersection is assignability to both halves, so `deleteOne: { dto: … }`
 * is still rejected by the first half no matter what the second admits.
 *
 * The index signature's union is a genuine upper bound rather than
 * `CustomOperationConfig` alone, and it has to be: every declared property
 * is checked against it too, so it must be wide enough for an override
 * entry (`OperationConfig`, whose `handler` is optional) and for the
 * boolean shorthand. So this type says only "a custom key holds *some*
 * operation entry"; {@link CustomOperationsOf} is what holds it to
 * `CustomOperationConfig`, applied where `Ops` is already known rather than
 * inside its own constraint.
 */
export type OperationsConfig<
  Entity,
  CreateDto = EntityInput<Entity>,
  UpdateDto = EntityInput<Entity>,
  PatchDto = Partial<UpdateDto>,
  QueryDto = QueryContext<Entity>,
  ItemDto = Entity,
  ListDto = ItemDto,
> = StandardOperationsConfig<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto> & {
  readonly [id: string]: OperationConfig<Entity> | CustomOperationConfig<Entity> | boolean | undefined;
};

/**
 * The custom half of an `operations` map, as an extra requirement on top of
 * `Ops`: every key that is not one of the standard eight must be a
 * `CustomOperationConfig` — a handler above all, since a custom operation
 * has nothing to fall back to.
 *
 * This is intersected into `EntityConfig.operations`' declared type rather
 * than folded into `Ops`' constraint, and the difference is load-bearing. A
 * constraint that names `Ops` inside itself makes TypeScript stop keeping
 * the caller's object literal as the inferred `Ops` — it re-derives it from
 * the constraint — and every per-operation `dto` narrowing from issue #131
 * disappears with it. Intersected at the property, `Ops` is already
 * inferred, so this is a plain second check over a known type.
 *
 * `string extends keyof Ops` is the "the keys are not known" case, which is
 * what `Ops` is whenever `EntityConfig` is written out rather than inferred
 * (`EntityConfig<Book>`, `Parameters<typeof createCrud>[1]`). Mapping over
 * `string` there would demand a handler from *every* key including the
 * standard eight, so those spellings contribute nothing extra.
 */
export type CustomOperationsOf<Entity, Ops> = string extends keyof Ops
  ? unknown
  : { readonly [Id in Exclude<keyof Ops, StandardOperationId>]: CustomOperationConfig<Entity> };

/**
 * Raw entity-scope configuration — the second argument to `createCrud`.
 * Settings keys (inherited from `DeepPartial<KavoSettings>`) override
 * global scope for this entity.
 *
 * `Computed` is inferred from the keys of `computed` and exists so an
 * explicit `allowlists.selectable` list can name a computed field without
 * a cast; every other position stays typed to real entity paths.
 */
export interface EntityConfig<
  Entity,
  CreateDto = EntityInput<Entity>,
  UpdateDto = EntityInput<Entity>,
  PatchDto = Partial<UpdateDto>,
  QueryDto = QueryContext<Entity>,
  ItemDto = Entity,
  ListDto = ItemDto,
  Computed extends string = never,
  // The constraint fixes the shape `operations` accepts; the free
  // parameter is what lets inference capture the *literal* dto classes a
  // caller registers per operation, which `DtoInputOf`/`DtoOutputOf`/
  // `DtoQueryOf` (dto.ts) then read back off `KavoService`'s `Ops`
  // parameter (issue #131) — the same "constrain, don't fix" shape
  // `allowlists.selectable`'s `NoInfer<Computed>` already relies on. The
  // constraint is `OperationsConfig` rather than `StandardOperationsConfig`
  // (issue #145) so that a key outside the standard eight is a permitted
  // custom operation rather than an excess property.
  Ops extends OperationsConfig<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto> = OperationsConfig<
    Entity,
    CreateDto,
    UpdateDto,
    PatchDto,
    QueryDto,
    ItemDto,
    ListDto
  >,
> extends Omit<DeepPartial<KavoSettings>, "operations"> {
  readonly dto?: OperationDtoMap<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto>;
  /**
   * Computed (virtual) response fields, keyed by the name each serializes
   * as — structural entity-scope config like `dto`, deliberately outside
   * the settings precedence chain because it carries functions (ADR-0019).
   * Declared fields join the entity-derived `item`/`list` projection and
   * the `selectable` allowlist automatically; they are never filterable,
   * sortable, or writable.
   */
  readonly computed?: Readonly<Record<Computed, ComputedFieldDescriptor<Entity>>>;
  readonly allowlists?: QueryAllowlists<Entity, NoInfer<Computed>>;
  /**
   * Per-operation overrides. `false` disables the operation; `true`
   * enables one that is off by default (`purgeOne`, `restoreOne`); an
   * object form may also carry a per-operation `dto` override
   * (`StandardOperationsConfig`, above).
   *
   * A key that is not one of the standard eight declares a **custom**
   * operation (`CustomOperationConfig`, above): its own handler, routed
   * from `meta.routes`, dispatched through the same registry.
   */
  readonly operations?: Ops & CustomOperationsOf<Entity, Ops>;
}
