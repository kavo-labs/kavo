import type { RelationLoadStrategy } from "../relations/relation-descriptor.js";
import type { StandardOperationId } from "../operations/operation.js";
import type { RealtimeEventDto, RealtimeEventId } from "../realtime/realtime-event.js";
import type { RealtimeTransport } from "../realtime/realtime-transport.js";

/**
 * The complete, canonical settings schema — one schema for every scope.
 *
 * These interfaces describe *resolved* (complete) settings. Input scopes —
 * global (`createKavo`), entity (`createCrud`), operation, and per-call —
 * all accept `DeepPartial<KavoSettings>` of this same shape; there is
 * never a second config mechanism (schema-extensibility rule).
 * Later features add keys here, reserved in the schema now.
 *
 * Field-level configuration — what a request may filter/sort/select/
 * search/include, its per-axis defaults, and its per-axis ceilings — lives
 * on `EntityConfig`'s `dto`/`select`/`search`/`filter`/`sort`/`include`
 * blocks instead (issue #386), grouped by concern rather than split across
 * this schema and a separate allowlist tree. This schema carries only the
 * settings that are not field-shaped.
 */

/** Built-in pagination strategy names; open for custom strategies. */
export type PaginationStrategyName = "offset" | "page" | "cursor" | "since" | "none" | (string & {});

export interface PaginationSettings {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  /**
   * `"none"` (ADR-0030) opts the entity out of pagination altogether —
   * `findMany` serves the whole match set every time, `defaultLimit`/
   * `maxLimit` are unused, and a client-sent `limit`/`offset` is rejected
   * outright rather than silently ignored (`NonePaginationStrategy`,
   * `pagination-strategies.ts`). It composes with no other strategy: this
   * key picks exactly one.
   */
  readonly strategy: PaginationStrategyName;
  /** Whether list responses compute `total` (the count query). */
  readonly count: boolean;
  /**
   * Only consulted under `strategy: "since"` (ADR-0022). The column
   * `?since=` seeks against and the effective sort's leading key —
   * `[since.field, idField]` ascending, forced regardless of client `sort`.
   * Must be a `date`- or `string`-kind column on the entity, and on
   * `filter.fields`/`select.fields`; a bootstrap error otherwise
   * (`resolveEntityConfig`), the same treatment `softDelete.field` gets.
   */
  readonly since: {
    readonly field: string;
  };
}

export interface ErrorSettings {
  /** Leak driver-level error details into responses — off by default. */
  readonly exposeInternals: boolean;
}

/**
 * Per-relation *tuning* — the config half of a `RelationDescriptor` other
 * than permission. ORM metadata supplies shape (name, target,
 * cardinality); this supplies loading behavior once a relation is already
 * includable. Permission itself lives on `include.fields`
 * (`EntityConfig`, entity-config.ts) instead, not here (ADR-0028) — naming
 * a relation in `edges` no longer opts it in.
 */
export interface RelationEdgeSettings {
  /** Overrides `include.limits.maxDepth` for the subtree below this node. */
  readonly maxDepth?: number;
  readonly strategy?: RelationLoadStrategy;
  /**
   * Opts this relation into `arrayMutation` writes (ADR-0014's named
   * extension point) — the per-relation half of the policy, `arrayMutation`
   * itself is the strategy half. Only meaningful on a to-many relation;
   * `write: true`/`write: {...}` on a to-one relation is a bootstrap
   * `ConfigurationException` (`DefaultRelationRegistry`), since association
   * by id already covers to-one writes and there is no array to mutate.
   * Independent of `include.fields` (a relation can be write-opted-in
   * without being read-includable, or vice versa).
   *
   * Two spellings (issue #223, ADR-0029's per-relation amendment):
   * - `true` — opt in, strategy inherited from this entity's own resolved
   *   `arrayMutation.strategy`. The original, entity-wide-only behavior.
   * - `{ strategy }` — opt in *and* pin this relation's own strategy,
   *   overriding whatever the entity resolves to. Two relations on the same
   *   entity can this way use two different strategies (e.g. one `replace`,
   *   another `jsonPatch`) — `arrayMutation.strategy` above still supplies
   *   the default for any relation that just says `write: true`.
   *
   * `arrayMutation: false` at entity scope disables the feature wholesale
   * and wins over any per-relation override — a relation cannot re-enable
   * array-mutation writes for itself while its entity has them off
   * (`DefaultRelationRegistry`).
   */
  readonly write?: boolean | { readonly strategy: ArrayMutationStrategy };
}

