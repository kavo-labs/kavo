import {
  Body,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UseInterceptors,
} from "@nestjs/common";
import { isObservable } from "rxjs";
import type {
  ClassRef,
  DefaultKavoService,
  DtoResolver,
  EntityConfig,
  EntityInput,
  KavoCallOptions,
  KavoResponse,
  OperationDescriptor,
  OperationDtoMap,
  OperationId,
  OperationsConfig,
  QueryContext,
  RequestPreconditions,
  StandardOperationId,
} from "@kavo/core";
import type { ArrayMutationRelationEntry, ArrayMutationStrategy } from "@kavo/core";
import {
  ConfigurationException,
  computeEtag,
  createOperationRegistry,
  DefaultDtoResolver,
  isEtagEnabled,
  registerArrayMutationOperations,
} from "@kavo/core";
import type { KavoHttpMethod, KavoRouteOptions } from "./operation-metadata.js";
import type { OverrideMetadata } from "./override.decorator.js";
import type { KavoPrincipalExtractor, KavoPrincipalRequest } from "./principal.js";
import { ConditionalRequest } from "./conditional-request.decorator.js";
import { KavoResponseInterceptor, isKavoResponse } from "./kavo-response.interceptor.js";
import {
  KAVO_CONDITIONAL_DOCS_METADATA,
  KAVO_CONTROLLER_METADATA,
  KAVO_OPERATION_METADATA,
  KAVO_OVERRIDE_METADATA,
  KAVO_PRINCIPAL_PROPERTY,
  KAVO_SERVICE_PROPERTY,
} from "./tokens.js";
import { WireQueryPipe } from "./wire-query.pipe.js";
import { applySwaggerMetadata, bodyDtoFor } from "./swagger.js";
import { entityHasValidationMetadata } from "./load-class-validator.js";

/**
 * One route whose conditional-request Swagger docs (ADR-0020) `@Kavo`
 * couldn't finish at decoration time — see `applyConditionalRequestDocs`'s
 * doc comment in `swagger.ts`. Stashed under `KAVO_CONDITIONAL_DOCS_METADATA`
 * for `KavoModule`'s discovery binder to finish once the entity's config is
 * fully resolved.
 */
