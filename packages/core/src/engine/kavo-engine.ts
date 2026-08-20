import type { KavoContext } from "../context/kavo-context.js";
import type { KavoRequest } from "../context/kavo-request.js";
import type { KavoResponse } from "../context/kavo-response.js";
import type { DtoClass, DtoSlot } from "../dto/dto.js";
import type { ListMetaDto } from "../dto/list-result.js";
import type { Deserializer, Serializer } from "../serialization/serializer.js";
import type { EntityId } from "../types/entity-id.js";
import type { EntityMetadata, FieldMetadata } from "../metadata/entity-metadata.js";
import type { RepositoryAdapter } from "../persistence/repository-adapter.js";
import type { ErrorHandler } from "../errors/kavo-exception-shape.js";
import type { NormalizedQueryContext } from "../query/query-context.js";
import type { QueryContext } from "../query/query-context.js";
import type { Pagination, SincePagination } from "../query/pagination.js";
import type { OperationDescriptor, OperationRegistry } from "../operations/operation-registry.js";
import type { OperationId, StandardOperationId } from "../operations/operation.js";
import type { RequestPreconditions } from "../caching/etag.js";
import type { ResolvedEntityConfig } from "../config/resolved-entity-config.js";
import type { CacheSettings, KavoSettings } from "../config/settings.js";
import type { RealtimeEventDto, RealtimeEventId } from "../realtime/realtime-event.js";
import type { IncludeNode, IncludeTree } from "../relations/include-tree.js";
import {
  ArrayMutationInvalidShapeException,
  ConfigurationException,
  ForbiddenException,
  NotFoundException,
  OperationDisabledException,
  OperationNotRegisteredException,
  PreconditionFailedException,
  PreconditionUnsupportedException,
  QueryValidationException,
} from "../errors/exceptions.js";
import type { PolicyNode, WhenParams } from "../policy/kavo-policy.js";
import { evaluatePolicy, policyNeedsEntity } from "../policy/kavo-policy.js";
import { parseJsonPatchDocument } from "./json-patch.js";
import { nameList } from "../errors/message-hints.js";
import { dtoShapeKeys } from "../dto/dto-shape.js";
import { isStandardOperationId } from "../operations/default-operation-registry.js";
import { QueryNormalizer } from "../query/query-normalizer.js";
import { hasKeyset, isSincePagination } from "../query/pagination.js";
import { cursorValuesOf, encodeCursor } from "../query/cursor.js";
import { sinceValueOf } from "../query/since.js";
import { WILDCARD, canonicalize, computeEtag, isEtagEnabled, strongMatch, weakMatch } from "../caching/etag.js";
import { createKavoContext, randomUuid } from "../context/default-kavo-context.js";
import { mergeSettings } from "../config/merge-settings.js";
import { validateSettings } from "../config/validate-settings.js";
import { validateDefaultSort } from "../config/resolve-entity-config.js";
import { HARD_DELETE, resolveSoftDelete } from "../persistence/soft-delete.js";
import type { FindManyResult } from "./built-in-handlers.js";

/**
 * Marker wrapping *raw wire params* (`filter[age][gte]=18` as flat keys).
 * The framework layer (`@kavo/nest`) hands the engine one of these so the
 * full parse-and-coerce pipeline runs; programmatic callers pass a
 * typed `QueryContext` instead, which normalizes without coercion.
 */
export class WireQuery {
  constructor(readonly params: Readonly<Record<string, unknown>>) {}
}

export interface KavoEngineDependencies<Entity extends object> {
  readonly metadata: EntityMetadata<Entity>;
  readonly config: ResolvedEntityConfig<Entity>;
  readonly registry: OperationRegistry<Entity>;
  readonly serializer: Serializer<Entity>;
  readonly deserializer: Deserializer<Entity>;
  readonly normalizer: QueryNormalizer<Entity>;
  readonly errorHandler: ErrorHandler;
  /**
   * The entity's repository adapter. The engine uses it for two things.
   *
   * It puts it on every `KavoContext` it builds (ADR-0025), which is how a
   * handler reaches persistence — the only channel a config-supplied
   * handler has, since it was built before any adapter existed.
   *
   * And it reads through it for the one thing a handler cannot do:
   * evaluate an `If-Match` precondition, which needs both a read of the
   * current row *and* the serializer that turns it into the representation
   * the ETag was computed from (ADR-0020). Handlers have no serializer, so
   * the pre-read lives here rather than inside
   * `updateOne`/`patchOne`/`deleteOne`.
   */
  readonly repository: RepositoryAdapter<Entity>;
}

/**
 * The standard writes that target one identified row, which is exactly the
 * set whose `If-Match` the engine can evaluate: it re-reads that row and
 * hashes its canonical representation (ADR-0020 §4).
 *
 * `restoreOne`/`purgeOne` are in the set even though they act on a
 * *soft-deleted* row (ADR-0013): the pre-read asks for `withDeleted`, and
 * that flag changes only the filter, never the projection — so the tag it
 * produces is byte-identical to the one `GET /books/1?withDeleted=true`
 * served the client. Leaving them out is what let `DELETE /books/1/purge`
 * accept an `If-Match` and hard-delete anyway.
 *
 * Anything *not* in this set — `createOne`, and every custom operation,
 * whose target nothing in the schema describes — cannot be evaluated, and
 * is refused rather than performed unguarded
 * ({@link PreconditionUnsupportedException}). That is the same reason the
 * table is keyed by `StandardOperationId`.
 */
const PRECONDITION_TARGETS: ReadonlySet<StandardOperationId> = new Set<StandardOperationId>([
  "updateOne",
  "patchOne",
  "deleteOne",
  "restoreOne",
  "purgeOne",
]);

/**
 * Why an `If-Match` could not be evaluated — a closed set, rendered into
 * `KAVO_PRECONDITION_UNSUPPORTED`'s `{reason}` and written here rather
 * than anywhere a caller can reach.
 */
const UNEVALUABLE = {
  notTargeted: "the operation does not target one identified row, so there is no representation to compare against",
  cachingOff: "cache.etag is disabled for it, so no ETag is computed for this entity's representations",
  noCanonicalRead: "findOne is not an enabled operation, so this entity exposes no canonical representation to read",
} as const;

/**
 * Which DTO slot feeds each standard write operation's input. `Partial` is
 * deliberate — reads and the bodyless writes take no input DTO — but the
 * key is the union, so a misspelled id fails the build instead of quietly
 * adding an entry nothing will ever read.
 */
const INPUT_SLOTS: Readonly<Partial<Record<StandardOperationId, DtoSlot>>> = {
  createOne: "create",
  updateOne: "update",
  patchOne: "patch",
};

/**
 * Which realtime event a standard write operation's success maps to.
 * `deleteOne`/`purgeOne` share `"deleted"` — a subscriber only needs to
 * know the row is gone, not which delete strategy produced that. Absent
 * ids (every read, and any custom operation) never emit — the vocabulary
 * is closed to what `RealtimeEventId` names.
 */
const REALTIME_EVENT_BY_OPERATION: Readonly<Partial<Record<StandardOperationId, RealtimeEventId>>> = {
  createOne: "created",
  updateOne: "updated",
  patchOne: "patched",
  deleteOne: "deleted",
  purgeOne: "deleted",
  restoreOne: "restored",
};

/**
 * The request pipeline (Template Method over one lifecycle):
 *
 * operation resolution → config resolution → query resolution (reads) →
 * context assembly → policy (ADR-0032) → precondition evaluation (`If-Match`
 * writes) → DTO resolution → deserialization → handler execution → response
 * mapping → serialization → ETag / `If-None-Match`.
 *
 * Query resolution runs ahead of the spec's stage order (which lists it
 * after deserialization) because the context carries the normalized query
 * and deserialization needs the context — architecture doc 07 documents
 * this order as the authoritative one.
 *
 * Every stage boundary is a seam: handlers come from the registry (config
 * swaps them via `operations.<id>.handler`), and the serializer/deserializer,
 * pagination strategies, and include resolver are all constructor-injected
 * — `createCrud` supplies the defaults, callers may supply their own.
 */
export class KavoEngine<Entity extends object> {
  /**
   * `EntityMetadata.fields` by name — the lookup `cursorValuesOf`/
   * `sinceValueOf` need to check a page token's values against their
   * declared `FieldKind`. Built once here rather than per response; the
   * metadata is frozen at `createCrud`.
   */
  private readonly entityFields: ReadonlyMap<string, FieldMetadata>;

