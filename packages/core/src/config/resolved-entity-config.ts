import type { KavoSettings } from "./settings.js";
import type { ComputedFieldMap } from "./computed-field.js";
import type { FieldPath } from "../types/field-path.js";
import type { IncludePath } from "../types/include-path.js";
import type { DtoResolver } from "../dto/dto.js";
import type { OperationId, StandardOperationId } from "../operations/operation.js";
import type { PolicyNode } from "../policy/kavo-policy.js";
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
   * sends no `fields=` and no `item`/`list` DTO is registered.
   *
   * `null` means "the entity-derived default" — every scalar column plus
   * every declared computed field. A non-null value is
   * {@link ResolvedQueryAllowlists.selectable}, and it is non-null exactly
   * when `allowlists.selectable` was configured explicitly (ADR-0026).
   *
   * The provenance is the whole point, and is why this is not simply read
   * off `allowlists.selectable`. Unconfigured, that list resolves to a base
   * set that is *almost* the derived projection but drops computed fields
   * declaring `selectable: false` — fields whose documented contract is to
   * stay in the projection while being unnameable in `fields=`. Narrowing
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
   * reads and writes it when `settings.cache.ttl` is positive (ADR-0031).
   */
  readonly cacheStore: CacheStore;
  /**
   * Resolved authorization, keyed by standard operation id (ADR-0032):
   * entity-scope `policy.<id>` with `operations.<id>.policy` merged in
   * where present, normalized from the array shorthand. An id absent here
   * runs unrestricted — the engine's policy stage looks up
   * `policy[operation]` and skips straight to the handler when it finds
   * nothing.
   */
  readonly policy: Readonly<Partial<Record<StandardOperationId, PolicyNode<Entity>>>>;
}
