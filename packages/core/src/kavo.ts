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
import { KavoEngine } from "./engine/kavo-engine.js";
import { ConfigurationException } from "./errors/exceptions.js";
import { DefaultKavoService } from "./service/default-kavo-service.js";
import { DefaultErrorHandler } from "./errors/default-error-handler.js";
import { DefaultDeserializer, DefaultSerializer } from "./serialization/default-serializer.js";
import { QueryNormalizer } from "./query/query-normalizer.js";
import { builtInHandlers } from "./engine/built-in-handlers.js";
import { createOperationRegistry } from "./operations/default-operation-registry.js";
import { DefaultEntityCatalog } from "./metadata/entity-catalog.js";
import { DefaultIncludeResolver } from "./relations/default-include-resolver.js";
import { describeResolvedConfig, resolveEntityConfig } from "./config/resolve-entity-config.js";

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
      );
      const registry = createOperationRegistry<Entity>(
        config as EntityConfig<Entity> | undefined,
        builtInHandlers(adapter as unknown as RepositoryAdapter<Entity>),
        resolved.settings.operations,
        resolved.entityName,
      );
      requireSoftDeletable(resolved, registry);

      catalog.register(entity as ClassRef, {
        metadata: metadata as EntityMetadata<object>,
        config: resolved as unknown as ResolvedEntityConfig<object>,
      });

      const engine = new KavoEngine<Entity>({
        metadata: metadata as EntityMetadata<Entity>,
        config: resolved,
        registry,
        serializer: new DefaultSerializer(metadata as EntityMetadata<Entity>, catalog, resolved.computed),
        deserializer: new DefaultDeserializer(metadata as EntityMetadata<Entity>, catalog, resolved.computed),
        normalizer: new QueryNormalizer(
          metadata as EntityMetadata<Entity>,
          options.paginationStrategies ?? [],
          new DefaultIncludeResolver(catalog) as IncludeResolver<Entity>,
        ),
        errorHandler: new DefaultErrorHandler(),
        // The adapter is already both halves; the engine only ever reads
        // through it, for the `If-Match` pre-read (ADR-0020).
        reader: adapter as unknown as RepositoryAdapter<Entity>,
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
