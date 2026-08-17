import type { ClassRef, EntityInput } from "./types/utility.js";
import type { KavoInfrastructure, EntityMetadata } from "./metadata/entity-metadata.js";
import type { EntityConfig, OperationsConfig } from "./config/entity-config.js";
import type { EntityId } from "./types/entity-id.js";
import type { GlobalConfig } from "./config/global-config.js";
import type { PaginationStrategy } from "./query/pagination.js";
import type { QueryContext } from "./query/query-context.js";
import type { RepositoryAdapter } from "./persistence/repository-adapter.js";
import type { IncludeResolver } from "./relations/include-resolver.js";
import type { OperationRegistry } from "./operations/operation-registry.js";
import type { ResolvedEntityConfig } from "./config/resolved-entity-config.js";
import type { RealtimeTransport } from "./realtime/realtime-transport.js";
import type { CacheStore } from "./caching/cache-store.js";
import { createMemoryCacheStore } from "./caching/cache-store.js";
import { KavoEngine } from "./engine/kavo-engine.js";
import { ConfigurationException } from "./errors/exceptions.js";
import { DefaultKavoService } from "./service/default-kavo-service.js";
import { DefaultErrorHandler } from "./errors/default-error-handler.js";
import { DefaultDeserializer, DefaultSerializer } from "./serialization/default-serializer.js";
import { QueryNormalizer } from "./query/query-normalizer.js";
import { builtInHandlers } from "./engine/built-in-handlers.js";
import { createOperationRegistry } from "./operations/default-operation-registry.js";
import type { EntityCatalog } from "./metadata/entity-catalog.js";
import { DefaultEntityCatalog } from "./metadata/entity-catalog.js";
import { DefaultIncludeResolver } from "./relations/default-include-resolver.js";
import { describeResolvedConfig, resolveEntityConfig } from "./config/resolve-entity-config.js";
import { registerArrayMutationOperations } from "./relations/array-mutation-operations.js";

/**
 * Root-factory options. `GlobalConfig.defaults` is the
 * framework-scope link of the precedence chain; `infrastructure` is how an
 * ORM package plugs in (`createInfrastructure(dataSource)`) without
 * core ever importing it.
 */
export interface KavoOptions extends GlobalConfig {
  readonly infrastructure?: KavoInfrastructure;
  /** Custom pagination strategies, addressable via `pagination.strategy`. */
  readonly paginationStrategies?: readonly PaginationStrategy[];
  /**
   * Realtime transports every entity's write events publish to — resolved
   * once here, not per entity and not through `defaults`/`GlobalConfig`
   * (ADR-0023: a transport, a live object,
   * cannot live inside the deep-frozen settings tree).
   */
  readonly realtimeTransports?: readonly RealtimeTransport[];
  /**
   * The result-cache store every entity reads/writes when `cache` is
   * enabled (ADR-0031) — a live object like a realtime transport, so it is
   * registered here, once per root, not through `defaults` (the ADR-0023
   * relationship, applied to caching). Unset, each root gets its own
   * private in-memory store; a shared backend (Redis, …) is a
   * caller-registered implementation of the same three methods, and an app
   * that wants one process-wide cache hands the same instance to every
   * root (`KavoModule.forRoot({ cacheStore })`).
   */
  readonly cacheStore?: CacheStore;
}

/** Per-entity overrides of what the root `infrastructure` would supply. */
export interface KavoRuntime<Entity extends object> {
  readonly adapter?: RepositoryAdapter<Entity>;
  readonly metadata?: EntityMetadata<Entity>;
}

/**
 * A Kavo root instance: one merged global scope plus the entity registry
 * built from it. `createCrud` is the only way entities enter the system;
 * everything it resolves (config, DTOs, registry) happens at that call —
 * bootstrap — and is frozen after.
 */
export interface KavoInstance {
  createCrud<
    Entity extends object,
    CreateDto = EntityInput<Entity>,
    UpdateDto = EntityInput<Entity>,
    PatchDto = Partial<UpdateDto>,
    QueryDto = QueryContext<Entity>,
    ItemDto = Entity,
    ListDto = ItemDto,
    Computed extends string = never,
    Ops extends OperationsConfig<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto> = OperationsConfig<
      Entity,
      CreateDto,
      UpdateDto,
      PatchDto,
      QueryDto,
      ItemDto,
      ListDto
    >,
  >(
    entity: ClassRef<Entity>,
    config?: EntityConfig<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto, Computed, Ops>,
    runtime?: KavoRuntime<Entity>,
  ): DefaultKavoService<Entity, EntityId, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto, Ops>;