/**
 * Per-relation loading tuning. Inclusion *limits* live in
 * `EntityConfig.include.limits` instead (issue #386) — this block is
 * `edges` only.
 */
export interface RelationSettings {
  /**
   * Per-relation loading overrides, keyed by relation property name —
   * `maxDepth`/`strategy`/`write` only. Whether a relation is includable at
   * all is `include.fields`'s question, and whether it defaults into an
   * empty request is `include.default`'s — neither lives here any more; an
   * entry here for a relation `include.fields` never named still validates
   * and applies its loading tuning, but grants no permission.
   */
  readonly edges: Readonly<Record<string, RelationEdgeSettings>>;
}

/**
 * The `etag` half of `cache` (ADR-0020) — the conditional-request
 * machinery. `false` turns the feature off — no tag is computed,
 * `If-None-Match` is ignored, and an `If-Match` — the one header whose
 * whole purpose is to prevent a write — is **refused** with 412
 * `KAVO_PRECONDITION_UNSUPPORTED` rather than ignored. Ignoring it would
 * answer 2xx for a guard that was never applied, which the per-operation
 * scope makes easy to arrive at by accident: `findOne` serving tags while
 * `updateOne` has `etag` off is a client holding a tag nothing will ever
 * check.
 */
export type EtagSettings = boolean;

/**
 * Result caching and its ETag half (ADR-0031). `etag` is the
 * conditional-request machinery (ADRs 0020/0027): it computes an `ETag`
 * and answers `If-None-Match`/`If-Match`. `ttl` is the engine-level
 * shortcut that serves a repeated `findOne`/`findMany` from a store
 * without touching the adapter at all. They compose: a cached hit still
 * re-derives the current `ETag` for the request at hand, so the two
 * features never fight.
 *
 * `false` disables the subtree wholesale (result cache **and** etags), the
 * same convention `softDelete` uses. Otherwise the result cache is on
 * exactly when `ttl` is a positive number: `ttl`'s presence **is** the
 * switch — there is no separate `enabled` key, and no magic number to
 * remember. An omitted `ttl` (the default) means the result cache is off;
 * `@Kavo(Entity, { cache: { ttl: 60 } })` means "on, 60 seconds". `ttl: 0`
 * and any other non-positive or non-integer `ttl` fail bootstrap validation
 * (ADR-0031) — `false` disables the whole subtree, omitting `ttl` disables
 * just the result cache, and there is no third spelling for "off".
 *
 * `ttl: false` is the one exception, reserved for overriding an
 * **inherited** `ttl` back off at a narrower scope without touching that
 * scope's `etag` — `cache: false` would also disable ETags, which
 * `{ ttl: false }` deliberately leaves alone. It merges like any other
 * explicit value (`mergeSettings` never treats it as "clear the key"), so a
 * later, still-narrower scope's own `ttl: 30` overrides it in turn. Writing
 * `cache: { ttl: false }` at a scope with no inherited `ttl` is equivalent
 * to omitting `ttl` — both mean "off" — but the presence form is meant for
 * turning an inherited "on" back off, not as a spelling to reach for by
 * default.
 *
 * Touching only `etag` on an otherwise-off entity is then the natural
 * spelling — `cache: { etag: false }` — and never flips the result cache
 * on.
 *
 * `etag` defaults **on** (`true`) independent of `ttl`: an entity with
 * result caching off still serves ETags and honors the conditional
 * headers.
 *
 * TTL is in **seconds**; the store enforces it (the engine never reads a
 * clock). Successful writes on the entity invalidate its cached entries
 * wholesale — there is no per-key staleness analysis (ADR-0031).
 *
 * The backing store is **not** a key here, exactly like `realtime`'s
 * transports: a store is a live object (a Redis client, say), not
 * configuration data, so it cannot live inside this deep-frozen tree.
 * `KavoOptions.cacheStore` (kavo.ts) is where it is registered instead,
 * once per `createKavo` root, and reached at runtime through
 * `ResolvedEntityConfig.cacheStore` — the ADR-0023 relationship applied to
 * caching (ADR-0031).
 */