  /**
   * Own, non-generated column names — `arrayMutation`'s `jsonPatch`
   * strategy's legal `/<field>` path targets. Generated columns (the id
   * field among them, in every fixture and adapter this codebase ships)
   * are excluded the same way `DefaultDeserializer`'s writable projection
   * already excludes them from an ordinary object-body `patchOne`.
   */
  private readonly writableFieldNames: ReadonlySet<string>;

  constructor(private readonly deps: KavoEngineDependencies<Entity>) {
    this.entityFields = new Map(deps.metadata.fields.map((field) => [field.name, field]));
    this.writableFieldNames = new Set(
      deps.metadata.fields.filter((field) => !field.generated).map((field) => field.name),
    );
  }

  get registry(): OperationRegistry<Entity> {
    return this.deps.registry;
  }

  get config(): ResolvedEntityConfig<Entity> {
    return this.deps.config;
  }

  /**
   * The frozen entity metadata this engine was built from — a transport
   * (e.g. `@kavo/sse`'s filtered subscriptions, issue #160) needs it
   * alongside `config` to construct a `DefaultFilterParser` for the same
   * entity, without core exposing anything ORM- or transport-specific.
   */
  get metadata(): EntityMetadata<Entity> {
    return this.deps.metadata;
  }

  async execute(request: KavoRequest<Entity>): Promise<KavoResponse> {
    const { config, errorHandler } = this.deps;
    const correlationId = randomUuid();
    try {
      return await this.run(request, correlationId);
    } catch (error) {
      throw errorHandler.handle(error, {
        entityName: config.entityName,
        operation: request.operation,
        correlationId,
      });
    }
  }

  private async run(request: KavoRequest<Entity>, correlationId: string): Promise<KavoResponse> {
    const { registry, config } = this.deps;

    // Nothing is special-cased per verb — built-ins are ordinary registry
    // entries (ADR-0006).
    const descriptor = registry.get(request.operation);
    const errorContext = { entityName: config.entityName, operation: request.operation };
    // A registry miss and a disabled entry are different mistakes with
    // different fixes, so they get different codes (issue #7). Only the
    // disabled branch is reachable over HTTP: route generation walks this
    // same registry, so an unregistered id never gets a route.
    if (descriptor === undefined) {
      throw new OperationNotRegisteredException({
        messageParams: {
          operation: request.operation,
          entity: config.entityName,
          available: registeredIds(registry),
        },
        context: errorContext,
      });
    }
    if (!descriptor.enabled) {
      throw new OperationDisabledException({
        messageParams: {
          operation: request.operation,
          entity: config.entityName,
        },
        context: errorContext,
      });
    }

    // Per-call overrides are parameters, never writes to the frozen
    // resolved config.
    const configView = this.configViewFor(request);

    const query = descriptor.kind === "read" ? this.normalizeQuery(request, configView) : null;
    const context = createKavoContext<Entity>({
      operation: descriptor.id,
      config: configView,
      repository: this.deps.repository,
      principal: request.options?.principal,
      transaction: request.options?.transaction ?? null,
      query,
      correlationId,
    });

    // Before preconditions and the cache: a denied request should never
    // learn whether its `If-Match` would have succeeded, and a cache hit
    // must not skip authorization just because some earlier request for
    // the same principal already paid for it (ADR-0032).
    await this.checkPolicy(descriptor, request, configView, context);

    const preconditions = request.preconditions ?? request.options?.preconditions ?? null;
    // Before the handler, so a failed precondition never reaches the
    // adapter — the check is check-then-write, not compare-and-swap
    // (ADR-0020), and that is exactly why it must be as late as possible
    // and still ahead of the write.
    await this.checkIfMatch(request, descriptor, configView, preconditions, correlationId);

    // A cache hit serves the whole response without the adapter — but only
    // after preconditions, so a failed `If-Match` on a write never becomes
    // a stale cache read, and a read that sends `If-None-Match` still gets
    // its 304 answered against the *cached* representation's current ETag
    // (ADR-0031). Reads only; write responses are never cached.
    //
    // Computed once: neither `descriptor` nor `configView` changes for the
    // rest of `run`, so the cacheability check and the key itself are good
    // for both the read below and the store after the handler runs.
    const cacheKey =
      query !== null && this.isCacheableRead(descriptor, configView)
        ? this.cacheKey(descriptor.id, request.id, request.options?.principal, query)
        : null;
    if (cacheKey !== null) {
      const cached = await this.readCache(cacheKey, configView, preconditions);
      if (cached !== null) return cached;
    }

    const input = this.resolveInput(request, descriptor, context);

    const result = await descriptor.handler.execute(input, context);
    if (descriptor.id === "findOne") await this.checkFindOnePolicy(request, configView, context, result as Entity);

    // The one write-driven thing the cache needs, and the whole
    // invalidation strategy: every entry for the entity is dropped after a
    // successful write, because nothing about the write's payload tells the
    // engine which cached queries it could have changed (ADR-0031).
    if (descriptor.kind === "write") await this.invalidateCache(configView);

    const response = await this.mapResponse(descriptor, result, context, preconditions);
    if (cacheKey !== null) {
      await this.storeCache(cacheKey, configView, response);
    }
    await this.emitRealtimeEvent(descriptor, request, input, result, response, context);
    return response;
  }

  /**
   * The policy stage (ADR-0032): looks up `configView.policy[operation]`
   * and, when the entity configured one, evaluates it before anything else
   * runs. An id with no entry is unrestricted — this is a no-op for every
   * entity that never configured `policy`.
   *
   * `owner`/`when` nodes need the loaded row, which no built-in handler
   * fetches ahead of a write (`updateOne`/`patchOne`/`deleteOne`/
   * `restoreOne`/`purgeOne` mutate by id alone). `policyNeedsEntity` decides
   * once, from the node shape, whether this stage must pay for that extra
   * read — a context-only policy (`permission`/`role`/`authenticated`)
   * costs nothing beyond the lookup and the boolean evaluation. The
   * pre-fetch asks for soft-deleted rows too (`withDeleted: true`) —
   * `restoreOne`/`purgeOne` target a row that *is* soft-deleted by
   * definition, and a `withDeleted: false` fetch would never find it.
   *
   * `findOne` is the one operation that already loads the row as its own
   * result. A **context-only** policy on `findOne` is still evaluated right
   * here, before the cache read below it in `run` — the same as every other
   * operation, and cheap, since it needs no fetch. An **entity-aware**
   * policy on `findOne` is deferred to `checkFindOnePolicy`, evaluated
   * against the row the handler already fetched rather than fetched twice;
   * `isCacheableRead` refuses to cache that case, so a stale cache entry can
   * never stand in for the deferred check. Every other single-row operation
   * fetches here, and `resolveEntityConfig` already rejects an entity-aware
   * node on `createOne`/`findMany`, so `entity` is never needed for those.
   */
  private async checkPolicy(
    descriptor: OperationDescriptor<Entity>,
    request: KavoRequest<Entity>,
    configView: ResolvedEntityConfig<Entity>,
    context: KavoContext<Entity>,
  ): Promise<void> {
    const node = isStandardOperationId(descriptor.id) ? configView.policy[descriptor.id] : undefined;
    if (node === undefined) return;
    if (descriptor.id === "findOne" && policyNeedsEntity(node)) return; // deferred to checkFindOnePolicy

    // Coerced against the id column's kind, same as every other consumer of
    // `request.id` below — a `when()` predicate comparing `params.id` to a
    // numeric constant must see a number, not the raw URL-path string.
    const id = request.id === null ? null : (this.coerceId(request.id) as EntityId);
    const params: WhenParams<Entity> = { id };

    if (descriptor.id === "findOne") {
      await this.assertPolicyAllows(node, descriptor.id, configView, context, undefined, params);
      return;
    }

    let entity: Entity | undefined;
    if (policyNeedsEntity(node)) {
      const found = id === null ? null : await context.repository.findOneById(id, this.policyPrefetchQuery(), context);
      if (found === null) {
        throw new NotFoundException({
          messageParams: { entity: configView.entityName, id: String(request.id) },
          context: {
            entityName: configView.entityName,
            operation: descriptor.id,
            correlationId: context.correlationId,
          },
        });
      }
      entity = found;
    }

    await this.assertPolicyAllows(node, descriptor.id, configView, context, entity, params);
  }

  /** `findOne`'s deferred half of the policy stage — only reached for an entity-aware node; see `checkPolicy`'s doc comment. */
  private async checkFindOnePolicy(
    request: KavoRequest<Entity>,
    configView: ResolvedEntityConfig<Entity>,
    context: KavoContext<Entity>,
    entity: Entity,
  ): Promise<void> {
    const node = configView.policy.findOne;
    if (node === undefined || !policyNeedsEntity(node)) return;
    const id = request.id === null ? null : (this.coerceId(request.id) as EntityId);
    await this.assertPolicyAllows(node, "findOne", configView, context, entity, { id });
  }

