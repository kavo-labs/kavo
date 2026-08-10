import { Body, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseInterceptors } from "@nestjs/common";
import type {
  ClassRef,
  DefaultKavoService,
  EntityConfig,
  EntityInput,
  KavoCallOptions,
  OperationDescriptor,
  OperationId,
  OperationsConfig,
  QueryContext,
  RequestPreconditions,
  StandardOperationId,
} from "@kavo/core";
import { ConfigurationException, createOperationRegistry } from "@kavo/core";
import type { KavoHttpMethod, KavoRouteOptions } from "./operation-metadata.js";
import type { OverrideMetadata } from "./override.decorator.js";
import type { KavoPrincipalExtractor, KavoPrincipalRequest } from "./principal.js";
import { ConditionalRequest } from "./conditional-request.decorator.js";
import { KavoResponseInterceptor } from "./kavo-response.interceptor.js";
import {
  KAVO_CONTROLLER_METADATA,
  KAVO_OVERRIDE_METADATA,
  KAVO_PRINCIPAL_PROPERTY,
  KAVO_SERVICE_PROPERTY,
} from "./tokens.js";
import { WireQueryPipe } from "./wire-query.pipe.js";
import { applySwaggerMetadata } from "./swagger.js";

/** What `@Kavo` records on the controller for `KavoModule.forFeature`. */
export interface KavoControllerMetadata {
  readonly entity: ClassRef;
  readonly config?: EntityConfig<object>;
}

/**
 * Every `@Kavo`-decorated class, in decoration order — populated as a side
 * effect of the decorator running at class-definition time (import time),
 * which is always before any `KavoModule.forRoot`/`forRootAsync` call
 * (nested inside `@Module({...})`, which only runs after every controller
 * file it imports has finished evaluating). `KavoModule.forFeature()`
 * called with no arguments reads this to build one DI provider per
 * registered entity with no explicit list — the process-wide scope is why
 * this stays internal rather than something a normal app reaches for
 * directly, and why `@kavo/nest`'s own tests, which decorate many
 * differently-configured classes against the same entity in one file,
 * always pass `forFeature` an explicit array instead.
 */
const registeredKavoControllers = new Map<Function, KavoControllerMetadata>();

/** @internal used by `KavoModule.forFeature()`'s no-argument form. */
export function getRegisteredKavoControllers(): ReadonlyMap<Function, KavoControllerMetadata> {
  return registeredKavoControllers;
}

/**
 * Every `@Kavo`-decorated entity the process has seen, in decoration
 * order — the public, read-only counterpart of the registry above. Meant
 * for a second binding (e.g. a GraphQL schema) that wants to mirror
 * whatever entities are already exposed over REST without a hand-kept
 * list of its own. Same process-wide scope and caveats as
 * `KavoModule.forFeature()`'s no-arg form: if two controllers register the
 * same entity, both appear here — this function does not dedupe or throw,
 * since unlike `forFeature` it never has to pick one config to bind a DI
 * token to.
 */
export function getKavoEntities(): readonly KavoControllerMetadata[] {
  return Array.from(registeredKavoControllers.values());
}

/**
 * The default route shape of each standard operation. `Partial`
 * because the disabled batch operations have no route yet; keyed by the
 * union so a misspelled id cannot sit here unread.
 */
const STANDARD_ROUTES: Readonly<
  Partial<Record<StandardOperationId, { method: KavoHttpMethod; path: string; status: number }>>
> = {
  createOne: { method: "POST", path: "", status: 201 },
  findMany: { method: "GET", path: "", status: 200 },
  findOne: { method: "GET", path: ":id", status: 200 },
  updateOne: { method: "PUT", path: ":id", status: 200 },
  patchOne: { method: "PATCH", path: ":id", status: 200 },
  deleteOne: { method: "DELETE", path: ":id", status: 204 },
  // Soft delete. These entries enable from config alone
  // (ADR-0013), and the generator needed no change to pick them up — the
  // registry is the source of truth.
  restoreOne: { method: "PATCH", path: ":id/restore", status: 200 },
  purgeOne: { method: "DELETE", path: ":id/purge", status: 204 },
};

