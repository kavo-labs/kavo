import type { DynamicModule, ModuleMetadata, OnModuleInit, Provider, Type } from "@nestjs/common";
import { Inject, Injectable, Module } from "@nestjs/common";
import { APP_FILTER, DiscoveryModule, DiscoveryService } from "@nestjs/core";
import type { ClassRef, EntityMetadata, KavoInstance, OperationDtoMap } from "@kavo/core";
import {
  ConfigurationException,
  DefaultDtoResolver,
  createKavo,
  isEtagEnabled,
  shorthandFieldsOf,
  writeOptedInRelationNames,
} from "@kavo/core";
import type { KavoModuleOptions } from "./kavo-options.js";
import type { KavoConditionalDocEntry, KavoControllerMetadata } from "./kavo.decorator.js";
import {
  declaredArrayMutationStrategy,
  declaredRelationArrayMutationStrategy,
  getRegisteredKavoControllers,
} from "./kavo.decorator.js";
import { KavoExceptionFilter } from "./kavo-exception.filter.js";
import { createDefaultGraphQLController, DEFAULT_GRAPHQL_PATH } from "./graphql/default-graphql.controller.js";
import { createDefaultMcpController, DEFAULT_MCP_PATH } from "./mcp/default-mcp.controller.js";
import {
  applyBodySchemaDocs,
  applyConditionalRequestDocs,
  applyPaginationDocs,
  applyQuerySchemaDocs,
  applyResponseSchemaDocs,
  applySearchQueryDocs,
  applyValidationErrorDoc,
  bodyDtoFor,
} from "./swagger.js";
import {
  KAVO_INSTANCE,
  KAVO_MODULE_OPTIONS,
  KAVO_CONDITIONAL_DOCS_METADATA,
  KAVO_CONTROLLER_METADATA,
  KAVO_APP_CONTEXT_PROPERTY,
  KAVO_SERVICE_PROPERTY,
  getKavoServiceToken,
} from "./tokens.js";

/** `graphql: true` mounts the default controller at `POST /graphql`; `{ path }` mounts it at `POST <path>` instead. */
export type KavoGraphQLOption = boolean | { readonly path?: string };

/**
 * The entity-derived writable default `DefaultDeserializer` falls back to
 * when neither `dto.create`/`dto.update` names a real class nor the
 * top-level `create`/`update` `{ fields }` shorthand (issue #388, formerly
 * `dto.create`/`dto.update`'s own shorthand, issue #386) is set: every
 * non-generated column except the primary key (kept for a composite key,
 * which has no single column to exclude), plus every relation, associable
 * by id (ADR-0014). Used only as a Swagger fallback — `applyBodySchemaDocs`'s
 * decoration-time schema when no real DTO exists.
 */
function writableBaseOf(metadata: EntityMetadata<object>): readonly string[] {
  const compositeIdFields = metadata.compositeIdFields;
  const columns = metadata.fields
    .filter((field) => !field.generated && (compositeIdFields !== undefined || field.name !== metadata.idField))
    .map((field) => field.name);
  return [...columns, ...metadata.relations.map((relation) => relation.name)];
}

function graphqlPathFrom(option: KavoGraphQLOption | undefined): string | undefined {
  if (option === undefined || option === false) {
    return undefined;
  }
  if (option === true) {
    return DEFAULT_GRAPHQL_PATH;
  }
  return option.path ?? DEFAULT_GRAPHQL_PATH;
}

/** `mcp: true` mounts the default controller at `POST /mcp`; `{ path }` mounts it at `POST <path>` instead. */
export type KavoMcpOption = boolean | { readonly path?: string };

function mcpPathFrom(option: KavoMcpOption | undefined): string | undefined {
  if (option === undefined || option === false) {
    return undefined;
  }
  if (option === true) {
    return DEFAULT_MCP_PATH;
  }
  return option.path ?? DEFAULT_MCP_PATH;
}

