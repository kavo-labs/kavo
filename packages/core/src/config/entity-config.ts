import type { ArrayMutationStrategy, KavoSettings } from "./settings.js";
import type { RelationLoadStrategy } from "../relations/relation-descriptor.js";
import type { DeepPartial } from "../types/utility.js";
import type { FieldPath } from "../types/field-path.js";
import type { IncludePath } from "../types/include-path.js";
import type { QueryContext } from "../query/query-context.js";
import type { OperationDtoMap, OperationDtoOverride, WriteFieldsConfig } from "../dto/dto.js";
import type { EntityInput } from "../types/utility.js";
import type { OperationHandler, OperationMetadata } from "../operations/operation-handler.js";
import type { OperationCardinality, OperationKind, StandardOperationId } from "../operations/operation.js";
import type { Policy } from "../policy/kavo-policy.js";
import type { FilterApply, IncludeApply, SelectApply, SortApply } from "../policy/kavo-apply.js";
import type { FilterExpression, FilterOperatorToken } from "../query/filter.js";

/**
 * One allowlist key's raw configuration: either the explicit set of paths
 * to allow, or `{ exclude }` — every own column except the ones named.
 * `exclude` is resolved against the entity's own columns at bootstrap
 * (`resolve-entity-config.ts`), never evaluated eagerly here — the
 * `@Kavo(...)` config object is built at class-decoration time, before any
 * ORM metadata exists (ADR-0012), so there is nothing to resolve `exclude`
 * against yet.
 */
export type QueryFieldSelector<Entity> =
  readonly FieldPath<Entity>[] | { readonly exclude: readonly FieldPath<Entity>[] };

/**
 * `select.fields`'s raw configuration — the same array-or-
 * `{ exclude }` shape as {@link QueryFieldSelector}, but capped to depth 1
 * ({@link FieldPath} with `MaxDepth` 1): `select=` addresses the entity's
 * own columns, and an included relation is projected through
 * `select[<relation>]=` against the target entity's own `select.fields`,
 * never `select=<relation>.<field>` (ADR-0045). A relation-dotted entry
 * does not type-check here and is a bootstrap error if it reaches
 * `resolveEntityConfig` through an erased or cast config.
 */
export type SelectableFieldSelector<Entity> =
  readonly FieldPath<Entity, 1>[] | { readonly exclude: readonly FieldPath<Entity, 1>[] };

/**
 * One relation allowlist key's raw configuration — the same array-or-
 * `{ exclude }` shape as {@link QueryFieldSelector}, but typed against the
 * entity's own top-level relation names ({@link IncludePath} capped to
 * depth 1) rather than every field path. `include=` addresses one relation
 * segment at a time from the root, so permission is granted per relation,
 * not per dotted path — `blog.name` is a `filter.fields`/`sort.fields` path
 * but `blog` is the unit `include.fields` grants or withholds.
 */
export type RelationFieldSelector<Entity> =
  readonly IncludePath<Entity, 1>[] | { readonly exclude: readonly IncludePath<Entity, 1>[] };

/** `search[mode]` values — substring (default) or per-word (doc 05 §4). */
export type SearchMode = "substring" | "words";

/**
 * Reserved discriminator for a future pluggable search backend — `'orm'`
 * is the only value this schema accepts today (issue #156). It exists so a
 * later `'postgres'` (native full-text) or `'meilisearch'` driver can land
 * additively, without a breaking config change now; it is config-only and
 * has no wire counterpart — callers never choose the backend per-request.
 */
export type SearchDriver = "orm";

/**
 * `filter.fields`'s map form: which operators are permitted per field
 * (issue #386's new capability). A field absent from the map, when the map
 * form is used, permits every operator — the map only *restricts*, it does
 * not grant a field permission the array/`{ exclude }` forms didn't already
 * give it. Tokens are the same `FilterOperatorToken` wire spellings
 * `filter[field][op]=` accepts (`"eq"`, `"in"`, …), not the AST's
 * `SCREAMING_SNAKE` names, so this map reads the same as the wire grammar
 * it restricts.
 */
export type FilterOperatorMap<Entity> = Readonly<
  Partial<Record<FieldPath<Entity> | (string & {}), readonly FilterOperatorToken[]>>
>;