  private async assertPolicyAllows(
    node: PolicyNode<Entity>,
    operation: OperationId,
    configView: ResolvedEntityConfig<Entity>,
    context: KavoContext<Entity>,
    entity: Entity | undefined,
    params: WhenParams<Entity>,
  ): Promise<void> {
    const allowed = await evaluatePolicy(node, context, entity, params);
    if (!allowed) {
      throw new ForbiddenException({
        messageParams: { entity: configView.entityName, operation },
        context: { entityName: configView.entityName, operation, correlationId: context.correlationId },
      });
    }
  }

  /**
   * The minimal, valid `NormalizedQueryContext` `checkPolicy`'s pre-fetch
   * hands the adapter — `withDeleted: true`, no includes, no filter/sort.
   * `withDeleted: true` is load-bearing: `restoreOne`/`purgeOne` target a
   * row that is soft-deleted by definition, and `resolveEntityConfig`'s
   * `owner`-field validation (ADR-0032) already rejects a dotted path that
   * crosses a relation, so no `include` is ever needed here either.
   */
  private policyPrefetchQuery(): NormalizedQueryContext<Entity> {
    return {
      filter: { root: null },
      sort: [],
      pagination: { limit: 1, offset: 0 },
      fields: { root: null, relations: {} },
      include: {},
      withDeleted: true,
      onlyDeleted: false,
      count: false,
    };
  }

  /**
   * Publish a `RealtimeEventDto` for a write that just succeeded, to every
   * transport `context.config.realtimeTransports` registers — the engine-level hook
   * (never a per-handler opt-in like `withListMeta`, since this must fire
   * for every write on an entity that configured realtime, not only ones a
   * caller remembered to wrap).
   *
   * Every check before the transport loop is ordered cheapest-first and
   * returns immediately, so an entity with realtime off (the default) or a
   * write that only maps to `undefined` (every read, any custom operation)
   * pays for nothing beyond one map lookup and a couple of property reads
   * — no `RealtimeEventDto` is even constructed.
   */
  private async emitRealtimeEvent(
    descriptor: OperationDescriptor<Entity>,
    request: KavoRequest<Entity>,
    input: unknown,
    result: unknown,
    response: KavoResponse,
    context: KavoContext<Entity>,
  ): Promise<void> {
    const eventId = REALTIME_EVENT_BY_OPERATION[descriptor.id as StandardOperationId];
    if (eventId === undefined) return;

    const realtime = context.config.settings.realtime;
    if (realtime === false || !realtime.enabled) return;
    const transports = context.config.realtimeTransports;
    if (transports.length === 0) return;
    if (realtime.events[eventId] === false) return;

    const id = this.realtimeEntityId(descriptor.id as StandardOperationId, request, result);
    if (id === undefined) return;

    const event: RealtimeEventDto = {
      event: eventId,
      entity: context.entityName,
      id,
      channel: `${context.entityName}.${id}`,
      occurredAt: new Date().toISOString(),
      item: response.item,
      ...(eventId === "updated" || eventId === "patched" ? { changed: this.changedFields(input) } : {}),
    };

    await Promise.all(
      transports.map(async (transport) => {
        try {
          await transport.publish(event);
        } catch (error) {
          // A transport's own delivery failure never fails a mutation that
          // already succeeded — a subscriber not hearing about the write
          // is a delivery problem, not a data problem. Core has no ambient
          // logger to fall back on (ADR-0005), so the failure is only
          // observable through the caller-supplied hook, if any — and that
          // hook itself is wrapped too: a throwing `onPublishError` must
          // not turn back into the very "mutation fails" outcome it exists
          // to report instead of.
          try {
            realtime.onPublishError?.(error, transport, event);
          } catch {
            // Nothing to do with a failure to report a failure — swallowed
            // for the same reason the publish rejection above is.
          }
        }
      }),
    );
  }

  /**
   * Whether this call's settings cache reads at all — `cache` resolved for
   * the call's config view, and the operation one of the two standard reads
   * the cache serves. Custom-operation reads are deliberately not cached
   * (ADR-0031); the operation-id check keeps that true even for one whose
   * handler would be cheap to cache.
   *
   * An entity-aware `findOne` policy (ADR-0032) refuses to cache at all: a
   * cache hit answers straight out of `readCache`, before `checkFindOnePolicy`
   * ever runs (see `run`), so caching that response would let a stale
   * verdict outlive the request it was computed for. A context-only
   * `findOne` policy needs no such carve-out — it is evaluated in
   * `checkPolicy`, ahead of the cache read, on every call regardless of hit
   * or miss.
   */
  private isCacheableRead(descriptor: OperationDescriptor<Entity>, config: ResolvedEntityConfig<Entity>): boolean {
    if (descriptor.id !== "findOne" && descriptor.id !== "findMany") return false;
    if (descriptor.id === "findOne") {
      const node = config.policy.findOne;
      if (node !== undefined && policyNeedsEntity(node)) return false;
    }
    return this.cacheSettings(config) !== null;
  }

  /** The `cache` settings in force for a config view, or `null` when off. */
  private cacheSettings(config: ResolvedEntityConfig<Entity>): CacheSettings | null {
    const cache = config.settings.cache;
    return cache === false || cache.ttl <= 0 ? null : cache;
  }

  /**
   * The cache lookup half of a read, keyed by `cacheKey`'s result. A hit
   * returns the full response; a miss returns `null` and the caller runs
   * the pipeline. Everything the store can throw — or fail to serve
   * correctly — falls back to that same `null`, so a broken cache backend
   * costs a read its hit, never the read itself (ADR-0031: cache failures
   * degrade, never fail).
   */
  private async readCache(
    key: string,
    config: ResolvedEntityConfig<Entity>,
    preconditions: RequestPreconditions | null,
  ): Promise<KavoResponse | null> {
    try {
      const cached = await config.cacheStore.get(config.entityName, key);
      if (cached === null) return null;
      return await this.responseFromCache(cached, config, preconditions);
    } catch {
      return null;
    }
  }

  /**
   * The response a hit serves. The envelope is fresh — `etag` and
   * `notModified` are re-derived for *this* request, never trusted from
   * storage, because they are per-request answers to the request's own
   * `If-None-Match` (ADR-0020), and a hit has to serve a correct, current
   * `ETag` even when the entry predates the current call's `cache.etag`
   * scope (ADR-0031) — the tag is recomputed off the cached `item`, which
   * is the same representation `mapResponse` would have hashed.
   *
   * The payload is cloned, not shared: an entry is shared storage, so one
   * caller mutating a returned item must not corrupt what every later
   * caller reads. The serialized payload is plain DTO data (possibly with
   * `Date` values, which `structuredClone` preserves), so nothing is lost
   * and no prototype needs keeping.
   */
  private async responseFromCache(
    cached: KavoResponse,
    config: ResolvedEntityConfig<Entity>,
    preconditions: RequestPreconditions | null,
  ): Promise<KavoResponse> {
    const etag =
      isEtagEnabled(config.settings.cache) && cached.item !== null && cached.item !== undefined
        ? await computeEtag(cached.item)
        : null;
    return {
      ...cloneResponsePayload(cached),
      etag,
      notModified: etag !== null && weakMatch(preconditions?.ifNoneMatch ?? [], etag),
    };
  }

  /** The store half of a read, keyed by `cacheKey`'s result: the response the pipeline just produced. */
  private async storeCache(key: string, config: ResolvedEntityConfig<Entity>, response: KavoResponse): Promise<void> {
    const settings = this.cacheSettings(config);
    if (settings === null) return;
    try {
      await config.cacheStore.set(
        config.entityName,
        key,
        // Clone before storing: `response` is the very object `run` hands
        // the originating caller, and one caller mutating a returned item
        // must not corrupt what every later caller reads. The hit path
        // clones again on the way out (`responseFromCache`), which guards
        // the reverse direction — a store that returns a shared reference.
        cloneResponsePayload(response),
        settings.ttl,
      );
    } catch {
      // A store that refuses to hold a value never fails the read that
      // produced it — a cache write is a fire-and-forget optimization.
    }
  }

  /**
   * The write half: drop every entry for the entity. Called after any
   * successful write — standard or custom — because a write that changed
   * the row can invalidate an unknown subset of the entity's cached
   * queries, and erring on the safe side is the only correct answer
   * (ADR-0031). A store that fails to evict never fails the write that
   * asked for it.
   */
  private async invalidateCache(config: ResolvedEntityConfig<Entity>): Promise<void> {
    try {
      await config.cacheStore.invalidate(config.entityName);
    } catch {
      // Nothing to do with a store that cannot evict; the write already
      // succeeded.
    }
  }