/**
 * Write operations that target a row by id and take no request body.
 * Without this, `PATCH /:id/restore` would be given a `@Body`
 * parameter that is always empty.
 */
const BODYLESS_WRITES: ReadonlySet<StandardOperationId> = new Set<StandardOperationId>(["restoreOne", "purgeOne"]);

/**
 * Nest's own route-argument metadata key (`@nestjs/common/constants`'
 * `ROUTE_ARGS_METADATA`), inlined rather than deep-imported: the subpath
 * isn't part of `@nestjs/common`'s declared type exports (no `exports` map
 * restricts it at runtime, but `tsc`'s Node16 resolution can't see the
 * `.d.ts` through it), and this exact key is what every `@Param`/`@Query`/
 * `@Body` decorator reads and writes — stable across Nest's own major
 * versions, since third-party CRUD libraries already depend on it.
 */
const NEST_ROUTE_ARGS_METADATA = "__routeArguments__";

const METHOD_DECORATORS: Record<KavoHttpMethod, (path: string) => MethodDecorator> = {
  GET: Get,
  POST: Post,
  PUT: Put,
  PATCH: Patch,
  DELETE: Delete,
};

interface ResolvedRoute {
  readonly method: KavoHttpMethod;
  readonly path: string;
  readonly status: number;
  readonly hasIdParam: boolean;
}

/**
 * `@Kavo(UserEntity)` — registry-driven route generation.
 *
 * The decorator builds the entity's operation registry (the same
 * `createOperationRegistry` the engine uses) and generates one route per
 * **enabled** entry: disabled operations get no route, and
 * `meta.routes.enabled: false` keeps an operation service-only. A new
 * standard operation needs a default shape in `STANDARD_ROUTES` and, if it
 * takes no body, an entry in `BODYLESS_WRITES` — both tables are keyed by
 * `StandardOperationId`, so a typo fails the build. `makeHandler` needs
 * nothing: it builds one handler shape from the descriptor.
 *
 * A **custom** operation (an `operations` key outside the standard eight,
 * issue #145) needs nothing here either: it is an ordinary registry entry,
 * so it is generated by the same loop, from its own `meta.routes`, and
 * every rule below applies to it unchanged.
 *
 * **Manual-method-wins:** a hand-written controller method whose name
 * matches an operation id suppresses that generated route entirely — no
 * conflicts, no config, for the genuine one-off. **`@Override(operationId?)`**
 * is the additive middle path: the decorated method still gets the
 * registry's route (method, path, status, params, Swagger), only the
 * function backing it changes — resolved first, ahead of manual-method-wins,
 * so a decorated method never falls through to plain name-matching.
 *
 * **A replaced method owns its own conditional-request handling.** Kavo
 * enforces `If-Match` inside the engine (ADR-0020), so a method that does
 * not reach the engine cannot have it enforced for it: a hand-written or
 * `@Override`'d `updateOne` that ignores its `preconditions` parameter
 * accepts an `If-Match` header and writes anyway. That is the price of
 * replacing the function, and it is not silent by accident — the
 * `ConditionalRequest` parameter is applied to overrides too, so the
 * tokens are handed to the method. Forward them, either as
 * `service.<op>(…, { preconditions })` on the typed surface or by
 * returning `service.engine.execute({ …, preconditions })`, which
 * additionally puts the `ETag` back on the response. The same goes for the
 * principal: a generated route resolves it from the module's `principal`
 * extractor per request, a replaced method must pass it on itself, and
 * `boundKavoPrincipal(this, request)` is how it reaches the extractor the
 * app configured rather than re-deciding where the caller lives.
 *
 * Route generation happens at decoration time (class definition), which is
 * what lets Nest's router see the methods during its normal controller
 * scan — Nest maps routes before any module lifecycle hook runs, so this
 * is the only moment that works. The service instance arrives later:
 * `KavoModule`'s discovery binder finds every `@Kavo`-decorated controller
 * at `onModuleInit` (via `@nestjs/core`'s `DiscoveryService`, so no explicit
 * registration list is needed) and assigns `this[KAVO_SERVICE_PROPERTY]`
 * directly — no DI provider or constructor injection involved.
 *
 * The generic parameters are inferred and exist purely to typecheck the
 * call site: allowlist and relation-edge keys, DTO slots and overridden
 * handlers are all checked against the entity, with no manual generic
 * argument. The chain mirrors `createCrud`'s — `Entity` is inferred from
 * `entity` alone, while each DTO slot stays its own inference site, so
 * registering one slot does not constrain the others; `Ops` is the
 * `operations` literal, which is what lets a key outside the standard eight
 * declare a custom operation (issue #145). Route generation itself is
 * entity-agnostic, so everything below consumes the erased view.
 */