/**
 * `filter.fields`'s raw configuration: the plain array-or-`{ exclude }`
 * form (which fields may be filtered on at all, every operator permitted),
 * or the map form (`{ field: [operators] }`, issue #386) restricting which
 * operators are permitted per field. A field named in the map form is
 * implicitly on the allowlist — there is no separate "which fields" list to
 * keep in sync with it.
 */
export type FilterFieldSelector<Entity> = QueryFieldSelector<Entity> | FilterOperatorMap<Entity>;

/**
 * Per-axis request-cost ceilings for `filter.limits` (issue #386, formerly
 * `KavoSettings.limits`). Grouped under `filter` because all three bound
 * the same axis — how expensive one `filter=` may be — rather than living
 * in a settings tree unrelated to the allowlist they ceiling.
 */
export interface FilterLimits {
  /** Max nesting depth of the filter AST. Defaults to 3. */
  readonly maxDepth?: number;
  /** Max array length for `IN`/`NOT_IN`/`BETWEEN` values. Defaults to 100. */
  readonly maxInValues?: number;
  /**
   * Max character length of a `like`/`ilike` pattern (issue #367 finding
   * 4). Values are always parameter-bound, so this is not an injection
   * guard — it caps the cost of a pathological pattern (heavy wildcard
   * backtracking, e.g. `%a%b%c%…`) against an unindexed or relation-joined
   * column, which is otherwise unbounded. Defaults to 200.
   */
  readonly maxLikePatternLength?: number;
}

/**
 * `EntityConfig.filter` — everything about what a request may filter on,
 * grouped in one block (issue #386, replacing `allowed.filterable` and
 * `KavoSettings.limits.{filterDepth,inValues,likePattern}`).
 */
export interface FilterConfig<Entity> {
  /**
   * What a request may name in `filter[...]=`. The array/`{ exclude }` form
   * behaves exactly as `allowed.filterable` did; the map form additionally
   * restricts which operators are permitted per named field (issue #386's
   * new capability) — unconfigured, every own column, every operator.
   */
  readonly fields?: FilterFieldSelector<Entity>;
  /**
   * The predicate applied when a request supplies no `filter=` at all — a
   * client-supplied `filter=` always wins outright, never merges with this
   * (mirroring `sort.default`/`select.default`/`include.default`, issue
   * #394). Composes with `search` (ADR'd into the same tree) and with
   * `apply` below, which still `AND`s in afterward regardless of which of
   * the two produced the base filter. Fields named here are validated
   * against `fields` at bootstrap, the same as client-supplied filters are
   * at request time.
   */
  readonly default?: FilterExpression<Entity>;
  /**
   * A mandatory server-side predicate (ADR-0048), `AND`ed into the client's
   * own `filter=` on every read, and into the id lookup of every single-row
   * write (`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne`) — a
   * row outside it is never found, so those answer `404` rather than
   * mutating or leaking existence. Unlike `fields`, this is not an
   * allowlist: the client cannot widen, remove, or bypass it by supplying
   * its own `filter=`, only narrow further inside the `AND`. Not a
   * substitute for `filter.fields`/`filter.limits`, and — unlike a
   * `default` (`sort.default`/`select.default`/`include.default`) — not a
   * fallback for an absent client value either: it always applies. See
   * ADR-0048 for the full composition rules and why single-row writes are
   * gated the way they are.
   */
  readonly apply?: FilterApply<Entity>;
  readonly limits?: FilterLimits;
}

/**
 * Per-axis request-cost ceilings for `include.limits` (issue #386, formerly
 * `KavoSettings.limits.{includeDepth,includedNodes}`).
 */
export interface IncludeLimits {
  /** Max relation-include nesting depth (ADR-0008). Overridable per-subtree by `relations.<name>.read.maxDepth`. Defaults to 2. */
  readonly maxDepth?: number;
  /** Max total number of included relation nodes across the whole include tree. Defaults to 10. */
  readonly maxNodes?: number;
}

/**
 * `EntityConfig.include` — everything about which relations a request may
 * embed, grouped in one block (issue #386, replacing `allowed.includable`,
 * `KavoSettings.defaults.include`, and `KavoSettings.limits.
 * {includeDepth,includedNodes}`).
 */