  /**
   * The cache key for one read: `operation:id:principal:query`, where the
   * id half names the row a `findOne` targets — `request.id` lives outside
   * the normalized query, so it has to be in the key or `findOne(1)` and
   * `findOne(2)` would share one entry (ADR-0031). The principal half keeps
   * one caller's values from leaking to another: computed fields and custom
   * handlers may legitimately vary by `context.principal`, so a response
   * baked for one principal must never be served to a different one —
   * `undefined` and `null` both canonicalize to `"null"`, so anonymous
   * calls share one bucket (ADR-0031). The query half is a canonicalized
   * plain-data fingerprint of the normalized query. The entity name is a
   * separate parameter the store keys on, so invalidation stays a
   * whole-entity map delete. `canonicalize` is what makes the key
   * deterministic — a key built from raw objects would depend on insertion
   * order.
   */
  private cacheKey(
    operationId: OperationId,
    requestId: unknown,
    principal: unknown,
    query: NormalizedQueryContext<Entity>,
  ): string {
    const id = requestId === null || requestId === undefined ? "" : String(requestId);
    return `${operationId}:${id}:${canonicalize(principal)}:${canonicalize(queryFingerprint(query))}`;
  }

  /**
   * `createOne` has no request id — its id comes off the created row via
   * the entity's own id field. Every other write op targets an id the
   * request already carries, already coerced to the id column's kind by
   * `resolveInput`'s earlier call.
   */
  private realtimeEntityId(
    operationId: StandardOperationId,
    request: KavoRequest<Entity>,
    result: unknown,
  ): string | number | undefined {
    if (operationId === "createOne") {
      const value = (result as Record<string, unknown> | null)?.[this.deps.metadata.idField];
      return typeof value === "string" || typeof value === "number" ? value : undefined;
    }
    const id = this.coerceId(request.id);
    return typeof id === "string" || typeof id === "number" ? id : undefined;
  }

  /**
   * `"updated"`/`"patched"` only: the field names present in the write
   * payload — see `RealtimeEventDto.changed`'s doc for why this is not a
   * diff against the row's previous value.
   */
  private changedFields(input: unknown): readonly string[] {
    const data = (input as { data?: unknown } | null)?.data;
    if (typeof data !== "object" || data === null) return [];
    return Object.keys(data);
  }

  /**
   * `If-Match`: reject the write when the target's current ETag is not one
   * the client named.
   *
   * Three outcomes, and the third is the one worth naming. **Evaluated**
   * for the standard single-row writes: the row is re-read and its
   * canonical tag compared. **Ignored** for reads — `If-Match` is a
   * lost-update guard, a safe method cannot lose an update, and
   * `If-None-Match` is the read-side conditional (ADR-0020 §4).
   * **Refused** for everything else: an unevaluable precondition on a
   * request that changes state is answered with
   * `PreconditionUnsupportedException` rather than a silent `return`,
   * because a client that asked for a guard and did not get one must find
   * out from the response rather than from a lost update.
   *
   * A target with no current representation at all is *not* decided here:
   * the check falls through and the handler raises its own error, so
   * `DELETE` on a soft-deleted row is the same 409 with or without an
   * `If-Match` header. The identity of an error must not depend on whether
   * a cache header was sent.
   */
  private async checkIfMatch(
    request: KavoRequest<Entity>,
    descriptor: OperationDescriptor<Entity>,
    config: ResolvedEntityConfig<Entity>,
    preconditions: RequestPreconditions | null,
    correlationId: string,
  ): Promise<void> {
    const ifMatch = preconditions?.ifMatch;
    if (ifMatch === undefined) return;
    if (descriptor.kind === "read") return;

    const refuse = (reason: string): never => {
      throw new PreconditionUnsupportedException({
        messageParams: { entity: config.entityName, operation: descriptor.id, reason },
        context: { entityName: config.entityName, operation: descriptor.id, correlationId },
      });
    };
    if (!PRECONDITION_TARGETS.has(descriptor.id as StandardOperationId)) refuse(UNEVALUABLE.notTargeted);
    if (!isEtagEnabled(config.settings.cache)) refuse(UNEVALUABLE.cachingOff);
    // The 412 below names the current tag, which is only safe to disclose
    // when the client could have read it for itself. No enabled `findOne`
    // means no canonical representation to read — and an unconditional
    // hash in an error message would be an offline oracle over a
    // low-entropy row.
    if (this.deps.registry.get("findOne")?.enabled !== true) refuse(UNEVALUABLE.noCanonicalRead);

    // `*` is "only if it exists", which the pre-read cannot make more or
    // less true — `strongMatch` returns on the wildcard without looking at
    // the tag. Short-circuiting here spares a read, a serialization and a
    // SHA-256 whose answer was a constant, and a target that turns out not
    // to exist still raises from the handler.
    if (ifMatch.includes(WILDCARD)) return;

    const id = this.coerceId(request.id) as EntityId;
    const etag = await this.canonicalEtag(id, request, config, correlationId);
    // No current representation: the row is gone, or an adapter would
    // refuse this write for a reason of its own. Either way the handler
    // owns the answer.
    if (etag === null) return;
    if (strongMatch(ifMatch, etag)) return;
    throw new PreconditionFailedException({
      messageParams: { entity: config.entityName, id: String(id), etag },
      context: { entityName: config.entityName, operation: descriptor.id, correlationId },
    });
  }

  /**
   * The ETag of the target row's **canonical read representation** — what
   * `findOne` on that id with no `fields`/`include`/`sort` params would
   * return. That is the representation a client's `If-Match` token came
   * from, so it is the one the token is compared against; an ETag taken
   * from a field-narrowed read identifies a different representation and
   * will not match (ADR-0020).
   *
   * The pre-read asks for `withDeleted`, which is what makes the check
   * work for `restoreOne`/`purgeOne`: it widens the *filter* and never
   * touches the projection, so a live row hashes exactly as
   * `GET /books/1` would and a soft-deleted one exactly as
   * `GET /books/1?withDeleted=true` would. `null` means the row is not
   * there under any view — the caller lets the handler decide what that
   * is, rather than turning every such case into a 404.
   */
  private async canonicalEtag(
    id: EntityId,
    request: KavoRequest<Entity>,
    config: ResolvedEntityConfig<Entity>,
    correlationId: string,
  ): Promise<string | null> {
    const { repository, serializer, normalizer, registry } = this.deps;
    // `withDeleted` is only a legal query param on a soft-deletable entity
    // — the normalizer rejects it outright otherwise (a client that thinks
    // it is seeing deleted rows should be told it is not), and on a
    // hard-delete entity there is nothing for it to widen anyway.
    const softDeletable = config.softDelete.strategy === "soft";
    const query = normalizer.normalizeInput(softDeletable ? { withDeleted: true } : undefined, config);
    const context = createKavoContext<Entity>({
      operation: "findOne",
      config,
      repository,
      principal: request.options?.principal,
      transaction: request.options?.transaction ?? null,
      query,
      correlationId,
    });
    const entity = await repository.findOneById(id, query, context);
    if (entity === null) return null;
    // Same fallback `mapResponse` uses for a served `findOne` response
    // (descriptor override first): "what `findOne` on that id ... would
    // return" (ADR-0020) means the representation `findOne`'s own
    // registry entry actually serves, not the entity's root `item` slot.
    const itemDto =
      (registry.get("findOne")?.output as DtoClass<object> | null) ??
      (config.dto.resolve("item", "findOne") as DtoClass<object> | null);
    return computeEtag(serializer.serializeItem(entity, itemDto, context));
  }