export interface KavoModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  useFactory: (...args: never[]) => KavoModuleOptions | Promise<KavoModuleOptions>;
  inject?: readonly (string | symbol | Type)[];
  /**
   * Fold in what `forFeature()` (no arguments) does — a DI provider under
   * `getKavoServiceToken(Entity)` for every `@Kavo`-decorated class the
   * process has seen — so a normal app needs only this one call. Off by
   * default for the same reason the standalone no-arg `forFeature()` is
   * opt-in: the registry is process-wide, and `@kavo/nest`'s own tests
   * decorate many differently-configured classes against the same entity
   * in one file.
   */
  provideServices?: boolean;
  /**
   * Mounts a default GraphQL controller — every `@Kavo` entity that also
   * called `registerKavoGraphQLTypes` (`@kavo/graphql`), merged onto one
   * schema, with no controller of your own to write. `true` mounts it at
   * `POST /graphql`; `{ path: "api/graphql" }` mounts it there instead.
   * Implies `provideServices` (the merged schema's resolvers need every
   * entity's service as a DI provider to look up via `ModuleRef`, the same
   * requirement `BaseKavoGraphQLController` always has) even if
   * `provideServices` itself is left unset.
   */
  graphql?: KavoGraphQLOption;
  /**
   * Mounts a default MCP controller — every `@Kavo` entity's full standard
   * toolset (`@kavo/mcp`, no per-entity opt-in), collected into one
   * toolset served over the MCP Streamable HTTP transport, with no
   * controller of your own to write. `true` mounts it at `POST /mcp`;
   * `{ path: "api/mcp" }` mounts it there instead. Implies
   * `provideServices` (the toolset's handlers need every entity's service
   * as a DI provider to look up via `ModuleRef`, the same requirement
   * `BaseKavoMcpController` always has) even if `provideServices` itself
   * is left unset. Runs stateless — see `createDefaultMcpController`'s doc
   * comment.
   */
  mcp?: KavoMcpOption;
}

/**
 * The Kavo dynamic module (auto-discovery per issue feedback on the
 * checkpoint app's wiring).
 *
 * - `forRoot`/`forRootAsync` (global): create the Kavo root instance,
 *   register the problem-details exception filter app-wide, and register
 *   `KavoBinder` — an `onModuleInit` pass that uses `@nestjs/core`'s
 *   `DiscoveryService` to find every `@Kavo`-decorated controller already
 *   in the app's module graph (an ordinary Nest `controllers:` array is
 *   enough to put it there) and assign its bound service directly onto
 *   `this[KAVO_SERVICE_PROPERTY]`. No DI provider or explicit list is
 *   needed for this — the generated route methods only ever read that
 *   property at request time, well after `onModuleInit` has run.
 * - `forFeature(controllers)`: registers the controllers (redundant once
 *   they're already in some module's `controllers:` array) and additionally
 *   provides the entity's `KavoService` under `getKavoServiceToken(Entity)`
 *   as a real DI provider — needed only by a controller (or other class)
 *   that constructor-injects that token itself, e.g. to reach the base
 *   service from a fully custom, registry-independent route. `forFeature()`
 *   called with **no arguments** does the same for every `@Kavo`-decorated
 *   class the process has seen so far, with no list at all — the scope that
 *   makes this safe (one config per entity, one Kavo instance per process)
 *   is exactly a normal app, not `@kavo/nest`'s own tests, which always pass
 *   an explicit array. Prefer `boundKavoService(this)` inside a
 *   `@Kavo`-decorated class over either form when the consumer is that same
 *   class.
 * - `{ provideServices: true }` on `forRoot`/`forRootAsync` folds the
 *   no-argument `forFeature()` in directly, so a normal app states its
 *   Kavo config in one call instead of two.
 *
 * The service is a **singleton** either way — the engine threads all
 * per-request state through `KavoContext`, so request scope would only
 * cost throughput.
 */
@Module({})
export class KavoModule {
  static forRoot(
    options: KavoModuleOptions & {
      provideServices?: boolean;
      graphql?: KavoGraphQLOption;
      mcp?: KavoMcpOption;
    } = {},
  ): DynamicModule {
    const { provideServices, graphql, mcp, ...kavoOptions } = options;
    const graphqlPath = graphqlPathFrom(graphql);
    const mcpPath = mcpPathFrom(mcp);
    const serviceProviders =
      provideServices === true || graphqlPath !== undefined || mcpPath !== undefined ? providersFromRegistry() : [];
    return {
      module: KavoModule,
      global: true,
      imports: [DiscoveryModule],
      controllers: [
        ...(graphqlPath !== undefined ? [createDefaultGraphQLController(graphqlPath)] : []),
        ...(mcpPath !== undefined ? [createDefaultMcpController(mcpPath)] : []),
      ],
      providers: [
        { provide: KAVO_MODULE_OPTIONS, useValue: kavoOptions },
        {
          provide: KAVO_INSTANCE,
          useFactory: (resolved: KavoModuleOptions): KavoInstance => createInstance(resolved),
          inject: [KAVO_MODULE_OPTIONS],
        },
        { provide: APP_FILTER, useClass: KavoExceptionFilter },
        KavoBinder,
        ...serviceProviders,
      ],
      exports: [KAVO_INSTANCE, KAVO_MODULE_OPTIONS, ...serviceProviders],
    };
  }