export interface IncludeConfig<Entity> {
  /**
   * What a request may name in `include=` — which relations, one path
   * segment at a time from the root, a client may embed at all
   * (ADR-0028). `EntityConfig.relations.<name>.read` (issue #404, formerly
   * `KavoSettings.relations.edges.<name>`) still tunes `maxDepth`/`strategy`
   * for a relation once it is includable, but does not grant permission
   * itself: naming a relation there without also naming it here does not
   * open it.
   *
   * **Opt-in, unlike every other field-group's `fields`.** An unconfigured
   * `include.fields` means **no relation is includable** — the opt-in
   * posture `relations.edges` had before ADR-0028. `{ exclude: [] }`,
   * written explicitly, means the opposite — every relation includable.
   */
  readonly fields?: RelationFieldSelector<Entity>;
  /**
   * Relations included even when the client's `include=` doesn't name
   * them. Each entry must also be on `fields` (ADR-0028's cross-check) —
   * naming a relation here that clients cannot ask for is a bootstrap
   * error.
   */
  readonly default?: readonly IncludePath<Entity, 1>[];
  /**
   * Relation paths force-included on every request, unioned into the
   * client's own `include=` before resolution (ADR-0048) — unlike
   * `default`, this is not overridden by a client-supplied `include=`, it
   * always applies. Forced paths still pass through the same
   * `IncludeResolver` validation (depth/breadth limits, `fields`
   * allowlist) as any client-requested path.
   */
  readonly apply?: IncludeApply<Entity>;
  readonly limits?: IncludeLimits;
}

/**
 * One relation's read-loading *tuning* — the `maxDepth`/`strategy` half of
 * a `RelationDescriptor`, applied once the relation is already includable.
 * Permission is `include.fields`'s job (ADR-0028), never this block: an
 * entry here for a relation `include.fields` never named still validates
 * and applies its tuning, but opens nothing. Was
 * `KavoSettings.relations.edges.<name>` before issue #404 folded relation
 * config into this one entity-scope block.
 */
export interface RelationReadConfig {
  /** Overrides `include.limits.maxDepth` for the subtree below this node. */
  readonly maxDepth?: number;
  /**
   * How this relation loads when included (`join`/`batch`/`key`/`auto`).
   * `strategy: "key"` is rejected at bootstrap on a to-many relation, and
   * on the inverse side of a one-to-one — neither has a local foreign-key
   * column to read (`DefaultRelationRegistry`).
   */
  readonly strategy?: RelationLoadStrategy;
}

/**
 * One relation's array-mutation write policy (ADR-0029). Opting in **and**
 * naming the strategy in a single statement — since issue #404 there is no
 * entity-level `arrayMutation` default to inherit, and omitting `write`
 * entirely is how a relation stays non-array-mutable. Only meaningful on a
 * to-many relation: `write` on a to-one relation is a bootstrap
 * `ConfigurationException` (`DefaultRelationRegistry`), since association by
 * id already covers to-one writes (ADR-0014). Independent of
 * `include.fields` — a relation can be write-opted without being
 * read-includable, or vice versa — and independent of write *permission*,
 * which is the `create`/`update` field lists and registered write DTOs
 * (ADR-0014), not this block.
 */
export interface RelationWriteConfig {
  readonly strategy: ArrayMutationStrategy;
}

/**
 * One entry in {@link RelationsConfig} — read tuning, an array-mutation
 * write policy, or both. An entry that carries neither (`{}`, or
 * `{ read: {} }`) tunes nothing and is a bootstrap
 * `ConfigurationException`; drop it instead of leaving it empty.
 */
export interface RelationConfig {
  readonly read?: RelationReadConfig;
  readonly write?: RelationWriteConfig;
}

/**
 * `EntityConfig.relations` — per-relation read tuning and array-mutation
 * write policy, keyed by the entity's own top-level relation names (issue
 * #404, folding `KavoSettings.relations.edges` and
 * `KavoSettings.arrayMutation` into one entity-scope block — the same move
 * issue #386 made for `filter`/`sort`/`select`/`search`/`include`).
 *
 * Structural entity-scope config like `dto`/`computed`: resolved directly
 * by `DefaultRelationRegistry` at bootstrap, never merged through the
 * global → operation → per-call precedence chain, and with no global or
 * built-in default. This block never grants permission — read-includability
 * is `include.fields` (ADR-0028), write-permission is `create`/`update`/DTO
 * (ADR-0014).
 */