  private configViewFor(request: KavoRequest<Entity>): ResolvedEntityConfig<Entity> {
    const { config } = this.deps;
    const base = config.settingsFor(request.operation);
    const overrides = request.options?.settings;
    let settings: KavoSettings = base;
    if (overrides !== undefined) {
      settings = mergeSettings(base, overrides);
      const scope = `${config.entityName} (per-call)`;
      validateSettings(scope, settings);
      validateDefaultSort(scope, settings, config.allowlists);
    }
    if (settings === config.settings) return config;
    return {
      entityName: config.entityName,
      settings,
      settingsFor: () => settings,
      allowlists: config.allowlists,
      // Structural, like `computed` below: the projection is derived from
      // `allowlists.selectable` at bootstrap (ADR-0026), and allowlists are
      // outside the settings precedence chain, so a per-call override
      // cannot widen what a response serves.
      projection: config.projection,
      // A narrowed scope may change the delete strategy (an operation that
      // forces `hard` on a soft-deletable entity, say), so it is resolved
      // against the settings actually in force for this call.
      softDelete: resolveSoftDelete(this.deps.metadata, settings, `${config.entityName} (${request.operation})`),
      dto: config.dto,
      // Structural entity config, outside the settings precedence chain
      // entirely (ADR-0019) — a per-call settings override cannot reach it.
      computed: config.computed,
      relations: config.relations,
      // Same reasoning: transports are resolved once per `createKavo` root,
      // not per call.
      realtimeTransports: config.realtimeTransports,
      // Same reasoning, applied to the cache store (ADR-0031): a store is a
      // live object registered once per root, never per call.
      cacheStore: config.cacheStore,
      // Structural, like `computed`/`relations` above (ADR-0032): resolved
      // once at bootstrap, outside the settings precedence chain, so a
      // per-call override cannot loosen what an entity's `policy` demands.
      policy: config.policy,
    };
  }

  private normalizeQuery(
    request: KavoRequest<Entity>,
    config: ResolvedEntityConfig<Entity>,
  ): NormalizedQueryContext<Entity> {
    const { normalizer } = this.deps;
    const query = request.query;
    if (query instanceof WireQuery) {
      return normalizer.normalizeWire(query.params, config);
    }
    return normalizer.normalizeInput((query as QueryContext<Entity> | null) ?? undefined, config);
  }

  private resolveInput(
    request: KavoRequest<Entity>,
    descriptor: OperationDescriptor<Entity>,
    context: KavoContext<Entity>,
  ): unknown {
    const { deserializer, config } = this.deps;
    // A custom id is simply absent from the table; the cast narrows for the
    // lookup and `noUncheckedIndexedAccess` keeps the miss visible.
    const slot = INPUT_SLOTS[descriptor.id as StandardOperationId];
    const dto = descriptor.input ?? (slot !== undefined ? config.dto.resolve(slot, descriptor.id) : null);

    switch (descriptor.id) {
      case "findOne":
      case "deleteOne":
      case "restoreOne":
      case "purgeOne":
        return this.coerceId(request.id);
      case "findMany":
        return null;
      case "updateOne":
        return {
          id: this.coerceId(request.id),
          data: deserializer.deserialize(request.body, dto, context),
        };
      case "patchOne":
        return this.resolvePatchOneInput(request, dto, context);
      default: {
        // A custom read (issue #145) follows the same rule the two standard
        // reads above do: no request body exists to deserialize, so the
        // input is the target id when the route names one and nothing
        // otherwise — everything else a read is given rides on
        // `context.query`.
        if (descriptor.kind === "read") return request.id === null ? null : this.coerceId(request.id);
        // A `replace`/`add`/`remove<Relation>` operation Kavo itself
        // synthesized (`registerArrayMutationOperations`) takes the
        // array-mutation path instead of the ordinary DTO deserializer:
        // `replace`'s body is a bare array (or `null`, ADR-0014); `add`/
        // `remove`'s (the `resource` strategy's single-member actions,
        // ADR-0029's resource amendment) is a single scalar id or `{id}`
        // reference — never an entity-shaped object either way. `list`
        // (also `resource`) never reaches here: it is `kind: "read"`, so
        // the branch above already returned the coerced id alone.
        const arrayMutation = descriptor.meta.arrayMutation;
        if (arrayMutation !== undefined) {
          if (arrayMutation.action === "add" || arrayMutation.action === "remove") {
            return {
              id: this.coerceId(request.id),
              relation: arrayMutation.relation,
              memberId: this.resolveArrayMutationMemberId(arrayMutation.relation, request.body, context),
            };
          }
          return {
            id: this.coerceId(request.id),
            relation: arrayMutation.relation,
            memberIds: this.resolveArrayMutationMemberIds(arrayMutation.relation, request.body, context),
          };
        }
        // createOne, and every custom write: the deserialized body, plus
        // the request id when one is present. createOne never carries an
        // id, so this falls through to the body alone there.
        const body = deserializer.deserialize(request.body, dto, context);
        return request.id === null ? body : { id: this.coerceId(request.id), body };
      }
    }
  }

  /**
   * `patchOne`'s input. An object body deserializes exactly as it always
   * has — `patchOne`'s own contract is unchanged, `arrayMutation` strategy
   * or not, which is the overlap ADR-0029's jsonPatch amendment resolves
   * explicitly rather than silently: `DefaultDeserializer.deserialize`
   * already returns `{}` for a non-object/array body, so an array reaching
   * an entity that never opted into `jsonPatch` — at the entity level or on
   * any of its relations (ADR-0029's per-relation amendment, issue #223) —
   * sees that same unchanged behavior. Only when jsonPatch parsing is
   * actually opted into *and* the body is a bare array — the one shape an
   * ordinary patch DTO body never is — does it parse as an RFC 6902
   * document instead.
   */
  private resolvePatchOneInput(
    request: KavoRequest<Entity>,
    dto: DtoClass<object> | null,
    context: KavoContext<Entity>,
  ): unknown {
    const { deserializer } = this.deps;
    const id = this.coerceId(request.id);
    // Cheapest check first: the overwhelmingly common object-body case
    // short-circuits here without ever touching `context.config.relations`
    // (`.all()` allocates a fresh array per call) — the relation scan below
    // only runs for the rare array-body request.
    if (!Array.isArray(request.body)) {
      return { id, data: deserializer.deserialize(request.body, dto, context) };
    }
    const arrayMutation = context.config.settings.arrayMutation;
    // Per-relation strategies (ADR-0029's per-relation amendment, issue
    // #223) mean "does this entity accept a jsonPatch document?" is no
    // longer answered by the entity-level default alone: an entity whose
    // own `arrayMutation.strategy` is something else (or unset) still opts
    // into jsonPatch parsing the moment *any* of its relations resolves to
    // `"jsonPatch"`. Opting even one relation in this way changes
    // `patchOne`'s body contract for the whole entity — an array body is now
    // parsed as RFC 6902 for every writable field, not just that relation.
    const jsonPatchRelations = context.config.relations.all().filter((relation) => relation.write === "jsonPatch");
    const entityDefaultIsJsonPatch = arrayMutation !== false && arrayMutation.strategy === "jsonPatch";
    if (!entityDefaultIsJsonPatch && jsonPatchRelations.length === 0) {
      return { id, data: deserializer.deserialize(request.body, dto, context) };
    }

    const writeOptedRelations = new Set(jsonPatchRelations.map((relation) => relation.name));
    const parsed = parseJsonPatchDocument(request.body, {
      entityName: context.entityName,
      writableFields: this.writableFieldNames,
      writeOptedRelations,
      operation: context.operation,
      correlationId: context.correlationId,
    });
    const data = deserializer.deserialize(parsed.fields, dto, context);
    const relationEntries = Object.entries(parsed.relations);
    if (relationEntries.length === 0) return { id, data };

    const relationPatch: Record<string, { add: readonly EntityId[]; remove: readonly EntityId[] }> = {};
    for (const [relation, ops] of relationEntries) {
      relationPatch[relation] = {
        add: this.resolveJsonPatchMemberIds(relation, ops.add, context),
        remove: this.resolveJsonPatchMemberIds(relation, ops.remove, context),
      };
    }
    return { id, data, relationPatch };
  }

  /**
   * Normalizes a list of raw `jsonPatch` op `value`s (a scalar id or an
   * `{id}` reference) into real ids — the same `DefaultDeserializer`
   * `associate()` logic `resolveArrayMutationMemberIds` reuses for
   * `replace`, wrapping the values as `{ [relation]: values }` and reading
   * the one key back out, so a scalar id, an `{id}` reference, and the
   * target entity's real id-field name resolve exactly the way
   * `create`/`update`/`replace` already resolve them.
   */
  private resolveJsonPatchMemberIds(
    relation: string,
    values: readonly unknown[],
    context: KavoContext<Entity>,
  ): readonly EntityId[] {
    if (values.length === 0) return [];
    const wrapped = this.deps.deserializer.deserialize<Record<string, unknown>>({ [relation]: values }, null, context);
    const refs = (wrapped[relation] ?? []) as readonly Record<string, unknown>[];
    return refs.map((ref) => Object.values(ref)[0] as EntityId);
  }