  /** Debug dump: resolved configuration for one registered entity. */
  describe(entityName: string): Record<string, unknown> | undefined;
}

/**
 * Create a Kavo root instance (`createKavo`). The zero-config
 * path is `createKavo({ infrastructure }).createCrud(Entity)` — built-in
 * defaults, derived DTOs and allowlists, standard operations.
 */
export function createKavo(options: KavoOptions = {}): KavoInstance {
  validateRealtimeTransports(options.realtimeTransports);
  const cacheStore = options.cacheStore ?? createMemoryCacheStore();
  validateCacheStore(cacheStore);
  const registered = new Map<string, Record<string, unknown>>();
  // The cross-entity view nested includes resolve against.
  // Entities that never go through `createCrud` are derived from
  // infrastructure metadata on demand, so a relation can point at one.
  const catalog = new DefaultEntityCatalog(
    (entity) => options.infrastructure?.metadataFor(entity) as EntityMetadata<object> | undefined,
    options.defaults,
  );

  return {
    createCrud(entity, config, runtime) {
      type Entity = InstanceType<typeof entity> & object;
      const metadata = runtime?.metadata ?? options.infrastructure?.metadataFor(entity);
      if (metadata === undefined) {
        throw new ConfigurationException(
          entity.name,
          "infrastructure",
          "no metadata source: pass `infrastructure` to createKavo " +
            "(e.g. createInfrastructure(dataSource) from " +
            "@kavo/typeorm) or `runtime.metadata` to createCrud — " +
            "in a NestJS app that is KavoModule.forRoot({ infrastructure }) " +
            "or forRootAsync({ useFactory })",
        );
      }
      const adapter = runtime?.adapter ?? options.infrastructure?.adapterFor(entity);
      if (adapter === undefined) {
        throw new ConfigurationException(
          metadata.name,
          "infrastructure",
          "no repository adapter: pass `infrastructure` to createKavo or " +
            "`runtime.adapter` to createCrud — in a NestJS app that is " +
            "KavoModule.forRoot({ infrastructure }) or forRootAsync({ useFactory })",
        );
      }

      const resolved = resolveEntityConfig<Entity>(
        metadata as EntityMetadata<Entity>,
        config as EntityConfig<Entity> | undefined,
        options.defaults,
        options.realtimeTransports,
        cacheStore,
      );
      // `builtInHandlers()` takes no adapter: the built-ins read the
      // request's `context.repository`, which the engine below fills from
      // this same `adapter` (ADR-0025). One rule for every handler —
      // built-in, overridden and custom reach persistence the same way.
      const registry = createOperationRegistry<Entity>(
        config as EntityConfig<Entity> | undefined,
        builtInHandlers<Entity>(),
        resolved.settings.operations,
        resolved.entityName,
      );
      requireSoftDeletable(resolved, registry);
      // Grouped by each relation's own *resolved* strategy (ADR-0029's
      // per-relation amendment, issue #223) — `resolved.relations` already
      // carries that resolution (`DefaultRelationRegistry`), so a mixed
      // entity only demands the adapter primitives its relations actually
      // use, and only registers the route shape each relation's own
      // strategy needs.
      const writeOptedRelations = resolved.relations.all().filter((relation) => relation.write !== undefined);
      if (writeOptedRelations.length > 0) {
        const names = writeOptedRelations.map((relation) => relation.name);
        requireArrayMutationTargetsResolvable(resolved, names, catalog);
        const byStrategy = (strategy: "replace" | "resource" | "jsonPatch"): readonly string[] =>
          writeOptedRelations.filter((relation) => relation.write === strategy).map((relation) => relation.name);
        const replaceRelations = byStrategy("replace");
        const resourceRelations = byStrategy("resource");
        const jsonPatchRelations = byStrategy("jsonPatch");

        if (replaceRelations.length > 0) {
          requireArrayMutationSupport(resolved, replaceRelations, adapter as unknown as RepositoryAdapter<Entity>);
        }
        if (resourceRelations.length > 0) {
          requireResourceArrayMutationSupport(
            resolved,
            resourceRelations,
            adapter as unknown as RepositoryAdapter<Entity>,
          );
        }
        if (jsonPatchRelations.length > 0) {
          requireJsonPatchSupport(resolved, jsonPatchRelations, adapter as unknown as RepositoryAdapter<Entity>);
        }

        // `jsonPatch` relations synthesize no route/operation here — they
        // reuse `patchOne`'s existing route instead (ADR-0029's jsonPatch
        // amendment), so only `replace`/`resource` relations feed this call.
        // One call, one full handler-factory set: a factory is keyed by
        // *action*, not strategy, so the same four factories serve a
        // `replace`-strategy relation (which only ever reaches `replace`)
        // and a `resource`-strategy one (which reaches all four) alike.
        const routedRelations = [
          ...replaceRelations.map((name) => ({ name, strategy: "replace" as const })),
          ...resourceRelations.map((name) => ({ name, strategy: "resource" as const })),
        ];
        if (routedRelations.length > 0) {
          registerArrayMutationOperations<Entity>(registry, routedRelations, resolved.entityName, {
            // Every primitive below is confirmed present by the capability
            // checks above, once, at bootstrap — never per request.
            replace: (relationName) => ({
              execute: (input: unknown, context) => {
                const { id, memberIds } = input as { id: EntityId; memberIds: readonly EntityId[] | null };
                return context.repository.replaceRelation!(id, relationName, memberIds, context);
              },
            }),
            list: (relationName) => ({
              execute: (input: unknown, context) => {
                return context.repository.readRelation!(input as EntityId, relationName, context);
              },
            }),
            add: (relationName) => ({
              execute: (input: unknown, context) => {
                const { id, memberId } = input as { id: EntityId; memberId: EntityId };
                return context.repository.addRelationMember!(id, relationName, memberId, context);
              },
            }),
            remove: (relationName) => ({
              execute: (input: unknown, context) => {
                const { id, memberId } = input as { id: EntityId; memberId: EntityId };
                return context.repository.removeRelationMember!(id, relationName, memberId, context);
              },
            }),
          });
        }
      }

      catalog.register(entity as ClassRef, {
        metadata: metadata as EntityMetadata<object>,
        config: resolved as unknown as ResolvedEntityConfig<object>,
      });

      const engine = new KavoEngine<Entity>({
        metadata: metadata as EntityMetadata<Entity>,
        config: resolved,
        registry,
        serializer: new DefaultSerializer(
          metadata as EntityMetadata<Entity>,
          catalog,
          resolved.computed,
          resolved.projection as readonly string[] | null,
        ),
        deserializer: new DefaultDeserializer(metadata as EntityMetadata<Entity>, catalog, resolved.computed),
        normalizer: new QueryNormalizer(
          metadata as EntityMetadata<Entity>,
          options.paginationStrategies ?? [],
          new DefaultIncludeResolver(catalog) as IncludeResolver<Entity>,
        ),
        errorHandler: new DefaultErrorHandler(),
        // Both halves: the engine reads through it for the `If-Match`
        // pre-read (ADR-0020) and hands it to every handler on the
        // request context (ADR-0025).
        repository: adapter as unknown as RepositoryAdapter<Entity>,
      });

      // Every registered id, not just the standard table: a custom
      // operation takes per-operation settings the same way (issue #145),
      // so leaving it out would make the debug dump quietly incomplete for
      // exactly the operations whose configuration is least familiar.
      registered.set(
        resolved.entityName,
        describeResolvedConfig(
          resolved,
          registry.all().map((descriptor) => descriptor.id),
        ),
      );
      return new DefaultKavoService(engine) as never;
    },

    describe(entityName) {
      return registered.get(entityName);
    },
  };
}