export function Kavo<
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
): ClassDecorator {
  return (target) => {
    const controller = target as unknown as {
      prototype: Record<string, unknown>;
    };
    const erasedConfig = config as EntityConfig<object> | undefined;
    const metadata: KavoControllerMetadata = { entity, config: erasedConfig };
    Reflect.defineMetadata(KAVO_CONTROLLER_METADATA, metadata, target);
    registeredKavoControllers.set(target, metadata);

    const registry = createOperationRegistry(erasedConfig, undefined, undefined, entity.name);
    const overrides = collectOverrides(controller.prototype, entity.name, registry);

    for (const descriptor of registry.all()) {
      if (!descriptor.enabled) continue;
      const route = resolveRoute(descriptor);
      const overrideMethodName = overrides.get(descriptor.id);
      if (route === null) {
        if (overrideMethodName !== undefined) {
          throw new ConfigurationException(
            entity.name,
            `override.${descriptor.id}`,
            `'${overrideMethodName}' is @Override("${descriptor.id}"), but that operation is service-only ` +
              `(meta.routes.enabled: false) and generates no route to override`,
          );
        }
        continue;
      }
      if (overrideMethodName === undefined) {
        const methodName = descriptor.id;
        if (Object.prototype.hasOwnProperty.call(controller.prototype, methodName)) {
          continue; // manual-method-wins
        }
        defineRoute(controller.prototype, methodName, descriptor, route);
        applySwaggerMetadata(controller.prototype, methodName, descriptor, route, entity, erasedConfig);
      } else {
        assertNoOwnParamMetadata(controller.prototype, overrideMethodName, entity.name, descriptor.id);
        applyRouteDecorators(controller.prototype, overrideMethodName, descriptor, route);
        applySwaggerMetadata(controller.prototype, overrideMethodName, descriptor, route, entity, erasedConfig);
      }
    }
  };
}

/**
 * Builds the `operationId -> methodName` map from every `@Override`-decorated
 * method on the prototype, failing fast at decoration time (ADR-0012's only
 * moment) on the two ways this can be misconfigured: two methods claiming
 * the same operation, or an override naming an operation id that the
 * registry doesn't have enabled — a silent no-op override is a footgun.
 */
function collectOverrides(
  prototype: Record<string, unknown>,
  entityName: string,
  registry: { get(id: OperationId): OperationDescriptor<object> | undefined },
): ReadonlyMap<OperationId, string> {
  const overrides = new Map<OperationId, string>();
  for (const methodName of Object.getOwnPropertyNames(prototype)) {
    if (methodName === "constructor") continue;
    const metadata = Reflect.getMetadata(KAVO_OVERRIDE_METADATA, prototype, methodName) as OverrideMetadata | undefined;
    if (metadata === undefined) continue;
    const existing = overrides.get(metadata.operationId);
    if (existing !== undefined) {
      throw new ConfigurationException(
        entityName,
        `override.${metadata.operationId}`,
        `both '${existing}' and '${methodName}' are @Override("${metadata.operationId}") — only one method may override a given operation`,
      );
    }
    overrides.set(metadata.operationId, methodName);
  }
  for (const [operationId, methodName] of overrides) {
    const descriptor = registry.get(operationId);
    if (descriptor === undefined || !descriptor.enabled) {
      throw new ConfigurationException(
        entityName,
        `override.${operationId}`,
        `'${methodName}' is @Override("${operationId}"), but '${operationId}' is absent or disabled`,
      );
    }
  }
  return overrides;
}