  /**
   * A `replace`-strategy array-mutation body: an array of ids/`{id}`
   * references, or `null` (ADR-0014, still id-only — `replace` disables
   * partial mutation, so this is the only shape it accepts). Delegates the
   * actual id extraction to the deserializer's existing relation-association
   * logic — wrapping the raw body as `{ [relation]: body }` and reading the
   * one key back out — rather than duplicating `DefaultDeserializer`'s
   * `associate()` here, so a scalar id, an `{id}` reference, and the target
   * entity's real id-field name are resolved exactly the way `create`/
   * `update` already resolve them.
   */
  private resolveArrayMutationMemberIds(
    relation: string,
    body: unknown,
    context: KavoContext<Entity>,
  ): readonly EntityId[] | null {
    if (body !== null && !Array.isArray(body)) {
      throw new ArrayMutationInvalidShapeException({
        messageParams: {
          entity: context.entityName,
          relation,
          expected: "an array of ids or id references, or null — 'replace' disables partial mutation",
        },
        context: { entityName: context.entityName, operation: context.operation, correlationId: context.correlationId },
      });
    }
    const wrapped = this.deps.deserializer.deserialize<Record<string, unknown>>({ [relation]: body }, null, context);
    const refs = wrapped[relation];
    if (refs === null || refs === undefined) return null;
    return (refs as readonly Record<string, unknown>[]).map((ref) => Object.values(ref)[0] as EntityId);
  }

  /**
   * A `resource`-strategy `add`/`remove` body (`POST`/`DELETE
   * /entity/:id/relation`, ADR-0029's resource amendment): a single scalar
   * id or `{id}` reference naming the one member the request targets —
   * never an array (that shape is `replace`'s own whole-array surface) and
   * never absent. Wraps the raw body as a one-element array and reuses
   * `resolveArrayMutationMemberIds`'s own deserializer path, rather than
   * duplicating `associate()` here, for the same reason that helper does.
   */
  private resolveArrayMutationMemberId(relation: string, body: unknown, context: KavoContext<Entity>): EntityId {
    const invalid = (): never => {
      throw new ArrayMutationInvalidShapeException({
        messageParams: {
          entity: context.entityName,
          relation,
          expected: "a single id or id reference naming exactly one member",
        },
        context: { entityName: context.entityName, operation: context.operation, correlationId: context.correlationId },
      });
    };
    if (body === null || body === undefined || Array.isArray(body)) invalid();
    const memberIds = this.resolveArrayMutationMemberIds(relation, [body], context);
    const memberId = memberIds?.[0];
    if (memberId === undefined) return invalid();
    return memberId;
  }

  /**
   * URL path ids arrive as strings; coerce against the id column's kind so
   * adapters always compare with the right type (and a non-numeric id on a
   * numeric column is a clean 400, not a driver error).
   */
  private coerceId(id: unknown): unknown {
    const { metadata } = this.deps;
    const idField = metadata.fields.find((field) => field.name === metadata.idField);
    if (idField?.kind !== "number" || typeof id !== "string") return id;
    const value = Number(id);
    if (Number.isNaN(value)) {
      throw QueryValidationException.single({
        field: metadata.idField,
        code: "KAVO_QUERY_INVALID_VALUE",
        detail: `Value '${id}' for field '${metadata.idField}' is not a valid number.`,
      });
    }
    return value;
  }

  /**
   * `list<Relation>`'s response (ADR-0029's resource amendment) is the
   * parent entity, not the relation's own member list — but the relation it
   * just read still has to show up *somewhere* on that parent, or
   * `list<Relation>` cannot answer the question its name promises. The
   * ordinary include mechanism only grafts a relation onto a response when
   * `context.query.include` names it, and `list<Relation>` never populates
   * one (it takes no query of its own) — so this forces exactly one include
   * node onto a serialization-only context copy.
   *
   * Scoped to `action === "list"` alone, deliberately: `add`/`remove`/
   * `replace<Relation>` keep the exact response shape `replace<Relation>`
   * has always had — the parent alone, with no relation grafted on, per
   * ADR-0029's original Consequences section — so an entity's existing
   * `replace`-strategy behavior is byte-for-byte unchanged by this method
   * existing at all.
   *
   * Bypasses `allowlists.includable` deliberately: `write` and
   * `includable` are independent opt-ins (ADR-0029's own doc comment on
   * `RelationEdgeSettings.write`), so a relation opted into `write` but
   * never into `includable` must still appear on `list<Relation>`'s own
   * response, whose entire purpose is showing that relation's membership.
   */
  private contextForArrayMutationResponse(
    descriptor: OperationDescriptor<Entity>,
    context: KavoContext<Entity>,
  ): KavoContext<Entity> {
    const arrayMutation = descriptor.meta.arrayMutation;
    if (arrayMutation === undefined || arrayMutation.action !== "list") return context;
    const relation = this.deps.config.relations.get(arrayMutation.relation);
    if (relation === undefined) return context;
    const node: IncludeNode = {
      relation,
      path: arrayMutation.relation,
      fields: null,
      strategy: relation.strategy === "auto" ? (relation.cardinality === "many" ? "batch" : "join") : relation.strategy,
      // Never read by the serializer's projection step (only an adapter's
      // own load decides what ends up in scope) — a neutral placeholder
      // satisfies the type without implying a query-time decision was made.
      softDelete: HARD_DELETE,
      children: {},
    };
    const include: IncludeTree = { [arrayMutation.relation]: node };
    // `list<Relation>` is `kind: "read"`, so `context.query` always exists
    // by the time `mapResponse` runs — this fallback is defensive only,
    // never actually reached on this path.
    const query: NormalizedQueryContext<Entity> = context.query ?? {
      filter: { root: null },
      sort: [],
      pagination: { limit: 0, offset: 0 },
      fields: { root: null, relations: {} },
      include: {},
      withDeleted: false,
      onlyDeleted: false,
      count: false,
    };
    return { ...context, query: { ...query, include } };
  }

  private async mapResponse(
    descriptor: OperationDescriptor<Entity>,
    result: unknown,
    context: KavoContext<Entity>,
    preconditions: RequestPreconditions | null,
  ): Promise<KavoResponse> {
    const { serializer, config } = this.deps;

    // Which envelope half is filled comes off the descriptor, not off the
    // id: `findMany` is simply the one standard entry with cardinality
    // `"many"`, and a custom operation that declares the same cardinality
    // (issue #145) returns the same `FindManyResult` shape and is mapped
    // the same way — nothing is special-cased per verb (ADR-0006).
    if (descriptor.cardinality === "many") {
      const listResult = result as FindManyResult<Entity>;
      const listDto = (descriptor.output as DtoClass<object> | null) ?? config.dto.resolve("list", descriptor.id);
      const pagination: Pagination<Entity> = context.query?.pagination ?? { limit: 0, offset: 0 };
      const listMeta = this.listMeta(listResult, context);
      const items = serializer.serializeList(listResult.entities, listDto, context);
      // First row only: this catches a declaration mistake, which is the
      // same for every row, and checking all of them would be per-request
      // work for a bootstrap-class error.
      validateProjectedResult(
        items[0],
        listResult.entities[0],
        listDto as DtoClass | null,
        descriptor,
        context,
        "list",
      );
      return {
        operation: descriptor.id,
        item: null,
        list: {
          items,
          limit: pagination.limit,
          // A keyset page has no absolute position in the match set, and
          // `offset` is a non-nullable envelope field, so cursor pages report
          // `0` (ADR-0021) — the honest reading of "how many rows precede
          // `items[0]` *in what this response describes*".
          offset: hasKeyset(pagination) ? 0 : pagination.offset,
          // `total` is a required envelope field typed `number | null`, but
          // a custom handler can return `{ entities }` alone. Left
          // `undefined` the key would vanish from the JSON body entirely,
          // so normalize the absent case to the documented `null`.
          total: listResult.total ?? null,
          // Spread rather than `meta: listMeta`: assigning `undefined` would
          // leave the key on the object (`"meta" in list`, `Object.keys`)
          // even though `JSON.stringify` drops it, so a programmatic caller
          // and a REST client would disagree about whether the envelope has
          // a `meta`. Omitted means omitted, on both sides.
          ...(listMeta === undefined ? {} : { meta: listMeta }),
        },
        // Collection ETags are out of scope (issue #120): a list's identity
        // spans pagination, sort and filter, which is a different feature
        // from hashing one representation.
        etag: null,
        notModified: false,
      };
    }

    if (result === null || result === undefined) {
      // Void results: deleteOne and purgeOne.
      return { operation: descriptor.id, item: null, list: null, etag: null, notModified: false };
    }

    const itemDto = (descriptor.output as DtoClass<object> | null) ?? config.dto.resolve("item", descriptor.id);
    const serializeContext = this.contextForArrayMutationResponse(descriptor, context);
    const item = serializer.serializeItem(result as Entity, itemDto, serializeContext);
    validateProjectedResult(item, result, itemDto as DtoClass | null, descriptor, context, "item");
    // `context.config` is the per-call view, so `cache.etag` honors an
    // override at any scope down to this one request.
    const etag = isEtagEnabled(context.config.settings.cache) ? await computeEtag(item) : null;
    return {
      operation: descriptor.id,
      item,
      list: null,
      etag,
      // `If-None-Match` is a cache-revalidation question, so it is only
      // answered for reads. On a write RFC 9110 gives it "only if absent"
      // semantics, which is a create-conditionally feature this issue
      // deliberately leaves out rather than half-implements.
      notModified: etag !== null && descriptor.kind === "read" && weakMatch(preconditions?.ifNoneMatch ?? [], etag),
    };
  }