  static forRootAsync(options: KavoModuleAsyncOptions): DynamicModule {
    const graphqlPath = graphqlPathFrom(options.graphql);
    const mcpPath = mcpPathFrom(options.mcp);
    const serviceProviders =
      options.provideServices === true || graphqlPath !== undefined || mcpPath !== undefined
        ? providersFromRegistry()
        : [];
    return {
      module: KavoModule,
      global: true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      controllers: [
        ...(graphqlPath !== undefined ? [createDefaultGraphQLController(graphqlPath)] : []),
        ...(mcpPath !== undefined ? [createDefaultMcpController(mcpPath)] : []),
      ],
      providers: [
        {
          provide: KAVO_MODULE_OPTIONS,
          useFactory: options.useFactory,
          inject: [...(options.inject ?? [])] as never[],
        },
        {
          provide: KAVO_INSTANCE,
          useFactory: (resolved: KavoModuleOptions): KavoInstance => createInstance(resolved),
          inject: [KAVO_MODULE_OPTIONS],
        },
        { provide: APP_FILTER, useClass: KavoExceptionFilter },
        KavoBinder,
        ...serviceProviders,
      ],
      exports: [KAVO_INSTANCE, KAVO_MODULE_OPTIONS, ...serviceProviders],
    };
  }

  /**
   * Called with an explicit array: registers those controllers and, for
   * each, provides its entity's `KavoService` under
   * `getKavoServiceToken(Entity)`.
   *
   * Called with no arguments: provides every entity in the registry `@Kavo`
   * populates at decoration time — no controller list, since the caller
   * already put them in an ordinary `controllers:` array (the
   * `KavoBinder` covers those; this form exists purely for a
   * constructor-injected `getKavoServiceToken`). Fails fast if two
   * different controllers registered the same entity — the provider token
   * is per-entity, so which config wins would otherwise be silently
   * ambiguous.
   */
  static forFeature(controllers?: readonly Type[]): DynamicModule {
    if (controllers === undefined) {
      const providers = providersFromRegistry();
      return { module: KavoModule, providers, exports: providers };
    }
    const providers: Provider[] = controllers.map((controller) => {
      const metadata = Reflect.getMetadata(KAVO_CONTROLLER_METADATA, controller) as KavoControllerMetadata | undefined;
      if (metadata === undefined) {
        throw new ConfigurationException(
          controller.name,
          "forFeature",
          `${controller.name} is not decorated with @Kavo(Entity) — ` +
            "KavoModule.forFeature only accepts @Kavo controllers",
        );
      }
      return serviceProvider(metadata);
    });
    return {
      module: KavoModule,
      controllers: [...controllers],
      providers,
      exports: providers,
    };
  }
}

function providersFromRegistry(): Provider[] {
  const ownerByEntity = new Map<ClassRef, Function>();
  const providers: Provider[] = [];
  for (const [controller, metadata] of getRegisteredKavoControllers()) {
    const existingOwner = ownerByEntity.get(metadata.entity);
    if (existingOwner !== undefined) {
      throw new ConfigurationException(
        metadata.entity.name,
        "forFeature",
        `both '${(existingOwner as Type).name}' and '${(controller as Type).name}' are @Kavo(${metadata.entity.name}) — ` +
          "KavoModule.forFeature() with no arguments needs at most one controller per entity; " +
          "pass an explicit array to disambiguate",
      );
    }
    ownerByEntity.set(metadata.entity, controller);
    providers.push(serviceProvider(metadata));
  }
  return providers;
}

/**
 * One entity's `KavoService`, resolved from the root instance.
 *
 * `KAVO_INSTANCE` is injected **optionally** so that a module graph with a
 * `forFeature` but no `forRoot`/`forRootAsync` fails with a
 * `ConfigurationException` naming the missing call, instead of Nest's
 * "can't resolve dependencies (?)" — which names an internal token the
 * developer never wrote and gives no clue what to add (issue #7).
 */