export type RelationsConfig<Entity> = {
  readonly [K in IncludePath<Entity, 1>]?: RelationConfig;
};

/**
 * `EntityConfig.sort` — everything about what a request may sort by,
 * grouped in one block (issue #386, replacing `allowed.sortable` and
 * `KavoSettings.defaults.sort`).
 */
export interface SortConfig<Entity> {
  readonly fields?: QueryFieldSelector<Entity>;
  /**
   * Order applied when a request supplies no `sort` — a client-supplied
   * `sort` always wins outright, never merges with this. The same wire
   * shorthand a `sort=` query parameter uses (`-field` for descending,
   * `field` for ascending). Fields are validated against `fields` at
   * bootstrap, the same as client-supplied sort fields are at request time.
   */
  readonly default?: readonly string[];
  /**
   * Sort keys forced ahead of the client's own `sort=` (or `default`
   * above) — unlike `default`, always applied, never overridden by a
   * client-supplied `sort=` (ADR-0048). Prepended to the effective sort;
   * a client field already named among them is deduplicated out of its
   * own position rather than sorted on twice.
   */
  readonly apply?: SortApply<Entity>;
}

/**
 * `EntityConfig.select` — everything about what a request may select and
 * what a response projects by default, grouped in one block (issue #386,
 * replacing `allowed.selectable` and `KavoSettings.defaults.select`).
 *
 * An ORM-derived field (`FieldMetadata.derivedExpression`) is a real class
 * property, so it already type-checks as a `FieldPath` and needs no
 * separate widening here. It is opt-in to `fields` (ADR-0050): the
 * unconfigured default excludes it, the same as a relation.
 */
export interface SelectConfig<Entity> {
  /**
   * What a request may name in `select=`, **and** what a response carries
   * when it sends no `select=` at all (ADR-0026).
   *
   * The second half is what makes this a confidentiality control rather
   * than a validation list: a column left off is not served. Omit the key
   * and the projection is unchanged — every own column.
   *
   * **It closes the response body and nothing else.** `filter.fields` and
   * `sort.fields` default to every column independently, so
   * `filter[apiKey][like]=a%` binary-searches the value and `sort=apiKey`
   * leaks its ordering; the writable projection is derived separately, so
   * the column is still writable — and this key makes that write
   * *invisible* by removing the echo. Hiding a credential means narrowing
   * every axis and registering a write DTO (ADR-0026 §6).
   *
   * A registered `dto.item`/`dto.list` with a runtime shape **replaces**
   * the projection rather than intersecting with it, so it wins even where
   * it is *wider*. Where you register one, it — not this key — is the
   * narrowing statement.
   */
  readonly fields?: SelectableFieldSelector<Entity>;
  /**
   * The default response projection: what a read serves when the request
   * sends no `select=` of its own. Fields are validated against `fields`
   * at bootstrap.
   */
  readonly default?: readonly FieldPath<Entity, 1>[];
  /**
   * Fields force-included in the projection, unioned into whatever the
   * request would otherwise project (its own `select=`, or `default`
   * above) — additive only, never a mask, and always applied regardless
   * of what the client asked for (ADR-0048). A `null`/unconfigured
   * projection already means "everything", so a forced field there is a
   * no-op. Narrowing the projection per caller is a different feature,
   * not this one.
   */
  readonly apply?: SelectApply<Entity>;
}

/**
 * `EntityConfig.search` — everything about free-text search, grouped in
 * one block (issue #386, replacing `allowed.searchable` and
 * `KavoSettings.search`). `false` (the default) disables search —
 * `search[query]` is rejected with a 400 until an entity or operation scope
 * sets an object.
 */
export interface SearchConfig<Entity> {
  /**
   * What `search[fields]` may narrow to, and the full field set a
   * `search[query]` searches when it does not. Same shape and default
   * posture as `filter.fields`/`sort.fields`: when unconfigured, every own
   * **string**-kind column — narrower than `filter.fields`'s "every own
   * column" default, since a non-string column has nothing an `ILIKE`
   * fragment can usefully match.
   *
   * Unlike `filter.fields`/`sort.fields`, entries **may** be relation paths
   * (`'brand.name'`) — search is a single free-text term spread across
   * whatever fields make sense for a "search box".
   */
  readonly fields?: QueryFieldSelector<Entity>;
  /** The default free-text term when a request sends no `search[query]` (issue #386's new capability). */
  readonly default?: string;
  readonly mode?: SearchMode;
  readonly driver?: SearchDriver;
}