  /**
   * Assemble the list envelope's `meta` (`ListResultDto.meta` — the
   * response bag, never `OperationConfig.meta`/`OperationMetadata`,
   * ADR-0007).
   *
   * A named step rather than an inline spread because this is the single
   * merge point for everything that can contribute to it, and the handler
   * is only the first contributor: `meta.nextCursor` under cursor
   * pagination (ADR-0021) and `meta.nextSince` under since pagination
   * (ADR-0022) belong to the engine, not to whatever handler happens to be
   * configured, and fold in here.
   *
   * The strategy's keys are the **base**, the handler's merge over them: a
   * handler (or a `withListMeta` contributor) that names `nextCursor`/
   * `nextSince` explicitly is stating intent, and the same "more specific
   * wins" direction runs through every other precedence chain in Kavo.
   *
   * `undefined` — not `{}` — when nothing contributed, so `mapResponse`
   * can leave the key off the envelope entirely. An empty bag carries no
   * information, and the common zero-config list is exactly the case that
   * would pay for it on every response. This is why the field is optional
   * (`ListResultDto.meta?`) while `total` is not: `total: null` still
   * answers "how many matched"; `meta: {}` answers nothing. Emptiness is
   * judged after the merge, so a contributor that returns `{}` is the same
   * as no contributor at all.
   *
   * A cursor page is never that case: `nextCursor` is `null` — not
   * `undefined` — on the last page, because "there is no page after this
   * one" is an answer, and a client walking the chain has to be told it has
   * reached the end rather than left to infer it from a missing key. A
   * since-paginated page is *never* on "the last page" in that sense —
   * polling has no end — so an exhausted poll echoes the request's own
   * `since` back rather than reporting `null` (ADR-0022). That echo can
   * itself be `null`, though: a first poll (`since` absent) against zero
   * matching rows has no boundary to echo, so `nextSince` is `null` there
   * too — the guarantee is "never invents an end-of-results `null`," not
   * "never `null` at all."
   *
   * `meta` never passes through the serializer: it is the caller's own
   * JSON-serializable data, not entity data, so no DTO projection or
   * field selection applies to it and it reaches the wire verbatim.
   *
   * Every path returns a fresh object literal rather than `result.meta`
   * itself, and the copy is deliberate: it is *not* the same situation as
   * `items`. `items` is a fresh array of freshly serialized DTOs on every
   * request, whereas `result.meta` can be the very same object each time —
   * a hand-written handler returning a module-scope constant is the
   * documented alternative to `withListMeta`. Handing that object out by
   * reference would let one response's consumer mutate every later
   * response's bag. Shallow is the right depth: it makes the envelope's
   * own key set private without deep-cloning caller data that only has to
   * survive `JSON.stringify`.
   */
  private listMeta(result: FindManyResult<Entity>, context: KavoContext<Entity>): ListMetaDto | undefined {
    const query = context.query;
    if (query === null || !hasKeyset(query.pagination)) return compactMeta(result.meta);
    if (isSincePagination(query.pagination)) return this.sinceListMeta(query.pagination, result, context);
    const pagination = query.pagination;
    // `hasMore` is the sentinel the built-in handler reports from its
    // `limit + 1` over-fetch. A replacement handler that does not report it
    // is taken at its word: no signal, no next page.
    const last = result.hasMore === true ? result.entities[result.entities.length - 1] : undefined;
    const nextCursor =
      last === undefined ? null : encodeCursor(cursorValuesOf(last, query.sort, this.entityFields, context.entityName));
    // A token identical to the one that produced this page means the page
    // did not advance: every page is page 1 and `hasMore` never goes false,
    // so a client following `nextCursor` would loop forever. Erroring beats
    // looping (ADR-0021).
    //
    // Two distinct causes land here, and the message names both because
    // naming only the first sends the reader to audit an adapter that is
    // already correct (#185):
    //
    // 1. The adapter honours the `limit + 1` over-fetch but reads
    //    `query.filter` instead of `readFilter(query)`, so the keyset
    //    predicate never reached the query at all.
    // 2. The predicate reached the query and did not select what `ORDER BY`
    //    ordered, because the leading sort column's stored values do not
    //    compare against the bound cursor value the way the engine sorts
    //    them. SQLite is where this bites: a `date` column is TEXT and
    //    compares lexically, so rows written by a SQL default
    //    (`@CreateDateColumn` renders `datetime('now')`, second precision)
    //    and a parameter bound by the driver (`.000` milliseconds) are two
    //    spellings of one instant that never compare equal.
    if (nextCursor !== null && nextCursor === pagination.cursor) {
      throw new ConfigurationException(
        context.entityName,
        "pagination.strategy",
        `cursor pagination did not advance: the page produced the same token it was given, so the keyset ` +
          `predicate did not exclude the rows already served. Two causes produce this. Either the repository ` +
          `adapter's 'findMany' filters by 'query.filter' rather than 'readFilter(query)', so the predicate ` +
          `never reached the query; or it did reach the query and does not agree with 'ORDER BY', because the ` +
          `sort column's stored values compare differently from the bound cursor value — which is what a ` +
          `date column holding more than one textual spelling of an instant does on a backend that stores ` +
          `dates as text. Check the adapter first, then the sort column`,
      );
    }
    return compactMeta({ nextCursor, ...result.meta });
  }

  /**
   * `meta.nextSince`, the since-pagination counterpart of `nextCursor`
   * (ADR-0022). Unlike `nextCursor`, this is computed from the **last
   * returned row regardless of `hasMore`**, not only when the page is
   * full: since-pagination is a continuous poll, not a bounded traversal,
   * so the boundary must always advance past what the client has already
   * seen — leaving it `undefined`/unchanged on a partial page would make
   * the next poll re-fetch rows this one already returned.
   *
   * On an empty page (`entities.length === 0`, a genuinely exhausted poll —
   * the `<value>|<id>` token makes `since` pagination exactly-once *within*
   * a poll session, so this is no longer reachable merely because a tied
   * group outran `limit`) there is no new boundary to report, so this
   * echoes the request's own `since` back — `pagination.since ?? null` —
   * rather than inventing an end-of-results `null`: there is no "last page"
   * to signal the end of, and a caught-up client needs a value to poll with
   * next, not nothing. On a *first* poll against zero matching rows, that
   * echo is genuinely `null` (there was no prior boundary to echo), which
   * is the one case `nextSince` is falsy — every other empty page echoes a
   * real value.
   *
   * Deliberately **not** ported: cursor's "did not advance" `ConfigurationException`.
   * With the id half of the token now breaking every tie, an unchanged
   * `nextSince` genuinely means "nothing new," not a broken adapter — it is
   * not an error here.
   */
  private sinceListMeta(
    pagination: SincePagination<Entity>,
    result: FindManyResult<Entity>,
    context: KavoContext<Entity>,
  ): ListMetaDto | undefined {
    const sinceFieldName = context.config.settings.pagination.since.field;
    const sinceField = this.entityFields.get(sinceFieldName);
    const idField = this.entityFields.get(this.deps.metadata.idField);
    const last = result.entities[result.entities.length - 1];
    const nextSince =
      last === undefined || sinceField === undefined || idField === undefined
        ? (pagination.since ?? null)
        : sinceValueOf(last, sinceField, idField, context.entityName);
    return compactMeta({ nextSince, ...result.meta });
  }
}

/**
 * The merged bag with `undefined`-valued keys dropped, and `undefined` in
 * place of a bag left empty by that — the single place emptiness is judged,
 * so every contributor is held to the same rule.
 *
 * Those keys are dropped rather than counted because they are exactly what
 * `JSON.stringify` erases: keeping them would hand a programmatic caller a
 * `{ facets: undefined }` bag while the REST client saw `"meta": {}` — the
 * very divergence the omit-when-empty rule exists to prevent.
 */
function compactMeta(meta: ListMetaDto | undefined): ListMetaDto | undefined {
  if (meta === undefined) return undefined;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) copy[key] = value;
  }
  return Object.keys(copy).length === 0 ? undefined : copy;
}