function serviceProvider(metadata: KavoControllerMetadata): Provider {
  return {
    provide: getKavoServiceToken(metadata.entity),
    useFactory: (kavo: KavoInstance | undefined) => {
      if (kavo === undefined) {
        throw new ConfigurationException(
          metadata.entity.name,
          "forFeature",
          "the Kavo root instance is not in this module graph — " +
            "KavoModule.forFeature only provides per-entity services and needs it; " +
            "add KavoModule.forRoot({ infrastructure }) (or forRootAsync) to your root module's imports",
        );
      }
      return kavo.createCrud(metadata.entity, metadata.config);
    },
    inject: [{ token: KAVO_INSTANCE, optional: true }],
  };
}

/**
 * Closes the gap `@Kavo`'s decoration-time route generation cannot see for
 * itself (issue #221 amends ADR-0029; ADR-0029's per-relation amendment,
 * issue #223, makes the check per-relation): a relation that either omits
 * `write`'s own strategy override or falls back to an entity `arrayMutation`
 * declared nowhere locally, relying on a *global* default to supply one.
 * `declaredArrayMutationStrategy`/`declaredRelationArrayMutationStrategy`
 * (`kavo.decorator.ts`) have no built-in default to fall back on, so
 * decoration time generates **no** synthesized route for such a relation —
 * correctly cautious, since it cannot see the global default. But
 * `createCrud`'s registry, built from the fully resolved settings, registers
 * the operation anyway once the global default resolves a `"replace"` or
 * `"resource"` strategy for that relation — so the operation exists and is
 * callable programmatically, yet no HTTP route ever reaches it. That silent
 * gap is worth failing loudly on at bootstrap rather than shipping an app
 * where a configured write surface is quietly unreachable. (`"jsonPatch"`
 * needs no synthesized route — it reuses `patchOne`'s own route — so it
 * never triggers this check.)
 *
 * This binder is the earliest point both facts are known at once — the
 * decorated entity's own config (which decoration time already used to
 * decide whether to generate a route) and the bound service's fully
 * resolved relation registry (`service.engine.config.relations`, which
 * `createCrud` only produces once real infrastructure and global defaults
 * exist, and which already carries each relation's own *resolved* strategy
 * — `DefaultRelationRegistry`). Plain programmatic (non-`@kavo/nest`) usage
 * has no decoration-time route to disagree with in the first place, so this
 * check lives here rather than in `createCrud` itself.
 *
 * A locally declared strategy — entity-level default or per-relation
 * override — never disagrees with what's resolved: an explicit declaration
 * always wins the merge (ADR-0013's "more specific wins"), so the only way
 * to reach the gap above is the undeclared-and-relying-on-a-global-default
 * case, now checked one relation at a time.
 */
function requireArrayMutationRouteReachable(
  metadata: KavoControllerMetadata,
  service: {
    readonly engine: {
      readonly config: {
        readonly relations: { get(name: string): { readonly write?: string } | undefined };
      };
    };
  },
): void {
  const relationNames = writeOptedInRelationNames(metadata.config?.relations?.edges);
  if (relationNames.length === 0) {
    return;
  }
  const entityDeclared = declaredArrayMutationStrategy(metadata.config);
  const edges = metadata.config?.relations?.edges;
  const unreachable: string[] = [];
  for (const name of relationNames) {
    const declared = declaredRelationArrayMutationStrategy(edges?.[name]?.write, entityDeclared);
    if (declared !== undefined) {
      continue;
    } // an explicit local declaration always matches what resolves
    const resolvedStrategy = service.engine.config.relations.get(name)?.write;
    if (resolvedStrategy !== "replace" && resolvedStrategy !== "resource") {
      continue;
    } // no route needed
    unreachable.push(`${name} (resolves ${JSON.stringify(resolvedStrategy)})`);
  }
  if (unreachable.length === 0) {
    return;
  }
  throw new ConfigurationException(
    metadata.entity.name,
    "arrayMutation",
    `'@Kavo(${metadata.entity.name})' declares no local strategy for its write-opted relation(s) ` +
      `(${unreachable.join(", ")}), so decoration time generated no route for them — but each resolves a ` +
      `real strategy (from a global 'arrayMutation.strategy' default) that 'createCrud' registered as a real ` +
      `operation with no HTTP route to reach it. Declare 'arrayMutation.strategy' on the entity, or ` +
      `'write: { strategy }' on each relation, to generate the matching route`,
  );
}