export interface CacheSettings {
  readonly ttl?: number | false;
  readonly etag: EtagSettings;
}

/**
 * How the delete strategy is chosen. `auto` — the default —
 * resolves per entity: soft when it carries the delete-marker field, hard
 * otherwise, so entities that aren't soft-deletable cost nothing. `soft`
 * and `hard` state the strategy outright; `soft` on an entity without a
 * marker field fails at bootstrap.
 */
export type SoftDeleteMode = "auto" | "soft" | "hard";

/** Soft delete. `false` at any scope disables it entirely. */
export interface SoftDeleteSettings {
  /** Delete-marker field name (`deletedAt: Date | null` convention). */
  readonly field: string;
  readonly strategy: SoftDeleteMode;
}

/**
 * Which fields a transport may expose an individual subscription to — the
 * same array-or-`exclude` shape `select.fields` uses
 * (`SelectableFieldSelector`, entity-config.ts), but plain strings: unlike
 * `EntityConfig`, `KavoSettings` carries no `Entity` type parameter
 * (`relations.edges`'s keys are plain strings for the same reason), so
 * there is no layer here to check a field name against real entity paths.
 */
export type RealtimeFieldSelector = readonly string[] | { readonly exclude: readonly string[] };

/**
 * Realtime event publishing. `false` disables the subtree entirely, the
 * same convention `softDelete` uses; any object enables it — there is no
 * separate `enabled` switch inside.
 *
 * Registered transports are **not** a key here, unlike `events`/
 * `subscribableFields`: a transport is a live object (a socket server, a
 * broker connection), not configuration data, and this schema is deep-
 * frozen once resolved (`deepFreeze`, merge-settings.ts) — freezing a
 * transport's own internal state the way freezing a plain `{ field,
 * direction }` entry is harmless would break it. `KavoOptions.realtimeTransports` (ADR-0023)
 * (`kavo.ts`) is where transports are registered instead, once per
 * `createKavo` root, and reached at runtime through
 * `ResolvedEntityConfig.realtimeTransports` — structural, like `relations`
 * and `dto`, not merged through this precedence chain. See the `operations.
 * <id>.handler` doc for the same reasoning applied to another live-object
 * exception to "settings are data."
 */
export interface RealtimeSettings {
  /**
   * Per-event opt-out: an id absent here is emitted, like every other
   * positively-phrased boolean in this schema — enabling realtime means
   * "emit everything" by default, then dial specific events back with
   * `false`. Optional rather than defaulted to `{}` in `BUILT_IN_DEFAULTS`:
   * the built-in default for the whole subtree is `false` (issue #247), so
   * there is no complete base object left for a first-time partial override
   * (say, `realtime: { subscribableFields: [...] }`) to merge `events` in
   * from — `mergeSettings` replaces a non-object base wholesale. Omitted
   * here behaves exactly like `{}`: nothing is suppressed.
   */
  readonly events?: Readonly<Partial<Record<RealtimeEventId, boolean>>>;
  /**
   * Bounds what a future field-scoped subscription may reach for this
   * entity (not built yet — this issue only emits whole-item, entity-level
   * events). Omitted: no field-level subscription is possible here.
   */
  readonly subscribableFields?: RealtimeFieldSelector;
  /**
   * Called when a transport's `publish` rejects — the failure never fails
   * the mutation regardless (a subscriber not hearing about a write that
   * already succeeded is a delivery problem, not a data problem), and
   * `@kavo/core` has no ambient console/logger to fall back on (ADR-0005:
   * `packages/core`'s `tsconfig.json` sets `lib: ["ES2022"]` with no DOM/
   * Node globals, deliberately). Left unset, a failed publish is silently
   * swallowed.
   */
  readonly onPublishError?: (error: unknown, transport: RealtimeTransport, event: RealtimeEventDto) => void;
}

