import type { KavoSettings } from "./settings.js";
import type { FieldPath } from "../types/field-path.js";
import type { IncludePath } from "../types/include-path.js";
import type { DtoResolver } from "../dto/dto.js";
import type { OperationId, StandardOperationId } from "../operations/operation.js";
import type { Policy } from "../policy/kavo-policy.js";
import type { RelationRegistry } from "../relations/relation-registry.js";
import type { ResolvedSoftDelete } from "../persistence/soft-delete.js";
import type { RealtimeTransport } from "../realtime/realtime-transport.js";
import type { CacheStore } from "../caching/cache-store.js";

/**
 * Allowlists after bootstrap resolution — complete, never optional.
 *
 * `includable` resolves the opposite direction from the other three keys:
 * unconfigured, it is `[]` rather than "every relation" (ADR-0028) — see
 * `QueryAllowlists.includable`'s doc comment for why.
 */
export interface ResolvedQueryAllowlists<Entity = unknown> {
  readonly filterable: readonly FieldPath<Entity>[];
  readonly sortable: readonly FieldPath<Entity>[];
  readonly selectable: readonly FieldPath<Entity>[];
  readonly includable: readonly IncludePath<Entity, 1>[];
  readonly searchable: readonly FieldPath<Entity>[];
  readonly creatable: readonly FieldPath<Entity, 1>[];
  readonly updatable: readonly FieldPath<Entity, 1>[];
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
  readonly allowlists: ResolvedQueryAllowlists<Entity>;
  /**
   * The default response projection: what a read serves when the request
   * sends no `select=` and no `item`/`list` DTO is registered.
   *
   * `null` means "the entity-derived default" — every scalar column, own
   * derived fields excluded (ADR-0026, ADR-0046: a derived field is opt-in
   * to the projection via `allowlists.selectable`, the same as a relation).
   * A non-null value is {@link ResolvedQueryAllowlists.selectable}, and it
   * is non-null exactly when `allowlists.selectable` was configured
   * explicitly.
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
   * reads and writes it when `settings.cache.ttl` is positive (ADR-0031).
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