/**
 * `@Override`'d methods must accept Kavo's own `@Param`/`@Query`/`@Body`
 * wiring, not their own — Nest's route-arg metadata for a method is one
 * object keyed by param index, so a method's own decorator would either
 * collide with or silently shadow the one Kavo applies next.
 */
function assertNoOwnParamMetadata(
  prototype: Record<string, unknown>,
  methodName: string,
  entityName: string,
  operationId: OperationId,
): void {
  const existing = Reflect.getMetadata(NEST_ROUTE_ARGS_METADATA, prototype.constructor, methodName);
  if (existing !== undefined) {
    throw new ConfigurationException(
      entityName,
      `override.${operationId}`,
      `'${methodName}' must not declare its own @Param/@Query/@Body — @Kavo applies the operation's own param wiring`,
    );
  }
}

function resolveRoute(descriptor: OperationDescriptor<object>): ResolvedRoute | null {
  const options: KavoRouteOptions = descriptor.meta.routes ?? {};
  if (options.enabled === false) return null; // service-only
  // A custom id (`operations.markPaidOne`, issue #145) is absent from the
  // table by design and falls back to the defaults below — the registry's
  // own genericity (ADR-0006). Those defaults are deliberately conservative
  // rather than clever: `POST /<controller>/<operation id>`, because a
  // custom operation is a write against the collection until its
  // `meta.routes` says otherwise, and its id is the only name Kavo has for
  // it.
  const standard = STANDARD_ROUTES[descriptor.id as StandardOperationId];
  const method = options.method ?? standard?.method ?? "POST";
  const path = options.path ?? standard?.path ?? descriptor.id;
  const status = options.successStatus ?? standard?.status ?? (method === "POST" ? 201 : 200);
  return { method, path, status, hasIdParam: path.includes(":id") };
}

function defineRoute(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  route: ResolvedRoute,
): void {
  const handler = makeHandler(descriptor, route);
  Object.defineProperty(handler, "name", { value: methodName });
  Object.defineProperty(prototype, methodName, {
    value: handler,
    writable: true,
    configurable: true,
  });
  applyRouteDecorators(prototype, methodName, descriptor, route);
}

/**
 * The Nest wiring a route needs regardless of what backs it: param
 * decorators, the success status, and the HTTP-verb decorator. Shared
 * between a freshly generated handler (`defineRoute`) and an `@Override`'d
 * method already on the prototype — the two paths carry identical route
 * metadata by construction, not by convention.
 */
function applyRouteDecorators(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  route: ResolvedRoute,
): void {
  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  applyParamDecorators(prototype, methodName, descriptor, route);
  HttpCode(route.status)(prototype, methodName, propertyDescriptor);
  METHOD_DECORATORS[route.method](route.path)(prototype, methodName, propertyDescriptor);
  // The envelope unwrap / `ETag` / `304` interceptor (ADR-0020), applied
  // to **both** paths. On a generated handler it is the only thing that
  // turns the engine's `KavoResponse` into an HTTP response. On an
  // `@Override`'d one it is a no-op unless that method returns an engine
  // envelope of its own — `isKavoResponse` guards it — which is exactly
  // how an override opts back in to the header: return
  // `service.engine.execute(...)` rather than the typed service's
  // unwrapped item. An *instance* rather than a class, so it needs no DI
  // registration in whatever module the controller ends up in.
  UseInterceptors(new KavoResponseInterceptor())(prototype, methodName, propertyDescriptor);
}

/**
 * Parameter layout per generated method (fixed positions):
 * reads → (id?, query, preconditions, request);
 * writes → (id?, body?, preconditions, request).
 * Nest's param decorators are plain functions; applying them
 * programmatically writes the same route metadata the
 * `@Param`/`@Query`/`@Body` syntax would.
 *
 * The two trailing parameters are unconditional so the two paths
 * (generated and `@Override`'d) keep identical route metadata: an
 * override that doesn't want `If-Match`/`If-None-Match` or the raw request
 * simply declares fewer parameters, which is already how it opts out of
 * the others. They are last, and in this order, so that adding the request
 * left every signature written against the older layout intact.
 *
 * The request is here for one reason: the principal. Routes are generated
 * at decoration time (ADR-0012), so the module-scope `principal` extractor
 * cannot be baked into the generated method — the handler resolves it per
 * request from the controller instance instead, and needs the request to
 * run it against.
 */