/**
 * `arrayMutation.strategy` values (ADR-0014's named extension point for
 * write-side relations beyond associate-by-id). `"replace"` is a whole-array
 * `PUT :id/<relation>` on the relation, still id-only per ADR-0014, with
 * partial mutation disabled (ADR-0029). `"jsonPatch"` reuses `PATCH
 * /entity/:id` (`patchOne`) instead: an array body there is parsed as an
 * RFC 6902 patch document — `add`/`replace` on `/<field>` for a scalar
 * column, `add`/`remove` on `/<relation>/-` for a write-opted-in relation's
 * membership — while an object body keeps `patchOne`'s ordinary contract
 * unchanged (ADR-0029's jsonPatch amendment). `"resource"` synthesizes four
 * per-relation sub-collection operations instead of one — `GET`/`POST`/
 * `DELETE`/`PUT` `:id/<relation>`, adding `list`/`add`/`remove`
 * single-member semantics alongside the same whole-array `replace` `PUT`
 * uses — for a relation opted into `relations.edges.<name>.write`
 * (ADR-0029's resource amendment).
 */
export type ArrayMutationStrategy = "replace" | "resource" | "jsonPatch";

/**
 * Array-relation write policy (config half — see `RelationDescriptor.write`
 * for the per-relation opt-in). `strategy` has no built-in default (issue
 * #221 amends ADR-0029): a relation opted into `write` demands one be
 * declared explicitly somewhere in the global → entity precedence chain —
 * `validateArrayMutationRelations` (`resolve-entity-config.ts`) rejects an
 * unset `strategy` the same way it already rejects `arrayMutation: false`
 * under a write-opted relation.
 */
export interface ArrayMutationSettings {
  readonly strategy?: ArrayMutationStrategy;
}

/**
 * The default-deny switch for the `policy` stage (ADR-0035). `policy`
 * itself (`GlobalConfig.policy`/`EntityConfig.policy`/`OperationConfig.policy`,
 * ADR-0037) is a structural field at every scope it is configured on, never
 * a `KavoSettings` one — a function type is not something `DeepPartial`
 * can partialize without losing callability — so this stays a deliberately
 * separate, ordinary settings subtree even though `policy` has a global
 * default of its own. The two remain distinct mechanisms:
 * `authorization.required` only fills the gap where `policy`'s own fallback
 * chain (operation → entity → global) resolved to nothing at all, it never
 * overrides a resolved policy. `false` is not accepted here (unlike
 * `cache`/`realtime`/`softDelete`): there is nothing else in this subtree to
 * disable wholesale, so the plain object is always the shape.
 */
export interface AuthorizationSettings {
  /**
   * `true` denies a standard operation with no resolved `policy.<id>`
   * (`403 KAVO_FORBIDDEN`) instead of running it unrestricted. An operation
   * whose policy resolved from any scope is unaffected either way — this
   * only fills the gap where no rule resolved at all. Custom operations
   * never reach the policy stage at all (ADR-0032), so this cannot gate
   * them.
   */
  readonly required: boolean;
}

/** The full settings tree. */
export interface KavoSettings {
  readonly pagination: PaginationSettings;
  readonly errors: ErrorSettings;
  readonly relations: RelationSettings;
  /** Result caching + the conditional-request subtree (ADRs 0020/0031). */
  readonly cache: CacheSettings | false;
  readonly softDelete: SoftDeleteSettings | false;
  readonly realtime: RealtimeSettings | false;
  /**
   * `false` disables array-relation mutation entirely, the same convention
   * `softDelete`/`realtime` use. Even when set, a strategy only applies to
   * relations that opt in via `relations.edges.<name>.write: true`
   * (ADR-0014's Consequences section) — declaring a strategy here grants no
   * relation anything by itself.
   */
  readonly arrayMutation: ArrayMutationSettings | false;
  /** The `policy` default-deny switch (ADR-0035). Excluded from per-call override — see `KavoEngine.configViewFor`. */
  readonly authorization: AuthorizationSettings;
  /**
   * Global operation enablement, keyed by standard operation id — booleans
   * only, unlike the richer per-entity `EntityConfig.operations` (which also
   * carries `handler`/`meta` and is entity-typed). An id absent here defers
   * to the built-in default (and, for `restoreOne`, ADR-0013's soft-delete
   * auto-enable); an entity's own `operations.<id>` always wins over this.
   */
  readonly operations: Readonly<Partial<Record<StandardOperationId, boolean>>>;
}