/**
 * Runs once at `onModuleInit`, after Nest has finished instantiating every
 * controller in the app — late enough that `DiscoveryService` sees the full,
 * real module graph, and still well before the first request, which is all
 * the generated route methods need (they read `KAVO_SERVICE_PROPERTY` at
 * request time, never at construction time).
 *
 * The `app` context extractor rides along on the same pass, for the same
 * reason: routes are generated at decoration time (ADR-0012), long before
 * this module's options exist, so a per-request value that depends on them
 * cannot be baked into the generated method. Binding the *function* here
 * and calling it per request in the handler keeps the module option and the
 * decoration-time route on the two sides of that seam they belong on.
 */
@Injectable()
class KavoBinder implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(KAVO_INSTANCE) private readonly kavo: KavoInstance,
    @Inject(KAVO_MODULE_OPTIONS) private readonly options: KavoModuleOptions,
  ) {}

  onModuleInit(): void {
    const extractAppContext = this.options.app;
    for (const wrapper of this.discovery.getControllers()) {
      const metatype = wrapper.metatype;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (metatype === null || instance === undefined) {
        continue;
      }
      const metadata = Reflect.getMetadata(KAVO_CONTROLLER_METADATA, metatype) as KavoControllerMetadata | undefined;
      if (metadata === undefined) {
        continue;
      }
      const service = this.kavo.createCrud(metadata.entity, metadata.config);
      requireArrayMutationRouteReachable(metadata, service);
      instance[KAVO_SERVICE_PROPERTY] = service;
      instance[KAVO_APP_CONTEXT_PROPERTY] = extractAppContext;

      // The conditional-request Swagger docs (ADR-0020) decoration time
      // couldn't finish — see `applyConditionalRequestDocs`'s doc comment
      // in swagger.ts — now that `service.engine.config` carries the
      // entity's fully resolved settings, global scope included.
      const conditionalDocs = Reflect.getMetadata(KAVO_CONDITIONAL_DOCS_METADATA, metatype) as
        readonly KavoConditionalDocEntry[] | undefined;
      if (conditionalDocs !== undefined) {
        const prototype = metatype.prototype as Record<string, unknown>;
        const dtoResolver = new DefaultDtoResolver(metadata.config?.dto as OperationDtoMap<object> | undefined, {
          create: metadata.config?.create,
          update: metadata.config?.update,
        });
        // The target entity's own metadata for each relation a synthesized
        // schema references — includable ones so `applyResponseSchemaDocs`
        // can name the `x-kavo-includable-ref` marker `registerKavoSchemas`
        // composes into a `$ref` to `<Target>Item`, creatable/updatable ones
        // for `applyBodySchemaDocs`'s `{ id }` reference object (issue #339)
        // — so both can type those fields instead of emitting an untyped `{}`.
        // Resolved once per controller, not per route. `metadataFor` may
        // throw or return `undefined` for a target this root cannot derive
        // metadata for (a `runtime.metadata` wiring, or an infrastructure
        // that only knows routed entities); that relation is then left
        // untyped rather than crashing bootstrap. A null-prototype map so a
        // relation named `constructor`/`hasOwnProperty` can't resolve a
        // bracket lookup to an inherited member and blow up outside the
        // try/catch below.
        const relationTargetMetadata: Record<string, EntityMetadata<object>> = Object.create(null) as Record<
          string,
          EntityMetadata<object>
        >;
        const schemaRelationNames = new Set<string>([
          ...(service.engine.config.include.fields as readonly string[]),
          ...service.engine.metadata.relations.map((relation) => relation.name),
        ]);
        for (const relation of service.engine.metadata.relations) {
          if (!schemaRelationNames.has(relation.name)) {
            continue;
          }
          try {
            const targetMetadata = this.options.infrastructure?.metadataFor(relation.target() as ClassRef<object>);
            if (targetMetadata !== undefined) {
              relationTargetMetadata[relation.name] = targetMetadata as EntityMetadata<object>;
            }
          } catch {
            // Target metadata unresolvable from this root — leave untyped.
          }
        }
        for (const { methodName, descriptor, route } of conditionalDocs) {
          const settings = service.engine.config.settingsFor(descriptor.id);
          applyConditionalRequestDocs(prototype, methodName, descriptor, route, isEtagEnabled(settings.cache));
          // Fallback request-body schema (issue #264) — only when decoration
          // time had no DTO to document (`bodyDtoFor` resolved `null`
          // there too, from the same decoration-time config); re-derived
          // rather than stashed, since it's a pure function of the
          // decoration-time config already sitting in `metadata.config`.
          if (bodyDtoFor(descriptor, dtoResolver) === null) {
            applyBodySchemaDocs(
              prototype,
              methodName,
              descriptor,
              service.engine.metadata,
              {
                creatable:
                  shorthandFieldsOf(dtoResolver.resolve("create", descriptor.id)) ??
                  writableBaseOf(service.engine.metadata),
                updatable:
                  shorthandFieldsOf(dtoResolver.resolve("update", descriptor.id)) ??
                  writableBaseOf(service.engine.metadata),
              },
              relationTargetMetadata,
            );
          }
          // Fallback success-response schema, narrowed to `selectable`
          // (issue #264's response-side counterpart) — `applyResponseSchemaDocs`
          // itself no-ops when a real `item`/`list` DTO or `descriptor.output`
          // already documented this route at decoration time. `includable`
          // lets it emit an optional property per embeddable relation, each
          // deferring to the target's own `<Target>Item` component (ADR-0026
          // decision 4).
          applyResponseSchemaDocs(
            prototype,
            methodName,
            descriptor,
            route,
            service.engine.metadata,
            service.engine.config.select.fields as readonly string[],
            service.engine.config.include.fields as readonly string[],
            relationTargetMetadata,
            dtoResolver,
          );
          // `search[...]` Swagger docs (issue #156) — deferred for the same
          // reason as the conditional-request docs above (`applySearchQueryDocs`'s
          // doc comment in swagger.ts): whether `search` resolved to an
          // object needs the full precedence chain, and `allowed.searchable`
          // is only fully resolved once ORM metadata exists, neither of which
          // `@Kavo` decoration time has.
          applySearchQueryDocs(
            prototype,
            methodName,
            descriptor,
            service.engine.config.search !== false,
            service.engine.config.search !== false ? (service.engine.config.search.fields as readonly string[]) : [],
          );
          // `limit`/`offset` docs (issue #225) — deferred for the same
          // reason as the two above (`applyPaginationDocs`'s doc comment):
          // `pagination.strategy` needs the full precedence chain too.
          applyPaginationDocs(prototype, methodName, descriptor, settings.pagination.strategy);
          // `<Entity>Pagination`/`Include`/`Sort`/`Filter`/`Query` query-shape
          // components (issue #313, issue #314 / ADR-0042) — deferred for the
          // same reason as the passes above: the resolved
          // `allowed.sortable`/`includable`/`filterable`/`selectable`/
          // `searchable` and the precedence-merged `pagination.strategy` /
          // `search` only exist here. The extension
          // `applyQuerySchemaDocs` stamps is hoisted into `components.schemas`
          // by `registerKavoSchemas`.
          applyQuerySchemaDocs(prototype, methodName, descriptor, metadata.entity.name, service.engine.metadata, {
            strategy: settings.pagination.strategy,
            includable: service.engine.config.include.fields as readonly string[],
            sortable: service.engine.config.sort.fields as readonly string[],
            filterable: service.engine.config.filter.fields as readonly string[],
            selectable: service.engine.config.select.fields as readonly string[],
            searchable:
              service.engine.config.search !== false ? (service.engine.config.search.fields as readonly string[]) : [],
            searchEnabled: service.engine.config.search !== false,
          });
          // Retag the always-present `400` as `<Entity>ValidationError`
          // (issue #310) so `registerKavoSchemas` gives each entity its own
          // named component instead of collapsing every `400` onto the
          // shared `KavoProblemDetails`. Rides this bind-time pass only for
          // scheduling; without `forRoot`/`forRootAsync` the `400` stays
          // bare and hoists to `KavoProblemDetails`.
          applyValidationErrorDoc(prototype, methodName, metadata.entity.name);
        }
      }
    }
  }
}

function createInstance(options: KavoModuleOptions): KavoInstance {
  return createKavo({
    ...(options.defaults !== undefined && { defaults: options.defaults }),
    ...(options.infrastructure !== undefined && {
      infrastructure: options.infrastructure,
    }),
    ...(options.paginationStrategies !== undefined && {
      paginationStrategies: options.paginationStrategies,
    }),
    ...(options.realtimeTransports !== undefined && {
      realtimeTransports: options.realtimeTransports,
    }),
    ...(options.cacheStore !== undefined && {
      cacheStore: options.cacheStore,
    }),
  });
}