function applyParamDecorators(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  route: ResolvedRoute,
): void {
  let index = 0;
  if (route.hasIdParam) {
    Param("id")(prototype, methodName, index++);
  }
  if (descriptor.kind === "read") {
    Query(new WireQueryPipe())(prototype, methodName, index++);
  } else if (takesBody(descriptor, route)) {
    Body()(prototype, methodName, index++);
  }
  ConditionalRequest()(prototype, methodName, index++);
  Req()(prototype, methodName, index++);
}

/** Writes that carry a request body — the mirror of `BODYLESS_WRITES`. */
function takesBody(descriptor: OperationDescriptor<object>, route: ResolvedRoute): boolean {
  return usesBody(route.method) && !BODYLESS_WRITES.has(descriptor.id as StandardOperationId);
}

function usesBody(method: KavoHttpMethod): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

type BoundController = Record<string, unknown> & {
  [KAVO_SERVICE_PROPERTY]: DefaultKavoService<object>;
  /** `undefined` unless `KavoModule` was configured with a `principal` option. */
  [KAVO_PRINCIPAL_PROPERTY]?: KavoPrincipalExtractor | undefined;
};

/**
 * One handler shape for every operation, standard or custom: build the
 * transport-agnostic `KavoRequest` from the fixed parameter layout
 * `applyParamDecorators` wrote, and return the engine's `KavoResponse`
 * untouched for `KavoResponseInterceptor` to unwrap.
 *
 * It goes through `service.engine.execute` rather than the typed
 * `DefaultKavoService` methods — which is the same pipeline, since those
 * methods are `execute` plus an unwrap — because the ETag and the
 * not-modified flag live on the envelope those methods discard
 * (ADR-0020). One arm instead of nine also means the parameter layout is
 * read from exactly one place, the one that wrote it.
 *
 * The `options` it builds are the one thing that is not read off a
 * parameter: `KavoCallOptions.principal` is core's only channel for the
 * caller's identity, and it is filled from the module-scope extractor the
 * binder left on this controller (`callOptionsFor`).
 */
function makeHandler(
  descriptor: OperationDescriptor<object>,
  route: ResolvedRoute,
): (...args: unknown[]) => Promise<unknown> {
  const id = descriptor.id;
  const isRead = descriptor.kind === "read";
  // Mirrors `applyParamDecorators` exactly: a read takes a query and never
  // a body, whatever verb it is routed under.
  const hasBody = !isRead && takesBody(descriptor, route);

  return async function (this: BoundController, ...args: unknown[]) {
    let index = 0;
    const requestId = route.hasIdParam ? (args[index++] as string) : null;
    const query = isRead ? args[index++] : null;
    const body = hasBody ? args[index++] : null;
    const preconditions = (args[index++] ?? null) as RequestPreconditions | null;
    const request = args[index] as KavoPrincipalRequest | undefined;
    return this[KAVO_SERVICE_PROPERTY].engine.execute({
      operation: id,
      id: requestId,
      body: (body ?? null) as never,
      query: (query ?? null) as never,
      options: callOptionsFor(this, request),
      preconditions,
    });
  };
}

/**
 * The per-call scope a generated route contributes: the caller's
 * principal, and nothing else — everything else about the request is the
 * request's own data, not an override of configuration.
 *
 * `null` when the app configured no extractor, which is the request an
 * unconfigured route has always sent, so `KavoContext.principal` stays
 * `null` for an app that never opts in. Resolved per request, from the
 * controller instance the binder wrote it onto: nothing here is memoized,
 * so one caller's identity cannot survive into the next caller's request.
 */
function callOptionsFor(
  controller: BoundController,
  request: KavoPrincipalRequest | undefined,
): KavoCallOptions | null {
  const extractPrincipal = controller[KAVO_PRINCIPAL_PROPERTY];
  if (extractPrincipal === undefined || request === undefined) return null;
  return { principal: extractPrincipal(request) };
}