/**
 * Every `KavoSettings` key a per-operation (or per-call) scope could carry
 * — the whole tree except the global `operations` enablement map, which is
 * boolean-only global state (issue #38).
 */
type SettingsSubtreeKey = Exclude<keyof KavoSettings, "operations">;

/**
 * A per-operation settings scope narrowed to the keys the operation
 * actually consumes (issue #415). Keys in `Allowed` carry their normal
 * `DeepPartial<KavoSettings>` value; every other settings key is pinned to
 * `never`, so naming one on an operation entry is a compile error rather
 * than a value that resolves into `settingsFor(op)` and is then silently
 * ignored. The `never` pin — rather than a plain `Pick` of `Allowed` — is
 * what makes the custom-operation intersection (`Ops[Id] &
 * CustomOperationConfig<…>`, via {@link CustomOperationsOf}) actually
 * reject a stray key: `<real value> & never` collapses to `never`.
 */
type OperationSettings<Allowed extends SettingsSubtreeKey> = {
  readonly [K in SettingsSubtreeKey]?: K extends Allowed ? DeepPartial<KavoSettings>[K] : never;
};

/**
 * Per-operation configuration.
 * Naming a standard id in the parent `operations` record — this object, or
 * the `true`/`false` shorthand — is what enables or disables it (ADR-0038,
 * issue #257); there is no `enabled` field here, since `true`/`false`
 * already says so explicitly and this object's own presence says so
 * implicitly.
 *
 * `DtoOverride` is `StandardOperationsConfig`'s per-id `Pick` of
 * `OperationDtoOverride` — only the fields that operation actually
 * supports (issue #131). `Allowed` is the same idea for the settings
 * subtree (issue #415): `StandardOperationsConfig` passes each id only the
 * `KavoSettings` keys that id's engine stages read — `pagination` to
 * `findMany` alone, `cache` to the reads, `realtime` to the writes,
 * `delete` to the reads and the delete family (the operations whose
 * behavior the resolved soft-delete view changes — `kavo-engine.ts`
 * `configViewFor`), and `errors` to all. Both parameters default to the
 * full shape so a bare `OperationConfig<Entity>` (used where no specific
 * operation id is in scope — the `OperationsConfig` index signature's
 * permissive upper bound) still type-checks.
 */
export type OperationConfig<
  Entity = unknown,
  DtoOverride = OperationDtoOverride,
  Allowed extends SettingsSubtreeKey = SettingsSubtreeKey,
> = OperationSettings<Allowed> & {
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
  /**
   * Authorization for this operation (ADR-0037). Nearest scope wins,
   * wholesale: this overrides the entity's own `EntityConfig.policy`, which
   * overrides the root `GlobalConfig.policy` (`createKavo({ policy })`).
   * `false` opts this operation back out of an inherited entity- or
   * global-scope default, back to unrestricted — the only way to spell
   * that, since omitting the key here instead means "inherit," not "no
   * policy." Absent every scope, the operation runs unrestricted: the same
   * opt-in posture every other Kavo default takes. The engine always
   * pre-fetches the row before calling this on a single-row operation
   * (`findOne`/`updateOne`/`patchOne`/`deleteOne`/`restoreOne`/`purgeOne`),
   * whether the policy is declared here or inherited; on `createOne`/
   * `findMany` the policy still runs, with `entity: undefined`.
   */
  readonly policy?: Policy<Entity> | false;
};