export interface KavoConditionalDocEntry {
  readonly methodName: string;
  readonly descriptor: OperationDescriptor<object>;
  readonly route: ResolvedRoute;
}

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
 * An entity's own declared `arrayMutation.strategy` — the one view
 * decoration time (`@Kavo`, this file) has, blind to global defaults the
 * same way it's already blind to ORM cardinality metadata (ADR-0012,
 * ADR-0013's two-stage split). `BUILT_IN_DEFAULTS` carries no strategy
 * (issue #221 amends ADR-0029), so an entity that never declares
 * `arrayMutation` resolves to `undefined` here — decoration time generates
 * no synthesized route for it, rather than assuming `"replace"`.
 *
 * Exported so `KavoModule`'s discovery binder (`kavo.module.ts`) can
 * re-derive the exact same value once the entity's fully resolved strategy
 * is also known, and catch the gap decoration time cannot see for itself: an
 * entity that omits `arrayMutation` while relying on a *global* default that
 * resolves to `"replace"`/`"resource"` gets no route generated for it at all
 * unless it declares the strategy itself.
 */
export function declaredArrayMutationStrategy(
  config: EntityConfig<object> | undefined,
): "replace" | "jsonPatch" | "resource" | false | undefined {
  const declared = config?.arrayMutation;
  return declared === false ? false : declared?.strategy;
}

/**
 * The declared strategy for **one** relation (ADR-0029's per-relation
 * amendment, issue #223) — `write: { strategy }` names its own,
 * unconditionally (decoration time is optimistic here, the same way it's
 * already blind to whether that strategy actually agrees with a real
 * `arrayMutation: false`; `DefaultRelationRegistry` rejects that
 * contradiction at bootstrap, once real settings exist). `write: true`
 * inherits the entity's own declared default (`declaredArrayMutationStrategy`
 * above) — `undefined` if the entity declares none, exactly the "no route
 * generated" caution that function already documents.
 */
export function declaredRelationArrayMutationStrategy(
  // Loosely typed to match `EntityConfig`'s `DeepPartial<KavoSettings>`
  // shape (`strategy` optional even inside the object form), not
  // `RelationEdgeSettings["write"]`'s own resolved-settings shape.
  write: boolean | { readonly strategy?: ArrayMutationStrategy } | undefined,
  entityDeclared: "replace" | "jsonPatch" | "resource" | false | undefined,
): ArrayMutationStrategy | undefined {
  if (typeof write === "object" && write !== null) return write.strategy;
  if (write !== true) return undefined;
  return entityDeclared === false ? undefined : entityDeclared;
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
 * **A replaced method owns the precondition, but not the `ETag`.** Kavo
 * enforces `If-Match` inside the engine (ADR-0020), so a method that does
 * not reach the engine cannot have it enforced for it: a hand-written or
 * `@Override`'d `updateOne` that ignores its `preconditions` parameter
 * accepts an `If-Match` header and writes anyway. That is the price of
 * replacing the function, and it is not silent by accident — the
 * `ConditionalRequest` parameter is applied to overrides too, so the
 * tokens are handed to the method. Forward them, either as
 * `service.<op>(…, { preconditions })` on the typed surface or by
 * returning `service.engine.execute({ …, preconditions })`.
 *
 * The `ETag` half is *not* the method's to arrange: `applyOverrideEtag`
 * hashes a bare return, so an override delegating to the typed service
 * still serves the tag a generated route would (ADR-0027). Before that,
 * the header simply went missing and the host framework's own weak tag
 * stood in for it — which looked like working conditional requests and
 * guarded nothing (#186). The same goes for the
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
    // Sub-collection operations (`arrayMutation`'s `replace` and `resource`
    // strategies, ADR-0014 and ADR-0029's resource amendment): synthesized
    // from `relations.edges` rather than declared in `operations`, so
    // they're registered here, post-hoc, the same way `createCrud` registers
    // them onto the engine's registry (ADR-0013 — both builds read the same
    // entity-level config). No `handlers`: like every other entry this
    // registry builds, it exists for route generation only.
    //
    // Gated per relation on its own declared strategy (ADR-0029's
    // per-relation amendment, issue #223) — `write: true` falls back to the
    // entity's own declared `arrayMutation.strategy`, `write: { strategy }`
    // names one directly. Either way this is the only view decoration time
    // has (ADR-0012), blind to global defaults exactly the way it's already
    // blind to ORM cardinality metadata (ADR-0013's two-stage split).
    // `"jsonPatch"` (ADR-0029's jsonPatch amendment) reuses `patchOne`'s
    // existing `PATCH /:id` route instead of a synthesized one, so a
    // relation declared that way generates no route here. A relation whose
    // declared strategy comes out `undefined` — entity declares no default
    // and this relation names none of its own — gets no synthesized route
    // either, even if a *global* default would resolve one at `createCrud`:
    // `KavoModule`'s discovery binder (`kavo.module.ts`) re-derives the same
    // per-relation value once both the decorated config and the fully
    // resolved strategy are known, and fails bootstrap loudly on that gap
    // rather than silently leaving the resolved operation unreachable over
    // HTTP.
    const entityDeclaredStrategy = declaredArrayMutationStrategy(erasedConfig);
    const routedRelations: ArrayMutationRelationEntry[] = [];
    for (const [name, edge] of Object.entries(erasedConfig?.relations?.edges ?? {})) {
      const declared = declaredRelationArrayMutationStrategy(edge?.write, entityDeclaredStrategy);
      if (declared === "replace" || declared === "resource") {
        routedRelations.push({ name, strategy: declared });
      }
    }
    if (routedRelations.length > 0) {
      registerArrayMutationOperations(registry, routedRelations, entity.name);
    }
    const overrides = collectOverrides(controller.prototype, entity.name, registry);
    const conditionalDocs: KavoConditionalDocEntry[] = [];

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
        defineRoute(controller.prototype, methodName, descriptor, route, erasedConfig, entity);
        applySwaggerMetadata(controller.prototype, methodName, descriptor, route, entity, erasedConfig);
        conditionalDocs.push({ methodName, descriptor, route });
      } else {
        assertNoOwnParamMetadata(controller.prototype, overrideMethodName, entity.name, descriptor.id);
        applyOverrideEtag(controller.prototype, overrideMethodName, descriptor);
        applyRouteDecorators(controller.prototype, overrideMethodName, descriptor, route);
        applySwaggerMetadata(controller.prototype, overrideMethodName, descriptor, route, entity, erasedConfig);
        conditionalDocs.push({ methodName: overrideMethodName, descriptor, route });
      }
    }
    Reflect.defineMetadata(KAVO_CONDITIONAL_DOCS_METADATA, conditionalDocs, target);
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
 * Gives an `@Override`'d single-item route the `ETag` a generated one
 * carries (ADR-0027).
 *
 * The interceptor that sets the header only acts on an engine envelope, and
 * the natural way to write an override is to delegate to the typed service
 * — `this.base.patchOne(id, body, { principal })` — which discards the
 * envelope by design. So the override returned a bare item, the interceptor
 * left it alone, and **the host framework filled in its own weak tag**.
 * Express's default is convincing: reads carry an `ETag`, `If-None-Match`
 * answers `304`, and the tag changes when the body does. Three of the four
 * observable behaviours are right. The missing one is the `412`, which is
 * the only one that protects data, so an application checking "do
 * conditional requests work?" by hand saw them pass while every `If-Match`
 * write was a silent lost update (#186).
 *
 * Promoting a bare return to an envelope here fixes that at the one point
 * that can see both the operation's config and the value actually being
 * served. An override that already returns `service.engine.execute(...)` is
 * untouched, and so is one on a `many` operation, since a collection has no
 * ETag (ADR-0020).
 *
 * **What this does not do is evaluate `If-Match`.** That happens inside the
 * engine, against a canonical read, and only when the override forwards its
 * `preconditions` parameter. What changes is that forwarding now *works*:
 * previously the client held the host framework's tag, which could never
 * equal the engine's content hash, so forwarding turned a silent no-op into
 * a permanent `412`.
 */
function applyOverrideEtag(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
): void {
  // A collection response has no tag to give: a list's identity spans
  // pagination, sort and filter, which ADR-0020 leaves out of scope.
  if (descriptor.cardinality === "many") return;
  const original = prototype[methodName] as (this: unknown, ...args: unknown[]) => unknown;
  async function promoted(this: Partial<BoundController>, ...args: unknown[]): Promise<unknown> {
    const result = (await original.apply(this, args)) as unknown;
    // An envelope is already tagged; `null`/`undefined` is a void operation
    // (`deleteOne`), which has no representation to hash.
    if (result === null || result === undefined || isKavoResponse(result)) return result;
    // Values Nest resolves *after* the handler returns. Wrapping an
    // Observable in an envelope is the one way this function can break a
    // working route outright: `InterceptorsConsumer.transformDeferred`
    // flattens a handler result that *is* a Promise or an Observable, and an
    // Observable nested one level down inside a plain object is not
    // flattened by anything — the body ships as `{}`. `StreamableFile`
    // survives the round trip but would be hashed, which is meaningless work
    // over a file handle's internals and a plausible cycle for
    // `canonicalize`. Neither is a representation, so neither is tagged.
    if (isObservable(result) || result instanceof StreamableFile) return result;
    const service = this[KAVO_SERVICE_PROPERTY];
    // Unbound (a controller outside `KavoModule`'s discovery) means there
    // is no config to consult, and guessing `etag: true` would add a header
    // the app may have turned off. Leave it exactly as the override wrote it.
    if (service === undefined) return result;
    if (!isEtagEnabled(service.engine.config.settingsFor(descriptor.id).cache)) return result;
    return {
      operation: descriptor.id,
      item: result,
      list: null,
      etag: await computeEtag(result),
      // `If-None-Match` is answered by the engine against its own
      // representation. This wrapper never saw the request's preconditions
      // — they went to the override — so it reports the tag and nothing more.
      // The host framework may still answer `304` off the header this sets;
      // ADR-0027 records that as the deliberate limit.
      notModified: false,
    } satisfies KavoResponse;
  }
  Object.defineProperty(promoted, "name", { value: methodName });
  copyFunctionMetadata(original, promoted);
  Object.defineProperty(prototype, methodName, { value: promoted, writable: true, configurable: true });
}

/**
 * Move every `Reflect` metadata key from the original method to the
 * replacement, which is what makes replacing it safe.
 *
 * Nest keys method-level metadata on the **function object**, not on the
 * prototype-and-name pair: `SetMetadata` writes to `descriptor.value`, and so
 * do `UseGuards`, `UseInterceptors`, `UseFilters`, `UsePipes`, `Version`,
 * `Header`, `Sse` and every `@nestjs/swagger` method decorator. The read side
 * matches — `PathsExplorer` takes `instance[methodName]` and reflects off
 * whatever function is there now.
 *
 * Method decorators run at class-definition time, before the `@Kavo` class
 * decorator, so an app's metadata is already on the original. Swapping in a
 * bare function drops all of it, and the failure is silent and severe: an
 * `@Override` carrying `@UseGuards(TenantGuard)` — which is exactly the
 * shape #186's own reproduction describes, since overriding is the
 * documented workaround for row scoping having no seam (#138) — would serve
 * the route with its guard removed.
 *
 * This is `RouterExplorer.copyMetadataToCallback`'s approach, and the call
 * order around it matters: copying *before* `applyRouteDecorators` means
 * Kavo's own `UseInterceptors` appends onto the copied array through
 * `extendArrayMetadata`, so `KavoResponseInterceptor` stays innermost.
 */
function copyFunctionMetadata(from: object, to: object): void {
  for (const key of Reflect.getMetadataKeys(from)) {
    Reflect.defineMetadata(key, Reflect.getMetadata(key, from) as unknown, to);
  }
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

/** `meta.arrayMutation.action` → HTTP method, ADR-0029's resource amendment's four sub-collection actions. */
const ARRAY_MUTATION_METHODS: Readonly<Record<"replace" | "list" | "add" | "remove", KavoHttpMethod>> = {
  replace: "PUT",
  list: "GET",
  add: "POST",
  remove: "DELETE",
};

function resolveRoute(descriptor: OperationDescriptor<object>): ResolvedRoute | null {
  const options: KavoRouteOptions = descriptor.meta.routes ?? {};
  if (options.enabled === false) return null; // service-only
  // A `replace`/`list`/`add`/`remove<Relation>` operation Kavo itself
  // synthesized (`registerArrayMutationOperations`, ADR-0014's `replace`
  // strategy and ADR-0029's resource amendment) has no entry in
  // `STANDARD_ROUTES` — it isn't a standard id, and there is no static
  // table to key a *dynamic*, per-relation id against. Its shape comes from
  // the relation name and action on `meta.arrayMutation` instead, the same
  // way a standard id's shape comes from `STANDARD_ROUTES`.
  const arrayMutation = descriptor.meta.arrayMutation;
  if (arrayMutation !== undefined) {
    const method = options.method ?? ARRAY_MUTATION_METHODS[arrayMutation.action];
    const path = options.path ?? `:id/${arrayMutation.relation}`;
    const status = options.successStatus ?? 200;
    return { method, path, status, hasIdParam: path.includes(":id") };
  }
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
  config: EntityConfig<object> | undefined,
  entity: ClassRef<object>,
): void {
  const handler = makeHandler(descriptor, route);
  Object.defineProperty(handler, "name", { value: methodName });
  Object.defineProperty(prototype, methodName, {
    value: handler,
    writable: true,
    configurable: true,
  });
  const dtoResolver = new DefaultDtoResolver(config?.dto as OperationDtoMap<object> | undefined);
  applyRouteDecorators(prototype, methodName, descriptor, route, dtoResolver, entity);
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
  dtoResolver?: DtoResolver<object>,
  entity?: ClassRef<object>,
): void {
  const propertyDescriptor = Object.getOwnPropertyDescriptor(prototype, methodName) as PropertyDescriptor;
  applyParamDecorators(prototype, methodName, descriptor, route, dtoResolver, entity);
  // Route identity for `getResource`/`getOperation` (issue #238), written
  // on the handler function itself — the same target Nest's method
  // decorators write to — so Nest's `Reflector` can read it off
  // `context.getHandler()` from a `Guard`/`Interceptor`, before the
  // engine's own `KavoContext` exists. Both paths (generated and
  // `@Override`'d) run through here, so both carry the key; a
  // manual-method-wins method skips `defineRoute`/`applyRouteDecorators`
  // entirely and so never does.
  Reflect.defineMetadata(KAVO_OPERATION_METADATA, descriptor.id, propertyDescriptor.value);
  HttpCode(route.status)(prototype, methodName, propertyDescriptor);
  METHOD_DECORATORS[route.method](route.path)(prototype, methodName, propertyDescriptor);
  // The envelope unwrap / `ETag` / `304` interceptor (ADR-0020), applied
  // to **both** paths. On a generated handler it is the only thing that
  // turns the engine's `KavoResponse` into an HTTP response. On an
  // `@Override`'d one it sees an envelope either way, because
  // `applyOverrideEtag` ran first and promoted a bare return into one
  // (ADR-0027) — so the `ETag` is set on both paths, and the `304` is not,
  // since only an override returning `service.engine.execute(...)` carries a
  // `notModified` the engine actually computed. An *instance* rather than a
  // class, so it needs no DI registration in whatever module the controller
  // ends up in.
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
 *
 * `dtoResolver`, when given, is issue #281's fix: a generated method has no
 * source-level parameter declaration, so TypeScript's `emitDecoratorMetadata`
 * never writes `design:paramtypes` for it, and Nest's global `ValidationPipe`
 * resolves its `metatype` off exactly that metadata — so a registered
 * `dto.create`/`dto.update`/`dto.patch` class was silently never validated on
 * a generated route, however it's decorated (`class-validator`, `zod`, or
 * anything else hooking Nest's pipe system; the gap is generic, not tied to
 * one validation library). Writing the same metadata by hand here, at the
 * body parameter's position, is enough to make the existing global pipe
 * validate it, with no change to how the pipe itself resolves a metatype.
 * `undefined` (the override path, which already carries real
 * `design:paramtypes` from its own compiled source) leaves that metadata
 * untouched rather than clobbering it.
 */
function applyParamDecorators(
  prototype: Record<string, unknown>,
  methodName: string,
  descriptor: OperationDescriptor<object>,
  route: ResolvedRoute,
  dtoResolver?: DtoResolver<object>,
  entity?: ClassRef<object>,
): void {
  let index = 0;
  let bodyIndex = -1;
  if (route.hasIdParam) {
    Param("id")(prototype, methodName, index++);
  }
  if (descriptor.kind === "read") {
    Query(new WireQueryPipe())(prototype, methodName, index++);
  } else if (takesBody(descriptor, route)) {
    Body()(prototype, methodName, index++);
    bodyIndex = index - 1;
  }
  ConditionalRequest()(prototype, methodName, index++);
  Req()(prototype, methodName, index++);

  if (bodyIndex === -1 || dtoResolver === undefined) return;
  const bodyDto = bodyDtoFor(descriptor, dtoResolver) ?? entityFallbackDto(descriptor, entity);
  if (bodyDto === null) return;
  const paramTypes: unknown[] = Array.from({ length: index });
  paramTypes[bodyIndex] = bodyDto;
  Reflect.defineMetadata("design:paramtypes", paramTypes, prototype, methodName);
}

/**
 * Issue #283: when no `dto.create`/`dto.update`/`dto.patch` is registered,
 * fall back to the entity class itself — but only when it actually carries
 * `class-validator` decorators. An undecorated entity has no validation
 * rules to gain, and under `ValidationPipe({ whitelist: true })` (this
 * repo's own example config) naming an undecorated class as the body's
 * metatype would strip every property instead of validating them, trading
 * the silent-no-validation gap #283 closes for a silent data-loss one.
 */
function entityFallbackDto(descriptor: OperationDescriptor<object>, entity?: ClassRef<object>): ClassRef | null {
  if (entity === undefined) return null;
  if (descriptor.id !== "createOne" && descriptor.id !== "updateOne" && descriptor.id !== "patchOne") return null;
  return entityHasValidationMetadata(entity) ? entity : null;
}

/**
 * Writes that carry a request body — the mirror of `BODYLESS_WRITES`.
 *
 * `resource`'s `remove<Relation>` (`DELETE :id/<relation>`, ADR-0029's
 * resource amendment) is the one write whose body a bare HTTP method never
 * predicts: `DELETE` has no id path segment to carry the member it targets,
 * so the member id travels in the body instead — unlike every other
 * `DELETE` route Kavo generates (`deleteOne`, `purgeOne`), which are
 * bodyless because the path segment already names everything they need.
 */
function takesBody(descriptor: OperationDescriptor<object>, route: ResolvedRoute): boolean {
  if (descriptor.meta.arrayMutation?.action === "remove") return true;
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