/**
 * Fails fast at `createKavo`, once, rather than per entity — a transport
 * is shared process-wide, so a malformed one should never surface as N
 * bootstrap errors, one per `createCrud` call that happens to run first.
 */
function validateRealtimeTransports(transports: readonly RealtimeTransport[] | undefined): void {
  if (transports === undefined) return;
  for (const [index, transport] of transports.entries()) {
    const path = `realtimeTransports[${index}]`;
    const candidate = transport as { name?: unknown; publish?: unknown } | null;
    if (typeof candidate !== "object" || candidate === null) {
      throw new ConfigurationException(
        "createKavo",
        path,
        `expected a RealtimeTransport, got ${JSON.stringify(transport)}`,
      );
    }
    if (typeof candidate.name !== "string" || candidate.name.length === 0) {
      throw new ConfigurationException(
        "createKavo",
        `${path}.name`,
        `expected a non-empty string, got ${JSON.stringify(candidate.name)}`,
      );
    }
    if (typeof candidate.publish !== "function") {
      throw new ConfigurationException(
        "createKavo",
        `${path}.publish`,
        `expected a function, got ${JSON.stringify(candidate.publish)}`,
      );
    }
  }
}

/**
 * Fails fast at `createKavo`, once, rather than per entity — a store is
 * shared process-wide, so a malformed one should never surface as N
 * bootstrap errors, one per `createCrud` call that happens to run first
 * (the same reasoning `validateRealtimeTransports` documents).
 */
