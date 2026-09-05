import type { KavoSettings } from "./settings.js";
import type { SearchDriver, SearchMode } from "./entity-config.js";
import type { ComputedFieldMap } from "./computed-field.js";
import type { FieldPath } from "../types/field-path.js";
import type { IncludePath } from "../types/include-path.js";
import type { DtoResolver } from "../dto/dto.js";
import type { FilterOperator } from "../query/filter.js";
import type { Sort } from "../query/sort.js";
import type { OperationId, StandardOperationId } from "../operations/operation.js";
import type { Policy } from "../policy/kavo-policy.js";
import type { RelationRegistry } from "../relations/relation-registry.js";
import type { ResolvedSoftDelete } from "../persistence/soft-delete.js";
import type { RealtimeTransport } from "../realtime/realtime-transport.js";
import type { CacheStore } from "../caching/cache-store.js";

/** `EntityConfig.filter` after bootstrap resolution — complete, never optional (issue #386). */
export interface ResolvedFilterConfig<Entity = unknown> {
  readonly fields: readonly FieldPath<Entity>[];
  /** Per-field allowed operators (the map form), or `null` when every allowed field permits every operator. */
  readonly operators: ReadonlyMap<string, ReadonlySet<FilterOperator>> | null;
  readonly limits: {
    readonly maxDepth: number;
    readonly maxInValues: number;
    readonly maxLikePatternLength: number;
  };
}

/** `EntityConfig.sort` after bootstrap resolution — complete, never optional (issue #386). */
export interface ResolvedSortConfig<Entity = unknown> {
  readonly fields: readonly FieldPath<Entity>[];
}

/** `EntityConfig.select` after bootstrap resolution — complete, never optional (issue #386). */
export interface ResolvedSelectConfig<Entity = unknown> {
  readonly fields: readonly FieldPath<Entity>[];
  /** `select.default`, bootstrap-validated against `fields`. `undefined` when unconfigured. */
  readonly default?: readonly FieldPath<Entity, 1>[];
}

/** `EntityConfig.search` after bootstrap resolution, or `false` when search is disabled (issue #386). */
export interface ResolvedSearchConfig<Entity = unknown> {
  readonly fields: readonly FieldPath<Entity>[];
  readonly default: string | null;
  readonly mode: SearchMode;
  readonly driver: SearchDriver;
}

/**
 * `EntityConfig.include` after bootstrap resolution — complete, never
 * optional (issue #386).
 *
 * `fields` resolves the opposite direction from every other field-group:
 * unconfigured, it is `[]` rather than "every relation" (ADR-0028) — see
 * `IncludeConfig.fields`'s doc comment for why.
 */
export interface ResolvedIncludeConfig<Entity = unknown> {
  readonly fields: readonly IncludePath<Entity, 1>[];
  readonly limits: {
    readonly maxDepth: number;
    readonly maxNodes: number;
  };
}

/**
 * The frozen, fully-merged configuration for one entity — the product of
 * the precedence chain `built-in defaults → global → entity → operation`
 * (per-call overrides are parameters, not config writes).
 *
 * All merging happens once at bootstrap; the result is immutable. Invalid
 * config fails fast at bootstrap with an error naming the entity, the key
 * path, and the offending value.
 */
export interface ResolvedEntityConfig<Entity = unknown> {
  readonly entityName: string;
  /** Entity-scope settings (global already merged in). */
  readonly settings: KavoSettings;
  /** Per-operation settings view: entity settings + operation overrides. */
  settingsFor(operation: OperationId): KavoSettings;
  readonly filter: ResolvedFilterConfig<Entity>;
  readonly sort: ResolvedSortConfig<Entity>;
  /** `sort.default`, already parsed into the internal `Sort` shape (bootstrap-validated against `sort.fields`). */
  readonly sortDefault: readonly Sort<Entity>[];
  readonly select: ResolvedSelectConfig<Entity>;
  readonly search: ResolvedSearchConfig<Entity> | false;
  readonly include: ResolvedIncludeConfig<Entity>;
  /**
   * The default response projection: what a read serves when the request
   * sends no `select=` and no `item`/`list` DTO is registered.
   *
   * `null` means "the entity-derived default" — every scalar column plus
   * every declared computed field. A non-null value is
   * {@link ResolvedSelectConfig.fields}, and it is non-null exactly
   * when `select.fields` was configured explicitly (ADR-0026).
   *
   * The provenance is the whole point, and is why this is not simply read
   * off `select.fields`. Unconfigured, that list resolves to a base
   * set that is *almost* the derived projection but drops computed fields
   * declaring `selectable: false` — fields whose documented contract is to
   * stay in the projection while being unnameable in `select=`. Narrowing
   * by a list nobody wrote would silently retire that contract.
   */
  readonly projection: readonly FieldPath<Entity>[] | null;
  /**
   * The delete strategy resolved for this scope — `hard` with
   * a `null` field for everything that isn't soft-deletable, so adapters
   * branch on one object instead of re-deriving the decision.
   */
  readonly softDelete: ResolvedSoftDelete;
  /** Bootstrap-cached DTO resolution. */
  readonly dto: DtoResolver<Entity>;
  /**
   * Declared computed fields, validated at bootstrap — an empty record when
   * the entity declares none. Read by the serializer (to evaluate them) and
   * by the deserializer (to keep them out of writes), for this entity and,
   * through the catalog, for any relation target (ADR-0019).
   */
  readonly computed: ComputedFieldMap<Entity>;
  /** Relation edges of this entity. */
  readonly relations: RelationRegistry<Entity>;
  /**
   * Registered realtime transports — resolved once per `createKavo` root
   * (`KavoOptions.realtimeTransports`), not per entity and not through the
   * settings precedence chain: a transport is a live object, so only the
   * array container is frozen, never its elements (ADR-0023).
   */
  readonly realtimeTransports: readonly RealtimeTransport[];
  /**
   * The entity's result-cache store — resolved once per `createKavo` root
   * (`KavoOptions.cacheStore`, defaulting to `createMemoryCacheStore`), not
   * per entity and not through the settings precedence chain, for the same
   * ADR-0023 reason `realtimeTransports` documents: a store is a live
   * object (a Redis client, say) that must not be deep-frozen. The engine
   * reads and writes it when `settings.cache.ttl` is a positive number
   * (ADR-0031 as amended).
   */
  readonly cacheStore: CacheStore;
  /**
   * Resolved authorization, keyed by standard operation id (ADR-0037):
   * `operations.<id>.policy`, else `EntityConfig.policy`, else
   * `GlobalConfig.policy`, nearest scope wins, already collapsed to one
   * function per id. An id absent here runs unrestricted — the engine's
   * policy stage looks up `policy[operation]` and skips straight to the
   * handler when it finds nothing.
   */
  readonly policy: Readonly<Partial<Record<StandardOperationId, Policy<Entity>>>>;
}
