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
 * this schema and a separate allowlist tree. Per-relation read tuning and
 * array-mutation write policy moved the same way (issue #404): they live on
 * `EntityConfig.relations` now, not here — this schema carried
 * `relations.edges` and `arrayMutation` until then. This schema carries
 * only the settings that are neither field- nor relation-shaped.
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
   * (`resolveEntityConfig`), the same treatment `delete.field` gets.
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
 * same convention `delete` uses. Otherwise the result cache is on
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
 * `EntityConfig`, `KavoSettings` carries no `Entity` type parameter, so
 * there is no layer here to check a field name against real entity paths.
 */
export type RealtimeFieldSelector = readonly string[] | { readonly exclude: readonly string[] };

/**
 * Realtime event publishing. `false` disables the subtree entirely, the
 * same convention `delete` uses; any object enables it — there is no
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
 * (`EntityConfig.relations`) and `dto`, not merged through this precedence
 * chain. See the `operations.
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
 * `EntityConfig.relations.<name>.write.strategy` values (ADR-0014's named
 * extension point for write-side relations beyond associate-by-id).
 * `"replace"` is a whole-array `PUT :id/<relation>` on the relation, still
 * id-only per ADR-0014, with partial mutation disabled (ADR-0029).
 * `"jsonPatch"` reuses `PATCH /entity/:id` (`patchOne`) instead: an array
 * body there is parsed as an RFC 6902 patch document — `add`/`replace` on
 * `/<field>` for a scalar column, `add`/`remove` on `/<relation>/-` for a
 * write-opted-in relation's membership — while an object body keeps
 * `patchOne`'s ordinary contract unchanged (ADR-0029's jsonPatch
 * amendment). `"resource"` synthesizes four per-relation sub-collection
 * operations instead of one — `GET`/`POST`/`DELETE`/`PUT` `:id/<relation>`,
 * adding `list`/`add`/`remove` single-member semantics alongside the same
 * whole-array `replace` `PUT` uses — for a relation opted into
 * `EntityConfig.relations.<name>.write` (ADR-0029's resource amendment).
 *
 * Since issue #404 there is no entity-level `arrayMutation` default: a
 * relation's `write` block names its strategy directly (`write: { strategy }`),
 * and omitting `write` is how a relation stays non-array-mutable — there is
 * nothing left to inherit, and nothing left to switch off wholesale.
 */
export type ArrayMutationStrategy = "replace" | "resource" | "jsonPatch";

/** The full settings tree. */
export interface KavoSettings {
  readonly pagination: PaginationSettings;
  readonly errors: ErrorSettings;
  /** Result caching + the conditional-request subtree (ADRs 0020/0031). */
  readonly cache: CacheSettings | false;
  readonly delete: SoftDeleteSettings | false;
  readonly realtime: RealtimeSettings | false;
  /**
   * Global operation enablement, keyed by standard operation id — booleans
   * only, unlike the richer per-entity `EntityConfig.operations` (which also
   * carries `handler`/`meta` and is entity-typed). An id absent here defers
   * to the built-in default (and, for `restoreOne`, ADR-0013's soft-delete
   * auto-enable); an entity's own `operations.<id>` always wins over this.
   */
  readonly operations: Readonly<Partial<Record<StandardOperationId, boolean>>>;
}