function validateCacheStore(store: CacheStore): void {
  const candidate = store as { get?: unknown; set?: unknown; invalidate?: unknown } | null;
  if (typeof candidate !== "object" || candidate === null) {
    throw new ConfigurationException("createKavo", "cacheStore", `expected a CacheStore, got ${JSON.stringify(store)}`);
  }
  for (const method of ["get", "set", "invalidate"] as const) {
    if (typeof candidate[method] === "function") continue;
    throw new ConfigurationException(
      "createKavo",
      `cacheStore.${method}`,
      `expected a function, got ${JSON.stringify(candidate[method])}`,
    );
  }
}

/**
 * `restoreOne`/`purgeOne` are enabled from config alone, because route
 * generation runs before any ORM metadata exists (ADR-0013). Bootstrap is
 * the first moment both halves are known, so it is where the mismatch —
 * an entity that resolves to hard delete with a soft-delete operation
 * switched on — becomes an error naming the fix.
 */
function requireSoftDeletable<Entity extends object>(
  config: ResolvedEntityConfig<Entity>,
  registry: OperationRegistry<Entity>,
): void {
  if (config.softDelete.strategy === "soft") return;
  for (const id of ["restoreOne", "purgeOne"] as const) {
    if (registry.get(id)?.enabled !== true) continue;
    throw new ConfigurationException(
      config.entityName,
      `operations.${id}`,
      `'${id}' needs a soft-deletable entity, but '${config.entityName}' resolves to a ` +
        `hard delete strategy — give it a delete-marker column (@DeleteDateColumn) or ` +
        `set softDelete.field to an existing column`,
    );
  }
}

/**
 * Fails fast at `createCrud` when a relation opts into array-mutation
 * writes but the repository adapter in use has no `replaceRelation` — the
 * same ORM caveat ADR-0014's Consequences section already names for
 * association by id: Kavo maps the payload, it does not synthesize a write
 * an adapter declined to make. Checked once here rather than per request.
 */
function requireArrayMutationSupport<Entity extends object>(
  config: ResolvedEntityConfig<Entity>,
  relationNames: readonly string[],
  adapter: RepositoryAdapter<Entity>,
): void {
  if (relationNames.length === 0 || typeof adapter.replaceRelation === "function") return;
  throw new ConfigurationException(
    config.entityName,
    `relations.edges.${relationNames[0]}.write`,
    `'${relationNames[0]}' opts into array-mutation writes, but this entity's repository adapter does not ` +
      `implement 'replaceRelation' — array-mutation writes are not supported by this adapter yet`,
  );
}

/**
 * Fails fast at `createCrud` when a relation opts into array-mutation
 * writes under `arrayMutation.strategy: "resource"` (ADR-0029's resource
 * amendment) but the repository adapter in use is missing one of the four
 * primitives the strategy's operations need — `replaceRelation`,
 * `readRelation`, `addRelationMember`, `removeRelationMember`. Checked once
 * here rather than per request, the same ORM caveat
 * `requireArrayMutationSupport`/`requireJsonPatchSupport` already name:
 * Kavo maps the payload, it does not synthesize a write an adapter declined
 * to make.
 */