/**
 * The `operations` map's per-id DTO override shapes (issue #131): each
 * standard operation `Pick`s only the `OperationDtoOverride` fields it
 * actually has — a write op gets `input`/`output`, a read gets
 * `output`/`query`, and `deleteOne`/`purgeOne` (void results, no query)
 * get neither, so setting `dto` on them is a type error before it is ever
 * a bootstrap one. The `true`/`false` shorthand is still accepted at every
 * id (ADR-0038, issue #257), for a plain enable/disable with no settings attached.
 *
 * The third `OperationConfig` argument narrows the settings subtree the
 * same way (issue #415): each id names only the `KavoSettings` keys its
 * engine stages read —
 *
 * - `pagination` on `findMany` alone — the sole operation the query
 *   normalizer applies a page window for.
 * - `realtime` on every write (`REALTIME_EVENT_BY_OPERATION`, `purgeOne`
 *   included); a read emits nothing.
 * - `delete` on the reads and the delete family — the operations
 *   `configViewFor` resolves a soft-delete view for; a per-operation
 *   `strategy` override is a shipped feature (`soft-delete.spec.ts`).
 *   `createOne`/`updateOne`/`patchOne` consult no soft-delete strategy.
 * - `cache` and `errors` on every id: `cache` is not narrowed because its
 *   `etag` half governs `If-Match`/`304` on every single-row operation,
 *   the void deletes included (`isEtagEnabled`), not just the reads its
 *   `ttl` half caches (`isCacheableRead`).
 *
 * A key an id does not name is pinned to `never`, so `findOne: { pagination:
 * … }` or `createOne: { delete: false }` is a compile error rather than a
 * silently-dropped value.
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
  readonly createOne?:
    OperationConfig<Entity, Pick<OperationDtoOverride, "input" | "output">, "errors" | "cache" | "realtime"> | boolean;
  readonly findOne?:
    OperationConfig<Entity, Pick<OperationDtoOverride, "output" | "query">, "errors" | "cache" | "delete"> | boolean;
  readonly findMany?:
    | OperationConfig<
        Entity,
        Pick<OperationDtoOverride, "output" | "query">,
        "errors" | "cache" | "delete" | "pagination"
      >
    | boolean;
  readonly updateOne?:
    OperationConfig<Entity, Pick<OperationDtoOverride, "input" | "output">, "errors" | "cache" | "realtime"> | boolean;
  readonly patchOne?:
    OperationConfig<Entity, Pick<OperationDtoOverride, "input" | "output">, "errors" | "cache" | "realtime"> | boolean;
  /** Void result, no query — no `dto` override is representable. */
  readonly deleteOne?: OperationConfig<Entity, never, "errors" | "cache" | "realtime" | "delete"> | boolean;
  readonly restoreOne?:
    OperationConfig<Entity, Pick<OperationDtoOverride, "output">, "errors" | "cache" | "realtime" | "delete"> | boolean;
  /** Void result, no query — no `dto` override is representable. */
  readonly purgeOne?: OperationConfig<Entity, never, "errors" | "cache" | "realtime" | "delete"> | boolean;
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
 * - the settings subtree it accepts (issue #415) is narrowed by the `Kind`
 *   and `Cardinality` this entry declares — see {@link CustomOperationSettingsKey}.
 *   `Ops` carries `kind`/`cardinality` as literals from the caller's own
 *   object, so {@link CustomOperationsOf} reads them back and passes them
 *   here, the same route `CustomOperationResult` already uses to type
 *   `run`'s envelope.
 *
 * A custom operation is reachable over HTTP through `meta.routes`
 * (`@kavo/nest`) and in code through `KavoService.run`.
 */
export type CustomOperationConfig<
  Entity = unknown,
  Kind extends OperationKind = OperationKind,
  Cardinality extends OperationCardinality = OperationCardinality,
> = OperationSettings<CustomOperationSettingsKey<Kind, Cardinality>> & {
  /** Registered but inert when `false` — the same seam a standard id has. */
  readonly enabled?: boolean;
  /**
   * The operation's behavior. Required: nothing else can supply it.
   *
   * It reads and writes through `context.repository`, the entity's own
   * `RepositoryAdapter` (ADR-0025), so it needs nothing in scope where it
   * is written — which is what makes it writable inside a `@Kavo` config,
   * evaluated at class-decoration time (ADR-0012).
   */
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
};

/**
 * The `KavoSettings` keys a *custom* operation's config may carry, from its
 * declared `kind`/`cardinality` (issue #415). `errors` and `cache` are
 * always in scope — a custom response is serialized and ETagged like any
 * other, even though `cache`'s `ttl` half never caches it
 * (`isCacheableRead` refuses any id but `findOne`/`findMany`). A
 * `kind: "read"` entry additionally gets `delete` — `configViewFor`
 * resolves a soft-delete view for every read, custom ones included — and,
 * when its result goes through the list envelope (`cardinality: "many"`),
 * `pagination`, the one case the query normalizer applies a page window to.
 * A `kind: "write"` custom operation drives its own writes through
 * `context.repository`, so a resolved `delete` view changes nothing for it.
 * `realtime` is never in scope: `REALTIME_EVENT_BY_OPERATION`'s vocabulary
 * is closed to the standard writes.
 *
 * Both parameters distribute, so the wide default
 * (`OperationKind`/`OperationCardinality`, used for the bare
 * `CustomOperationConfig<Entity>` in `OperationsConfig`'s index-signature
 * upper bound) resolves to `"errors" | "cache" | "delete" | "pagination"` —
 * permissive enough to be an upper bound, while a concrete entry's own
 * literals give the exact row.
 */
type CustomOperationSettingsKey<
  Kind extends OperationKind,
  Cardinality extends OperationCardinality,
> = Kind extends "read"
  ? Cardinality extends "many"
    ? "errors" | "cache" | "delete" | "pagination"
    : "errors" | "cache" | "delete"
  : "errors" | "cache";

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
 *
 * Each mapped entry also reads `Ops[Id]`'s own `kind`/`cardinality`
 * literals and passes them to `CustomOperationConfig`, so the settings
 * subtree it accepts is the row {@link CustomOperationSettingsKey} names
 * for that combination (issue #415): `errors`/`cache` always, `delete` on
 * any `kind: "read"`, `pagination` also on a `kind: "read", cardinality:
 * "many"` entry, `realtime` never. A missing `kind`/`cardinality` reads as
 * the `"write"`/`"one"` default, exactly as the engine resolves it.
 * `Ops` is already inferred here (see above), so this is another read off a
 * known type, not a constraint that would collapse inference.
 */
export type CustomOperationsOf<Entity, Ops> = string extends keyof Ops
  ? unknown
  : {
      readonly [Id in Exclude<keyof Ops, StandardOperationId>]: CustomOperationConfig<
        Entity,
        Ops[Id] extends { readonly kind: infer K extends OperationKind } ? K : "write",
        Ops[Id] extends { readonly cardinality: infer C extends OperationCardinality } ? C : "one"
      >;
    };

/**
 * Raw entity-scope configuration — the second argument to `createCrud`.
 * Settings keys (inherited from `DeepPartial<KavoSettings>`) override
 * global scope for this entity.
 */
export interface EntityConfig<
  Entity,
  CreateDto = EntityInput<Entity>,
  UpdateDto = EntityInput<Entity>,
  PatchDto = Partial<UpdateDto>,
  QueryDto = QueryContext<Entity>,
  ItemDto = Entity,
  ListDto = ItemDto,
  // The constraint fixes the shape `operations` accepts; the free
  // parameter is what lets inference capture the *literal* dto classes a
  // caller registers per operation, which `DtoInputOf`/`DtoOutputOf`/
  // `DtoQueryOf` (dto.ts) then read back off `KavoService`'s `Ops`
  // parameter (issue #131). The constraint is `OperationsConfig` rather
  // than `StandardOperationsConfig` (issue #145) so that a key outside the
  // standard eight is a permitted custom operation rather than an excess
  // property.
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
  /**
   * `create`/`update`/`patch`/`item`/`list` each accept a registered DTO
   * class; `patch`/`item`/`list` additionally accept an inline
   * `{ fields: [...] }` shorthand (issue #386) that derives a
   * projection/writable-field list without a hand-written class.
   * `create`/`update` do not accept that shorthand here — their writable-
   * field list is the top-level `create`/`update` keys below (issue #388),
   * keeping this map DTO-class-only for the two write slots.
   */
  readonly dto?: OperationDtoMap<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto>;
  /**
   * What `createOne` (and `createMany`, once #137 lands) may write. A
   * `{ fields: [...] }` allowlist (the shorthand `dto.patch`/`dto.item`/
   * `dto.list` also accept, issue #386), or the inverse `{ fields: { exclude:
   * [...] } }` form the read-side field groups take (issue #397) — "every
   * writable field except these", resolved at bootstrap against the ADR-0014
   * writable projection, with an `exclude` entry that names nothing writable
   * a bootstrap error. Moved to its own top-level key (issue #388) so
   * `dto.create` stays reserved for a registered DTO class. Omitted — or an
   * `{ exclude }` that removes nothing — every own writable field is open:
   * every non-generated scalar column except the primary key, plus every
   * relation, by association (ADR-0014). A
   * registered `dto.create` class with a runtime shape **replaces** this
   * projection rather than intersecting with it, and wins over this key —
   * where you register one, it, not this key, is the narrowing statement.
   *
   * `default` fills in a value for a writable field the request body
   * doesn't set (`createOne` only) — a body that *does* send the field
   * always wins outright, the same one-way relationship a client value has
   * with `sort.default`/`select.default`/`include.default`. Validated at
   * bootstrap against the entity's own writable columns.
   */
  readonly create?: WriteFieldsConfig<Entity>;
  /**
   * What `updateOne`/`patchOne` (and their `*Many` forms, once #137 lands)
   * may write. `update` (PUT) and `patch` (PATCH) share this one list
   * rather than each getting its own — both mutate an existing row, so the
   * set of fields open to being overwritten is the same question either
   * way. Same default posture, narrowing behaviour, and DTO precedence as
   * {@link EntityConfig.create} — see its note.
   *
   * `default` is `updateOne`-only, never `patchOne`: a `PATCH` omitting a
   * field means "leave it unchanged", so filling it in there would
   * silently overwrite a value the caller never touched. `updateOne` (PUT)
   * is a full replacement, so a value it omits filling in from `default`
   * matches PUT's own replace-the-whole-resource semantics.
   */
  readonly update?: WriteFieldsConfig<Entity>;
  /**
   * Default authorization for every operation on this entity (ADR-0037): a
   * single function, not a per-operation map — a map invited "which of the
   * two spots governs `updateOne`?"; a plain default that
   * `operations.<id>.policy` overrides (or opts out of with `false`) does
   * not.
   *
   * Structural entity-scope config like `dto` — outside the settings
   * precedence chain (a policy is itself a closure) — resolved by its own
   * "nearest scope wins" walk, not `mergeSettings`. Falls back to
   * `GlobalConfig.policy` (`createKavo({ policy })`) when unset here;
   * overridden per operation by `operations.<id>.policy`, including
   * `operations.<id>.policy: false` to opt one operation out. There is
   * still no per-call override.
   */
  readonly policy?: Policy<Entity>;
  /**
   * What a request may filter on, and its per-field operator restrictions
   * and request-cost ceilings (issue #386, replacing `allowed.filterable`
   * and the old top-level `limits`).
   */
  readonly filter?: FilterConfig<Entity>;
  /**
   * What a request may sort by, and the default sort a request with none
   * gets (issue #386, replacing `allowed.sortable` and `defaults.sort`).
   */
  readonly sort?: SortConfig<Entity>;
  /**
   * What a request may select, and the default response projection
   * (issue #386, replacing `allowed.selectable` and `defaults.select`).
   */
  readonly select?: SelectConfig<Entity>;
  /**
   * Free-text search: which fields it reaches, its default term, and its
   * mode/driver (issue #386, replacing `allowed.searchable` and the old
   * top-level `search`). `false` disables search — the default.
   */
  readonly search?: SearchConfig<Entity> | false;
  /**
   * What a request may include, its defaults, and its request-cost
   * ceilings (issue #386, replacing `allowed.includable`,
   * `defaults.include`, and the old top-level `limits.{includeDepth,
   * includedNodes}`).
   */
  readonly include?: IncludeConfig<Entity>;
  /**
   * Per-relation read-loading tuning (`maxDepth`/`strategy`) and
   * array-mutation write policy (`write.strategy`), keyed by the entity's
   * own top-level relation names (issue #404, folding
   * `KavoSettings.relations.edges` and `KavoSettings.arrayMutation` into
   * one entity-scope block). Grants no permission — `include.fields`
   * (ADR-0028) and `create`/`update`/DTO (ADR-0014) still hold that. An
   * entry that tunes nothing (`{}`) is a bootstrap error.
   */
  readonly relations?: RelationsConfig<Entity>;
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