/**
 * Every id the registry knows, sorted, for the not-registered message. The
 * list is short (the standard table plus whatever was registered on top)
 * and it answers "then what *can* I call?" — disabled entries included,
 * since those are one config flag away from working and their own error
 * says so.
 */
function registeredIds<Entity extends object>(registry: OperationRegistry<Entity>): string {
  return nameList(registry.all().map((descriptor) => descriptor.id));
}

/**
 * The cache key's query half: a plain-data projection of the normalized
 * query, because the include tree carries live `RelationDescriptor` objects
 * (`IncludeNode.relation`) that `canonicalize` must not serialize — the
 * fingerprint folds each node down to its query-decided parts, `fields`
 * and `children` (the paths are the keys). Everything that changes a
 * `findOne`/`findMany` response is included. Per-call *settings* are
 * deliberately not (ADR-0031): the key is entity + operation + target id +
 * query (the id is a separate key part, `cacheKey`), and a per-call
 * settings override that reshapes a response without changing the query —
 * the one known case is `softDelete.strategy` — is outside the key's
 * contract.
 */
function queryFingerprint<Entity>(query: NormalizedQueryContext<Entity>): unknown {
  return {
    filter: query.filter,
    sort: query.sort,
    pagination: query.pagination,
    fields: query.fields,
    include: includeFingerprint(query.include),
    withDeleted: query.withDeleted,
    onlyDeleted: query.onlyDeleted,
    count: query.count,
  };
}

function includeFingerprint(
  tree: IncludeTree,
): Record<string, { readonly fields: readonly string[] | null; readonly children: unknown }> {
  const out: Record<string, { readonly fields: readonly string[] | null; readonly children: unknown }> = {};
  for (const [name, node] of Object.entries(tree)) {
    out[name] = { fields: node.fields ?? null, children: includeFingerprint(node.children) };
  }
  return out;
}

/**
 * `structuredClone` is a runtime global on every supported platform (Node
 * ≥ 20, browsers, workers) but not in the pure ES lib types `@kavo/core`
 * compiles against (ADR-0005) — so it is reached through a typed accessor,
 * the same way `etag.ts` reaches Web Crypto and `default-kavo-context.ts`
 * reaches `crypto.randomUUID`.
 */
interface WebGlobals {
  readonly structuredClone: <T>(value: T) => T;
}

const webGlobals = globalThis as unknown as WebGlobals;

/**
 * A cached hit serves a fresh envelope with a cloned payload — see
 * `responseFromCache`. Only the mutable halves are cloned; the envelope's
 * scalars are already a fresh spread.
 */
function cloneResponsePayload(response: KavoResponse): KavoResponse {
  return {
    ...response,
    item: response.item === null ? null : webGlobals.structuredClone(response.item),
    list: response.list === null ? null : webGlobals.structuredClone(response.list),
  };
}

/**
 * A custom operation whose handler returned a shape sharing **no** field
 * with the response projection fails loudly instead of serving `{}`
 * (#181).
 *
 * A custom operation is the one place a handler's result is not the entity
 * by contract, so it is the one place the projection can empty a value
 * entirely. `dto.output` is how a result with its own shape declares
 * itself; with none, the result is filtered to the entity's columns plus
 * its computed fields, and a result that shares none of them survives as an
 * empty object. Nothing said so — not a type error, not a log line — and
 * the static types actively disagreed: `CustomOperationResult` types
 * `run`'s return as the handler's own return type when no `dto.output` is
 * declared, so the signature promised the shape while the wire served `{}`.
 *
 * Scoped to custom ids deliberately. A standard operation's result *is* the
 * entity by contract, so an empty projection there is a different bug with
 * a different fix, and `dto.output` is not the answer to it.
 *
 * Zero intersection is the test, not "narrower than the result": a genuine
 * narrowing — a handler returning a row with a subset of the entity's
 * fields — is exactly what the projection is for and must stay silent.
 *
 * Skipped under an explicit `fields=`, because sparse selection can empty
 * the projection on its own and the message would then blame the wrong
 * thing. That request is the client's mistake, and a narrowed read of an
 * operation whose shape is already wrong will trip this the moment the
 * fieldset comes off.
 *
 * This is `withListMeta`'s pattern (`with-list-meta.ts`): a handler that
 * returned a shape the envelope cannot use raises a request-time
 * `ConfigurationException` keyed to the operation, rather than assembling
 * something broken.
 */
function validateProjectedResult<Entity>(
  projected: unknown,
  source: unknown,
  dto: DtoClass | null,
  descriptor: OperationDescriptor<Entity>,
  context: KavoContext<Entity>,
  slot: "item" | "list",
): void {
  if (isStandardOperationId(descriptor.id)) return;
  if (context.query?.fields.root != null) return;
  if (!carriesSomething(source)) return;
  if (typeof projected !== "object" || projected === null || Object.keys(projected).length > 0) return;
  const served = slot === "list" ? "the first row of the list" : "the response";
  throw new ConfigurationException(
    context.entityName,
    `operations.${descriptor.id}.dto.output`,
    `the '${descriptor.id}' handler returned ${describeResult(source)}, so ${served} serialized to {}. ` +
      projectedAgainst(dto, context.entityName, slot),
  );
}

/**
 * Whether the handler's result had anything for the projection to keep.
 *
 * Deliberately wider than `Object.keys(source).length > 0`, which was the
 * first cut and let three shapes through in silence — the exact #181 symptom
 * the guard exists to end:
 *
 * - a **class instance whose fields are accessors**, since getters live on
 *   the prototype and `Object.keys` never sees them, while
 *   `DefaultSerializer.project` emits with `key in source` and does;
 * - a **`Date`**, or any other boxed value with no own enumerable keys;
 * - a **non-empty array**, which is what a handler that meant
 *   `cardinality: "many"` and left it at the default returns.
 *
 * A plain `{}` is still exempt: a handler that returns nothing meaningful is
 * not making a declaration mistake about its shape.
 */
function carriesSomething(source: unknown): boolean {
  if (typeof source !== "object" || source === null) return false;
  if (Array.isArray(source)) return source.length > 0;
  if (Object.keys(source).length > 0) return true;
  // Anything that is not a plain object carries state somewhere the own-key
  // check cannot see. `null` prototype means a bare dictionary, which the
  // key check above already judged.
  const prototype = Object.getPrototypeOf(source) as object | null;
  return prototype !== Object.prototype && prototype !== null;
}

/** The result's shape, for the first half of the message. */
function describeResult(source: unknown): string {
  if (Array.isArray(source)) {
    return `an array of ${source.length} item(s) — a collection result needs 'cardinality: "many"' on the operation`;
  }
  const keys = Object.keys(source as object);
  if (keys.length > 0) return `an object whose keys are ${nameList(keys)}`;
  const name = (source as { constructor?: { name?: string } }).constructor?.name;
  return `a ${name === undefined || name === "" ? "non-plain object" : name} instance, whose values are not own enumerable properties`;
}

/**
 * The second half: what the result was projected *through*, which decides
 * what the reader has to change.
 *
 * Naming the entity unconditionally was wrong. Where a `dto.output` is
 * registered, the entity's fields are irrelevant — the projection is the
 * DTO's keys — and telling an author to "declare `dto: { output: … }`" when
 * they already did sends them to fix the thing they got right. Where one is
 * registered but has no runtime shape (a declared-only class, which
 * `@kavo/nest` supports on purpose so Swagger's decorators can answer), the
 * fallback is the entity's projection and the missing initializers are the
 * actual fault.
 */
function projectedAgainst(dto: DtoClass | null, entityName: string, slot: "item" | "list"): string {
  if (dto === null) {
    return (
      `A custom operation's result is projected through the entity's '${slot}' shape unless the operation ` +
      `registers one of its own, and none of those keys are fields of '${entityName}' — declare ` +
      `'dto: { output: <YourResultDto> }' on the operation, with every field initialized so the class has a ` +
      `runtime shape`
    );
  }
  const keys = dtoShapeKeys(dto);
  if (keys === null) {
    return (
      `The registered '${dto.name || "(anonymous)"}' declares no runtime fields — TypeScript erases an ` +
      `uninitialized class field, so 'applied!: number' declares nothing at runtime and the projection falls ` +
      `back to '${entityName}'. Give each field an initializer ('applied = 0')`
    );
  }
  return (
    `The result was projected through the registered '${dto.name || "(anonymous)"}', which declares ` +
    `${nameList(keys)} — none of which the handler returned. The DTO and the handler disagree about the ` +
    `result's shape; change whichever is wrong`
  );
}
