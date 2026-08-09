import type { DynamicModule, ModuleMetadata, OnModuleInit, Provider, Type } from "@nestjs/common";
import { Inject, Injectable, Module } from "@nestjs/common";
import { APP_FILTER, DiscoveryModule, DiscoveryService } from "@nestjs/core";
import type { ClassRef, KavoInstance } from "@kavo/core";
import { ConfigurationException, createKavo } from "@kavo/core";
import type { KavoModuleOptions } from "./kavo-options.js";
import type { KavoControllerMetadata } from "./kavo.decorator.js";
import { getRegisteredKavoControllers } from "./kavo.decorator.js";
import { KavoExceptionFilter } from "./kavo-exception.filter.js";
import { createDefaultGraphQLController, DEFAULT_GRAPHQL_PATH } from "./graphql/default-graphql.controller.js";
import { createDefaultMcpController, DEFAULT_MCP_PATH } from "./mcp/default-mcp.controller.js";
import { resolvePrincipalExtractor } from "./principal.js";
import {
  KAVO_INSTANCE,
  KAVO_MODULE_OPTIONS,
  KAVO_CONTROLLER_METADATA,
  KAVO_PRINCIPAL_PROPERTY,
  KAVO_SERVICE_PROPERTY,
  getKavoServiceToken,
} from "./tokens.js";

/** `graphql: true` mounts the default controller at `POST /graphql`; `{ path }` mounts it at `POST <path>` instead. */
export type KavoGraphQLOption = boolean | { readonly path?: string };

function graphqlPathFrom(option: KavoGraphQLOption | undefined): string | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return DEFAULT_GRAPHQL_PATH;
  return option.path ?? DEFAULT_GRAPHQL_PATH;
}

/** `mcp: true` mounts the default controller at `POST /mcp`; `{ path }` mounts it at `POST <path>` instead. */
export type KavoMcpOption = boolean | { readonly path?: string };

function mcpPathFrom(option: KavoMcpOption | undefined): string | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return DEFAULT_MCP_PATH;
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
 * Runs once at `onModuleInit`, after Nest has finished instantiating every
 * controller in the app — late enough that `DiscoveryService` sees the full,
 * real module graph, and still well before the first request, which is all
 * the generated route methods need (they read `KAVO_SERVICE_PROPERTY` at
 * request time, never at construction time).
 *
 * The `principal` extractor rides along on the same pass, for the same
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
    const extractPrincipal = resolvePrincipalExtractor(this.options.principal);
    for (const wrapper of this.discovery.getControllers()) {
      const metatype = wrapper.metatype;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (metatype === null || instance === undefined) continue;
      const metadata = Reflect.getMetadata(KAVO_CONTROLLER_METADATA, metatype) as KavoControllerMetadata | undefined;
      if (metadata === undefined) continue;
      instance[KAVO_SERVICE_PROPERTY] = this.kavo.createCrud(metadata.entity, metadata.config);
      instance[KAVO_PRINCIPAL_PROPERTY] = extractPrincipal;
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
  });
}