function requireResourceArrayMutationSupport<Entity extends object>(
  config: ResolvedEntityConfig<Entity>,
  relationNames: readonly string[],
  adapter: RepositoryAdapter<Entity>,
): void {
  if (relationNames.length === 0) return;
  const required = ["replaceRelation", "readRelation", "addRelationMember", "removeRelationMember"] as const;
  for (const method of required) {
    if (typeof adapter[method] === "function") continue;
    throw new ConfigurationException(
      config.entityName,
      `relations.edges.${relationNames[0]}.write`,
      `'${relationNames[0]}' opts into array-mutation writes under 'arrayMutation.strategy: "resource"', but this ` +
        `entity's repository adapter does not implement '${method}' — the 'resource' strategy is not supported by ` +
        `this adapter yet`,
    );
  }
}

/**
 * Fails fast at `createCrud` when a relation opts into array-mutation
 * writes under `arrayMutation.strategy: "jsonPatch"` but the repository
 * adapter in use has no `patchRelation` — the `jsonPatch` counterpart of
 * `requireArrayMutationSupport` (ADR-0029's jsonPatch amendment). Checked
 * once here rather than per request.
 */
function requireJsonPatchSupport<Entity extends object>(
  config: ResolvedEntityConfig<Entity>,
  relationNames: readonly string[],
  adapter: RepositoryAdapter<Entity>,
): void {
  if (relationNames.length === 0 || typeof adapter.patchRelation === "function") return;
  throw new ConfigurationException(
    config.entityName,
    `relations.edges.${relationNames[0]}.write`,
    `'${relationNames[0]}' opts into array-mutation writes under 'arrayMutation.strategy: "jsonPatch"', but this ` +
      `entity's repository adapter does not implement 'patchRelation' — jsonPatch array-mutation writes are not ` +
      `supported by this adapter yet`,
  );
}

/**
 * Fails fast at `createCrud` when a write-opted relation's target entity
 * can't be resolved through the entity catalog — the same lookup
 * `resolveArrayMutationMemberIds` (`kavo-engine.ts`) needs at request time to
 * narrow a wire body down to `{id}` references (`DefaultDeserializer`'s
 * `associate()`, via `catalog.get(relation.target())?.metadata.idField`).
 * An unresolvable target would silently return an unnarrowed body there —
 * scalars degrading to `undefined`, and an object's first enumerable value
 * being taken as the id — rather than the clean `ConfigurationException`
 * this raises instead, once, before any request can reach it. Registering
 * the target through `createCrud` (or an `infrastructure` that can derive
 * its metadata) closes the gap.
 */
function requireArrayMutationTargetsResolvable<Entity extends object>(
  config: ResolvedEntityConfig<Entity>,
  relationNames: readonly string[],
  catalog: EntityCatalog,
): void {
  for (const name of relationNames) {
    const relation = config.relations.get(name);
    if (relation === undefined) continue; // unreachable: relationNames came from this same registry
    if (catalog.get(relation.target()) !== undefined) continue;
    throw new ConfigurationException(
      config.entityName,
      `relations.edges.${name}.write`,
      `'${name}' opts into array-mutation writes, but its target entity has no metadata this root can ` +
        `resolve — pass it through 'createCrud', or an 'infrastructure' that can derive its metadata, ` +
        `on the same root as '${config.entityName}'`,
    );
  }
}

/**
 * The bare zero-config path: `createCrud(Entity, config?,
 * runtime)` — an implicit root instance with built-in defaults. At the
 * core level the runtime (adapter + metadata) must be explicit, because
 * core has no ORM to derive them from; `@kavo/typeorm`'s
 * `createTypeOrmKavo` is the sugar that makes it disappear.
 */
export function createCrud<
  Entity extends object,
  CreateDto = EntityInput<Entity>,
  UpdateDto = EntityInput<Entity>,
  PatchDto = Partial<UpdateDto>,
  QueryDto = QueryContext<Entity>,
  ItemDto = Entity,
  ListDto = ItemDto,
  Computed extends string = never,
  Ops extends OperationsConfig<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto> = OperationsConfig<
    Entity,
    CreateDto,
    UpdateDto,
    PatchDto,
    QueryDto,
    ItemDto,
    ListDto
  >,
>(
  entity: ClassRef<Entity>,
  config?: EntityConfig<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto, Computed, Ops>,
  runtime?: KavoRuntime<Entity>,
): DefaultKavoService<Entity, EntityId, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto, Ops> {
  return createKavo().createCrud(entity, config, runtime);
}
