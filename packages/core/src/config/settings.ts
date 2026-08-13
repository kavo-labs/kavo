import type { RelationLoadStrategy } from "../relations/relation-descriptor.js";
import type { StandardOperationId } from "../operations/operation.js";
import type { Sort } from "../query/sort.js";
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
 */

/** Built-in pagination strategy names; open for custom strategies. */
export type PaginationStrategyName = "offset" | "page" | "cursor" | "since" | (string & {});

export interface PaginationSettings {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly strategy: PaginationStrategyName;
  /** Whether list responses compute `total` (the count query). */
  readonly count: boolean;
  /**
   * Only consulted under `strategy: "since"` (ADR-0022). The column
   * `?since=` seeks against and the effective sort's leading key —
   * `[since.field, idField]` ascending, forced regardless of client `sort`.
   * Must be a `date`- or `string`-kind column on the entity, and on the
   * `filterable`/`selectable` allowlists; a bootstrap error otherwise
   * (`resolveEntityConfig`), the same treatment `softDelete.field` gets.
   */
  readonly since: {
    readonly field: string;
  };
}

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

export interface SearchSettings {
  /** `search[query]` is rejected with a 400 unless this is `true`. */
  readonly enabled: boolean;
  /** `substring`: one `ILIKE '%term%'` per field. `words`: one per word, AND-ed. */
  readonly mode: SearchMode;
  readonly driver: SearchDriver;
}

export interface QuerySettings {
  /** Max nesting depth of the filter AST. */
  readonly maxFilterDepth: number;
  /** Max array length for `IN`/`NOT_IN`/`BETWEEN` values. */
  readonly maxInValues: number;
  /**
   * Order applied when a request supplies no `sort` — a client-supplied
   * `sort` always wins outright, never merges with this. Fields are
   * validated against the sortable allowlist at bootstrap, the same as
   * client-supplied sort fields are at request time.
   */
  readonly defaultSort: readonly Sort[];
  /** `search[query]` free-text search (doc 05 §4). */
  readonly search: SearchSettings;
}

export interface ErrorSettings {
  /** Leak driver-level error details into responses — off by default. */
  readonly exposeInternals: boolean;
}

/**
 * Per-relation *tuning* — the config half of a `RelationDescriptor` other
 * than permission. ORM metadata supplies shape (name, target,
 * cardinality); this supplies loading behavior once a relation is already
 * includable. Permission itself lives on `allowlists.includable`
 * (`EntityConfig`, entity-config.ts) instead, not here (ADR-0028) — naming
 * a relation in `edges` no longer opts it in.
 */
export interface RelationEdgeSettings {
  /** Included even when the client doesn't ask. */
  readonly defaultInclude?: boolean;
  /** Overrides `maxIncludeDepth` for the subtree below this node. */
  readonly maxDepth?: number;
  readonly strategy?: RelationLoadStrategy;
}

/** Relation inclusion limits and per-relation loading tuning. */
export interface RelationSettings {
  readonly maxIncludeDepth: number;
  readonly maxIncludedNodes: number;
  /**
   * Per-relation loading overrides, keyed by relation property name —
   * `defaultInclude`/`maxDepth`/`strategy` only. Whether a relation is
   * includable at all is `allowlists.includable`'s question, not this
   * one (ADR-0028); an entry here for a relation `allowlists.includable`
   * never named still validates and applies its tuning, but grants no
   * permission.
   */
  readonly edges: Readonly<Record<string, RelationEdgeSettings>>;
}

/**
 * HTTP response caching. One key covers both halves of the feature,
 * because they are two ends of the same value: the `ETag` computed for a
 * single-item response, and the `If-None-Match`/`If-Match` preconditions
 * evaluated against it (ADR-0020). `etag: false` at any scope turns both
 * off: no tag is computed, `If-None-Match` is ignored, and an `If-Match`
 * — the one header whose whole purpose is to prevent a write — is
 * **refused** with 412 `KAVO_PRECONDITION_UNSUPPORTED` rather than
 * ignored. Ignoring it would answer 2xx for a guard that was never
 * applied, which the per-operation scope makes easy to arrive at by
 * accident: `findOne` serving tags while `updateOne` has caching off is a
 * client holding a tag nothing will ever check.
 */
export interface CachingSettings {
  readonly etag: boolean;
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
 * same array-or-`exclude` shape `allowlists.selectable` uses
 * (`QueryFieldSelector`, entity-config.ts), but plain strings: unlike
 * `QueryAllowlists`, `KavoSettings` carries no `Entity` type parameter
 * (`relations.edges`'s keys are plain strings for the same reason), so
 * there is no layer here to check a field name against real entity paths.
 */
export type RealtimeFieldSelector = readonly string[] | { readonly exclude: readonly string[] };

/**
 * Realtime event publishing. `false` disables the subtree entirely, the
 * same convention `softDelete` uses.
 *
 * Registered transports are **not** a key here, unlike `enabled`/`events`/
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
  readonly enabled: boolean;
  /**
   * Per-event opt-out: an id absent here is emitted, like every other
   * positively-phrased boolean in this schema — enabling realtime means
   * "emit everything" by default, then dial specific events back with
   * `false`.
   */
  readonly events: Readonly<Partial<Record<RealtimeEventId, boolean>>>;
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

/** The full settings tree. */
export interface KavoSettings {
  readonly pagination: PaginationSettings;
  readonly query: QuerySettings;
  readonly errors: ErrorSettings;
  readonly relations: RelationSettings;
  readonly caching: CachingSettings;
  readonly softDelete: SoftDeleteSettings | false;
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
