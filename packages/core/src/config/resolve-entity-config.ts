import type { KavoSettings } from "./settings.js";
import type { DeepPartial } from "../types/utility.js";
import type { ComputedFieldDescriptor, ComputedFieldMap } from "./computed-field.js";
import type {
  EntityConfig,
  FilterFieldSelector,
  FilterLimits,
  FilterOperatorMap,
  IncludeLimits,
  OperationConfig,
  RelationFieldSelector,
  SearchDriver,
  SearchMode,
  SelectableFieldSelector,
} from "./entity-config.js";
import type {
  ResolvedEntityConfig,
  ResolvedFilterConfig,
  ResolvedIncludeConfig,
  ResolvedSearchConfig,
  ResolvedSelectConfig,
  ResolvedSortConfig,
} from "./resolved-entity-config.js";
import { derivedWritableFieldNames, type EntityMetadata } from "../metadata/entity-metadata.js";
import type { FieldPath } from "../types/field-path.js";
import type { IncludePath } from "../types/include-path.js";
import type { FilterExpression, FilterOperator, FilterOperatorToken } from "../query/filter.js";
import type { Sort } from "../query/sort.js";
import type { OperationId, StandardOperationId } from "../operations/operation.js";
import type { RealtimeTransport } from "../realtime/realtime-transport.js";
import type { CacheStore } from "../caching/cache-store.js";
import type { Policy } from "../policy/kavo-policy.js";
import { createMemoryCacheStore } from "../caching/cache-store.js";
import { STANDARD_OPERATION_IDS } from "../operations/operation.js";
import { BUILT_IN_DEFAULTS } from "./defaults.js";
import { deepFreeze, mergeSettings } from "./merge-settings.js";
import { validateSettings } from "./validate-settings.js";
import type { DtoClass, WriteApply, WriteFieldsConfig } from "../dto/dto.js";
import { dtoShapeKeys } from "../dto/dto-shape.js";
import { dtoClassFromFields, resolveDtoSlot } from "../dto/dto-fields-shorthand.js";
import { DefaultDtoResolver } from "../dto/default-dto-resolver.js";
import { DefaultRelationRegistry } from "../relations/default-relation-registry.js";
import { resolveSoftDelete } from "../persistence/soft-delete.js";
import { ConfigurationException } from "../errors/exceptions.js";

/**
 * Top-level settings keys — the subset of an `EntityConfig` that merges.
 * `operations` is deliberately excluded: `EntityConfig.operations` is a
 * structurally different (richer, per-entity-typed) shape than
 * `KavoSettings.operations`'s global boolean map, so picking it here would
 * feed entity-scope `handler`/`meta` entries through the boolean-shaped
 * merge. `createOperationRegistry` resolves entity/operation-scope
 * `operations` directly from `EntityConfig`; the global boolean default
 * still reaches `entitySettings.operations` for free below, via
 * `mergeSettings(BUILT_IN_DEFAULTS, globalDefaults, …)` — `globalDefaults`
 * is a `KavoSettings`-shaped `DeepPartial`, so its `operations` key merges
 * normally even though `pickSettings` never reads it off `entityConfig`.
 *
 * `filter`/`sort`/`select`/`search`/`include` are **not** here: those
 * field-group blocks (issue #386) are entity-scope-only, resolved once by
 * this module directly from `EntityConfig`, never through the settings
 * precedence chain — there is no global or per-operation default for them.
 */
const SETTINGS_KEYS = [
  "pagination",
  "errors",
  "relations",
  "cache",
  "softDelete",
  "realtime",
  "arrayMutation",
  "authorization",
] as const satisfies readonly (keyof KavoSettings)[];

/**
 * An `EntityConfig`/`OperationConfig` mixes settings keys with structural
 * keys (`dto`, `filter`/`sort`/`select`/`search`/`include`, `computed`,
 * `handler`, …); only the settings subset participates in the merge
 * algebra.
 */
function pickSettings(config: Readonly<Record<string, unknown>> | undefined): DeepPartial<KavoSettings> | undefined {
  if (config === undefined) {
    return undefined;
  }
  const picked: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (config[key] !== undefined) {
      picked[key] = config[key];
    }
  }
  return picked as DeepPartial<KavoSettings>;
}

const BUILT_IN_FILTER_LIMITS = Object.freeze({ maxDepth: 3, maxInValues: 100, maxLikePatternLength: 200 });
const BUILT_IN_INCLUDE_LIMITS = Object.freeze({ maxDepth: 2, maxNodes: 10 });
const BUILT_IN_SEARCH_DEFAULTS = Object.freeze({ mode: "substring" as SearchMode, driver: "orm" as SearchDriver });

/**
 * Merge and validate one entity's configuration, once, at bootstrap:
 * `built-in defaults → global → entity → operation`. The result
 * is deep-frozen; per-call overrides are parameters (`KavoCallOptions`),
 * never writes into this object.
 */
export function resolveEntityConfig<Entity extends object>(
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
  globalDefaults: DeepPartial<KavoSettings> | undefined,
  realtimeTransports: readonly RealtimeTransport[] = [],
  cacheStore: CacheStore = createMemoryCacheStore(),
  globalPolicy?: Policy,
): ResolvedEntityConfig<Entity> {
  const entityName = metadata.name;
  const computed = resolveComputedFields(metadata, entityConfig);
  // The `{ exclude }` form of `create.fields`/`update.fields` (issue #397)
  // is resolved to a concrete array here, against the same writable-field
  // universe `DefaultDeserializer` enforces — so the two never drift.
  const writableUniverse = derivedWritableFieldNames(metadata);
  const createFields = resolveWriteFields(entityName, "create.fields", entityConfig?.create, writableUniverse);
  const updateFields = resolveWriteFields(entityName, "update.fields", entityConfig?.update, writableUniverse);
  rejectComputedWriteDtoKeys(entityName, entityConfig, computed, createFields, updateFields);
  const policy = resolvePolicy(entityName, entityConfig, globalPolicy);

  const { filter, sort, select, search, include, sortDefault } = resolveFieldGroups(metadata, entityConfig, computed);
  const projection = resolveProjection(metadata, entityConfig, computed, select);

  const ownColumnNames = new Set(
    metadata.fields.filter((field) => !field.generated).map((field) => field.name) as readonly string[],
  );
  const createDefault = resolveWriteDefault(entityName, "create.default", entityConfig?.create, ownColumnNames);
  const updateDefault = resolveWriteDefault(entityName, "update.default", entityConfig?.update, ownColumnNames);
  const createApply = resolveWriteApply(entityName, "create.apply", entityConfig?.create);
  const updateApply = resolveWriteApply(entityName, "update.apply", entityConfig?.update);

  const entitySettings = mergeSettings(
    BUILT_IN_DEFAULTS,
    globalDefaults,
    pickSettings(entityConfig as Readonly<Record<string, unknown>> | undefined),
  );
  validateSettings(entityName, entitySettings);
  validateSincePagination(entityName, metadata, entitySettings, filter, select);
  const relations = new DefaultRelationRegistry<Entity>(
    metadata.relations,
    include.fields as readonly string[],
    entitySettings.relations.edges,
    entityName,
    entitySettings.arrayMutation,
    include.default ?? [],
  );

  // Per-operation settings views, precomputed for every operation that
  // declares overrides. `false` (disabled) contributes no settings — the
  // registry handles disabling.
  const perOperation = new Map<OperationId, KavoSettings>();
  for (const [operation, config] of Object.entries(entityConfig?.operations ?? {}) as [
    StandardOperationId,
    OperationConfig<Entity> | boolean,
  ][]) {
    // Boolean shorthands carry no settings — enablement is the registry's.
    if (typeof config === "boolean") {
      continue;
    }
    const settings = pickSettings(config as Readonly<Record<string, unknown>>);
    if (settings === undefined || Object.keys(settings).length === 0) {
      continue;
    }
    const merged = mergeSettings(entitySettings, settings);
    const scope = `${entityName}.operations.${operation}`;
    validateSettings(scope, merged);
    validateSincePagination(scope, metadata, merged, filter, select);
    // Resolve for its validation side effect: a per-operation scope that
    // demands soft delete on an entity without a marker field must fail at
    // bootstrap, not on the first request (the engine recomputes the
    // strategy for whichever settings view a call ends up with).
    resolveSoftDelete(metadata, merged, scope);
    perOperation.set(operation, deepFreeze(merged));
  }

  const resolved: ResolvedEntityConfig<Entity> = {
    entityName,
    settings: deepFreeze(entitySettings),
    settingsFor(operation: OperationId): KavoSettings {
      return perOperation.get(operation) ?? entitySettings;
    },
    filter,
    sort,
    sortDefault,
    select,
    search,
    include,
    projection,
    softDelete: resolveSoftDelete(metadata, entitySettings),
    dto: new DefaultDtoResolver<Entity>(entityConfig?.dto, {
      // The resolved arrays, not the raw config: an `{ exclude }` shorthand
      // is already expanded to a concrete writable-field list here (#397).
      create: createFields === undefined ? undefined : ({ fields: createFields } as WriteFieldsConfig<Entity>),
      update: updateFields === undefined ? undefined : ({ fields: updateFields } as WriteFieldsConfig<Entity>),
    }),
    computed,
    relations,
    // Shallow-frozen: the array itself can't be mutated, but a transport's
    // own internal state is left alone (ADR-0023).
    realtimeTransports: Object.freeze([...realtimeTransports]),
    cacheStore,
    policy,
    createDefault,
    updateDefault,
    createApply,
    updateApply,
  };
  return Object.freeze(resolved);
}

/**
 * Resolve `create.default`/`update.default`: a plain object of field values,
 * validated against the entity's own non-generated columns (the only
 * fields either slot's writable projection ever includes). `undefined`
 * resolves to a frozen empty object, so callers never have to guard against
 * a missing key.
 */
function resolveWriteDefault<Entity extends object>(
  entityName: string,
  scope: string,
  writeConfig: WriteFieldsConfig<Entity> | undefined,
  ownColumnNames: ReadonlySet<string>,
): Readonly<Partial<Entity>> {
  const value = writeConfig?.default;
  if (value === undefined) {
    return EMPTY_WRITE_DEFAULT as Readonly<Partial<Entity>>;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationException(
      entityName,
      scope,
      `'${scope}' must be a plain object of field values, got '${typeof value}'.`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!ownColumnNames.has(key)) {
      throw new ConfigurationException(
        entityName,
        scope,
        `unknown field '${key}' in '${scope}' — expected one of ${[...ownColumnNames].join(", ")}`,
      );
    }
  }
  return Object.freeze({ ...value }) as Readonly<Partial<Entity>>;
}

const EMPTY_WRITE_DEFAULT: Readonly<Record<string, never>> = Object.freeze({});

/**
 * Resolve `create.apply`/`update.apply` (issue #391): a plain function
 * reference, passed through unresolved — the same treatment `filter.apply`/
 * `sort.apply`/`select.apply`/`include.apply` already get (ADR-0048), for
 * the same reason: it is evaluated per request with an arbitrary runtime
 * value, so there is nothing here to validate ahead of time beyond "is it
 * callable at all," which catches a JS or dynamically-built config the type
 * system can't see.
 */
function resolveWriteApply<Entity extends object>(
  entityName: string,
  scope: string,
  writeConfig: WriteFieldsConfig<Entity> | undefined,
): WriteApply<Entity> | undefined {
  const value = writeConfig?.apply;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "function") {
    throw new ConfigurationException(
      entityName,
      scope,
      `'${scope}' must be a function — (args: ApplyArgs) => Partial<Entity> | undefined, got '${typeof value}'.`,
    );
  }
  return value;
}

/**
 * Resolve `create.fields`/`update.fields` (issue #397) to a concrete
 * writable-field list, or `undefined` to leave the entity-derived default
 * (`DefaultDeserializer`'s own writable projection) in place.
 *
 * The plain array form is passed through verbatim — a typo in it is caught
 * later, when the synthesized DTO's keys are checked — the same laxity it
 * has had since issue #388. The `{ exclude }` form follows
 * `resolveIncludableSelector`'s strict precedent, not `resolveFieldSelector`'s
 * lax one (which silently excludes nothing on a name that matches nothing):
 * the writable universe is fully known at bootstrap, so an `exclude` entry
 * that names nothing writable is a fixed-once declaration that can be judged
 * wrong here, and a silent no-op would be the wrong report.
 *
 * `{ exclude: [] }` — or any `{ exclude }` that removes nothing — resolves
 * to `undefined`, not the full universe. Returning the universe as an
 * explicit list would synthesize a DTO class, and `DefaultDeserializer`
 * drops the soft-delete marker column only on its *derived-default* path
 * (`explicit === null`), so an explicit full list would widen writes by that
 * one column versus omitting the key. This deliberately diverges from
 * `include.fields`, where `{ exclude: [] }` is the meaningful "opt
 * everything in" spelling.
 */
function resolveWriteFields<Entity extends object>(
  entityName: string,
  scope: string,
  writeConfig: WriteFieldsConfig<Entity> | undefined,
  universe: readonly string[],
): readonly string[] | undefined {
  const value = writeConfig?.fields;
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return Object.freeze([...(value as readonly string[])]);
  }
  if (typeof value !== "object" || value === null || !Array.isArray((value as { exclude?: unknown }).exclude)) {
    throw new ConfigurationException(
      entityName,
      scope,
      `'${scope}' must be a string array or { exclude: string[] }, got ${JSON.stringify(value)}`,
    );
  }
  const exclude = (value as { readonly exclude: readonly string[] }).exclude;
  const known = new Set(universe);
  for (const name of exclude) {
    if (!known.has(name)) {
      throw new ConfigurationException(
        entityName,
        `${scope}.exclude`,
        `'${name}' is not a writable field of ${entityName} (writable: ${universe.join(", ") || "none"})`,
      );
    }
  }
  const excluded = new Set(exclude);
  if (excluded.size === 0) {
    return undefined;
  }
  return Object.freeze(universe.filter((name) => !excluded.has(name)));
}

/**
 * Reject a `policy` value that isn't a function — TypeScript callers get a
 * compile error instead, but this catches a JS or dynamically-built config
 * the type system can't see (including the pre-ADR-0033 entity-scope
 * `Partial<Record<StandardOperationId, PolicyNode>>` map, or a bare array),
 * which would otherwise reach the engine's policy stage and fail confusingly
 * on the first request instead of loudly here (ADR-0037).
 */
function assertIsPolicyFunction(entityName: string, scope: string, value: unknown): asserts value is Policy {
  if (typeof value !== "function") {
    throw new ConfigurationException(
      entityName,
      scope,
      `'${scope}' must be a function — ({ resource, operation, params, context, entity }) => boolean, got ` +
        `'${typeof value}'. A per-operation entry may also be 'false', to opt out of an inherited entity- or ` +
        `global-scope default.`,
    );
  }
}

/** `filter.apply`/`sort.apply`/`select.apply`/`include.apply` (ADR-0048) must all be plain functions. */
function assertIsApplyFunction(entityName: string, scope: string, value: unknown): void {
  if (value !== undefined && typeof value !== "function") {
    throw new ConfigurationException(
      entityName,
      scope,
      `'${scope}' must be a function — (args) => result, got '${typeof value}'.`,
    );
  }
}

/**
 * Resolve `policy` (ADR-0037): nearest scope wins, wholesale —
 * `operations.<id>.policy`, else `EntityConfig.policy`, else
 * `GlobalConfig.policy`, else unrestricted. `operations.<id>.policy: false`
 * opts one operation out of an inherited entity/global default.
 */
function resolvePolicy<Entity extends object>(
  entityName: string,
  entityConfig: EntityConfig<Entity> | undefined,
  globalPolicy: Policy | undefined,
): Readonly<Partial<Record<StandardOperationId, Policy<Entity>>>> {
  const entityPolicy = entityConfig?.policy;
  if (entityPolicy !== undefined) {
    assertIsPolicyFunction(entityName, "policy", entityPolicy);
  }
  if (globalPolicy !== undefined) {
    assertIsPolicyFunction(entityName, "policy (global default)", globalPolicy);
  }

  const resolved: Partial<Record<StandardOperationId, Policy<Entity>>> = {};
  for (const id of STANDARD_OPERATION_IDS) {
    const operationConfig = entityConfig?.operations?.[id];
    const operationPolicy =
      typeof operationConfig === "object" && operationConfig !== null
        ? (operationConfig as OperationConfig<Entity>).policy
        : undefined;
    if (operationPolicy !== undefined && operationPolicy !== false) {
      assertIsPolicyFunction(entityName, `operations.${id}.policy`, operationPolicy);
    }

    const policy: Policy<Entity> | false | undefined =
      operationPolicy !== undefined ? operationPolicy : ((entityPolicy ?? globalPolicy) as Policy<Entity> | undefined);
    if (policy === undefined || policy === false) {
      continue;
    }

    resolved[id] = policy;
  }
  return Object.freeze(resolved);
}

/** Assignable to `ComputedFieldMap<Entity>` for every `Entity`. */
const NO_COMPUTED_FIELDS: Readonly<Record<string, never>> = Object.freeze({});

const PROTO_NOT_A_NAME =
  `'__proto__' cannot name a computed field — it is not an ordinary object key, ` +
  `so the declaration would silently disappear instead of producing a response field`;

/**
 * Computed-field resolution (ADR-0019). `computed` carries functions, so
 * like `dto` it sits outside `SETTINGS_KEYS` and never merges through the
 * precedence chain — an entity's declaration is the whole story, resolved
 * once here.
 *
 * The ways a declaration can be structurally wrong all fail at bootstrap
 * rather than as a surprising response later: a name that shadows a real
 * column or relation (the shadowed value would silently disappear from
 * every response), a descriptor with no `resolve` function, and the one
 * name that is not a key at all — `__proto__`, which would set this
 * accumulator's prototype instead of adding an entry and so vanish
 * without a word (the same class of hazard as the bracket-segment fix in
 * the filter parser).
 */
function resolveComputedFields<Entity extends object>(
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
): ComputedFieldMap<Entity> {
  const entityName = metadata.name;
  // `EntityConfig<Entity>` fixes the `Computed` parameter to `never`, so
  // the declared record erases to `{}` at this internal call site; the
  // key/value types are recovered here, once.
  const declared = (entityConfig as { readonly computed?: ComputedFieldMap<Entity> } | undefined)?.computed;
  if (declared === undefined) {
    return NO_COMPUTED_FIELDS;
  }

  // `__proto__` has two spellings and only one of them is a key. The
  // computed form (`{ ["__proto__"]: … }`) creates an own key and is caught
  // in the loop below; the literal form (`{ __proto__: … }`) invokes the
  // prototype *setter* instead, so it never reaches `Object.keys` — the
  // declaration would register nothing and throw nothing, which is exactly
  // the outcome the message promises to prevent. A non-standard prototype
  // on the declared record is that spelling's only observable trace.
  const prototype = Object.getPrototypeOf(declared) as object | null;
  if (prototype !== null && prototype !== Object.prototype) {
    throw new ConfigurationException(entityName, "computed.__proto__", PROTO_NOT_A_NAME);
  }

  const columns = new Set(metadata.fields.map((field) => field.name));
  const relations = new Set(metadata.relations.map((relation) => relation.name));
  const resolved: Record<string, ComputedFieldDescriptor<Entity>> = {};
  for (const name of Object.keys(declared)) {
    const descriptor = declared[name];
    if (name === "__proto__") {
      throw new ConfigurationException(entityName, `computed.${name}`, PROTO_NOT_A_NAME);
    }
    if (typeof descriptor?.resolve !== "function") {
      throw new ConfigurationException(
        entityName,
        `computed.${name}`,
        `computed field '${name}' has no 'resolve' function — a computed field is defined by ` +
          `how it is derived, e.g. { resolve: (entity) => … }`,
      );
    }
    if (columns.has(name) || relations.has(name)) {
      const kind = columns.has(name) ? "column" : "relation";
      throw new ConfigurationException(
        entityName,
        `computed.${name}`,
        `computed field '${name}' collides with an existing ${kind} on '${entityName}' — ` +
          `a computed field must have a name of its own, or the ${kind} would never reach a response`,
      );
    }
    // The serializer emits `resolve`'s return value as-is and never awaits
    // it (ADR-0019), so an `async` resolver would put a pending promise in
    // the response — `{}` once serialized to JSON. Catching the shape
    // people actually write turns a silently wrong body into a bootstrap
    // failure; a plain function that happens to return a promise still
    // gets through, which is the limit of what is detectable here.
    if (descriptor.resolve.constructor?.name === "AsyncFunction") {
      throw new ConfigurationException(
        entityName,
        `computed.${name}`,
        `computed field '${name}' has an async 'resolve' — computed fields are resolved ` +
          `synchronously per served item and the promise would be emitted unawaited; ` +
          `fetch what it needs before serialization (a custom handler, or an eager relation)`,
      );
    }
    resolved[name] = descriptor;
  }
  return Object.freeze(resolved);
}

/**
 * A registered `create`/`update`/`patch` DTO naming a computed field is a
 * bootstrap error, like every other computed misconfiguration (ADR-0019).
 *
 * `DefaultDeserializer` would strip the key anyway — that strip stays, as
 * the defence for anyone constructing a deserializer directly — but a
 * silent per-request drop is the wrong report for a declaration that can
 * be judged wrong once, at the moment it is made. It also has a wire
 * consequence the strip cannot reach: `@kavo/nest` builds `@ApiBody` from
 * the DTO's runtime shape, so OpenAPI would advertise a property the
 * engine unconditionally discards.
 *
 * Only classes with a runtime shape are checkable; a purely declarative
 * DTO yields `null` from `dtoShapeKeys` and falls back to the derived
 * writable projection, which never contains a computed name. A `{ fields }`
 * shorthand — `dto.patch`'s own (issue #386), or the top-level
 * `create`/`update` shorthand that replaced `dto.create`/`dto.update`'s
 * (issue #388) — is resolved to its synthesized class first, so its
 * declared fields are checked the same way. `create`/`update` check the
 * registered `dto.<slot>` class first, matching `DefaultDtoResolver`'s own
 * precedence: a registered class wins over the top-level shorthand.
 */
function rejectComputedWriteDtoKeys<Entity extends object>(
  entityName: string,
  entityConfig: EntityConfig<Entity> | undefined,
  computed: ComputedFieldMap<Entity>,
  createFields: readonly string[] | undefined,
  updateFields: readonly string[] | undefined,
): void {
  const names = new Set(Object.keys(computed));
  if (names.size === 0) {
    return;
  }
  const dto = entityConfig?.dto as Readonly<Record<string, DtoClass | undefined>> | undefined;
  // `createFields`/`updateFields` are already `{ exclude }`-resolved (#397);
  // a computed name can never be in the resolved list of an `{ exclude }`
  // form (it is not a writable column), so this still only ever fires for a
  // computed name written into the plain array form.
  const checks: readonly [slot: string, scope: string, dtoClass: DtoClass | null][] = [
    ["create", "dto.create", dto?.create ?? (createFields ? dtoClassFromFields(createFields) : null)],
    ["update", "dto.update", dto?.update ?? (updateFields ? dtoClassFromFields(updateFields) : null)],
    ["patch", "dto.patch", resolveDtoSlot(dto?.patch as Parameters<typeof resolveDtoSlot>[0])],
  ];
  for (const [slot, scope, dtoClass] of checks) {
    const declared = dtoShapeKeys(dtoClass)?.find((key) => names.has(key));
    if (declared === undefined) {
      continue;
    }
    throw new ConfigurationException(
      entityName,
      scope,
      `the '${slot}' DTO declares '${declared}', which is a computed field on '${entityName}' — ` +
        `a computed field has no column behind it, so the value is stripped from every write ` +
        `payload while the generated OpenAPI body still advertises the property; drop it from the ` +
        `DTO, or make it a real column if it is meant to be written`,
    );
  }
}

/** Letters, digits, underscore, not leading with a digit — same charset `@kavo/typeorm`'s `columnRef` enforces at request time. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Generic over the path type so it serves both `QueryFieldSelector`
 * (depth-capped-3 `FieldPath`) and a relation selector (depth-1) — the
 * array-or-`{ exclude }` resolution logic is identical either way.
 */
function resolveFieldSelector<Path extends string>(
  base: readonly Path[],
  selector: readonly Path[] | { readonly exclude: readonly Path[] } | undefined,
): readonly Path[] {
  if (selector === undefined) {
    return base;
  }
  if (!("exclude" in selector)) {
    return selector;
  }
  const excluded = new Set(selector.exclude);
  return base.filter((path) => !excluded.has(path));
}

/**
 * `filter.fields`'s map form (issue #386): `{ field: [operators] }`
 * restricting which operators are permitted per field, distinguished from
 * the plain array/`{ exclude }` forms by shape — an array is never a map,
 * and neither is `{ exclude }`.
 */
function isFilterOperatorMap(selector: unknown): selector is FilterOperatorMap<unknown> {
  return (
    typeof selector === "object" &&
    selector !== null &&
    !Array.isArray(selector) &&
    !("exclude" in (selector as Record<string, unknown>))
  );
}

const WIRE_TO_FILTER_OPERATOR: Readonly<Record<FilterOperatorToken, FilterOperator>> = Object.freeze({
  eq: "EQ",
  ne: "NE",
  gt: "GT",
  gte: "GTE",
  lt: "LT",
  lte: "LTE",
  in: "IN",
  notIn: "NOT_IN",
  like: "LIKE",
  ilike: "ILIKE",
  between: "BETWEEN",
  isNull: "IS_NULL",
  isNotNull: "IS_NOT_NULL",
});

/** Resolve `filter.fields`'s raw selector into the field allowlist plus, for the map form, per-field operator restrictions. */
function resolveFilterFields<Entity extends object>(
  entityName: string,
  base: readonly FieldPath<Entity>[],
  selector: FilterFieldSelector<Entity> | undefined,
): {
  readonly fields: readonly FieldPath<Entity>[];
  readonly operators: ReadonlyMap<string, ReadonlySet<FilterOperator>> | null;
} {
  if (!isFilterOperatorMap(selector)) {
    return { fields: resolveFieldSelector(base, selector), operators: null };
  }
  const map = selector as FilterOperatorMap<Entity>;
  const operators = new Map<string, ReadonlySet<FilterOperator>>();
  for (const [field, tokens] of Object.entries(map)) {
    const resolved = new Set<FilterOperator>();
    for (const token of tokens as readonly FilterOperatorToken[]) {
      const operator = WIRE_TO_FILTER_OPERATOR[token];
      if (operator === undefined) {
        throw new ConfigurationException(
          entityName,
          `filter.fields.${field}`,
          `unknown filter operator token '${token}' — expected one of ${Object.keys(WIRE_TO_FILTER_OPERATOR).join(", ")}`,
        );
      }
      resolved.add(operator);
    }
    operators.set(field, resolved);
  }
  return { fields: [...operators.keys()] as unknown as readonly FieldPath<Entity>[], operators };
}

/** Resolve `filter.limits`, falling back to the built-in ceilings. */
function resolveFilterLimits(entityName: string, limits: FilterLimits | undefined): ResolvedFilterConfig["limits"] {
  const positiveInt = (path: string, value: number | undefined, fallback: number): number => {
    if (value === undefined) {
      return fallback;
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigurationException(entityName, path, `expected a positive integer, got ${JSON.stringify(value)}`);
    }
    return value;
  };
  return {
    maxDepth: positiveInt("filter.limits.maxDepth", limits?.maxDepth, BUILT_IN_FILTER_LIMITS.maxDepth),
    maxInValues: positiveInt("filter.limits.maxInValues", limits?.maxInValues, BUILT_IN_FILTER_LIMITS.maxInValues),
    maxLikePatternLength: positiveInt(
      "filter.limits.maxLikePatternLength",
      limits?.maxLikePatternLength,
      BUILT_IN_FILTER_LIMITS.maxLikePatternLength,
    ),
  };
}

/** Resolve `include.limits`, falling back to the built-in ceilings. */
function resolveIncludeLimits(entityName: string, limits: IncludeLimits | undefined): ResolvedIncludeConfig["limits"] {
  const positiveInt = (path: string, value: number | undefined, fallback: number): number => {
    if (value === undefined) {
      return fallback;
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigurationException(entityName, path, `expected a positive integer, got ${JSON.stringify(value)}`);
    }
    return value;
  };
  return {
    maxDepth: positiveInt("include.limits.maxDepth", limits?.maxDepth, BUILT_IN_INCLUDE_LIMITS.maxDepth),
    maxNodes: positiveInt("include.limits.maxNodes", limits?.maxNodes, BUILT_IN_INCLUDE_LIMITS.maxNodes),
  };
}

/** `-field` → `{ field, direction: "desc" }`; `field` → `{ field, direction: "asc" }`. */
function parseSortToken<Entity>(token: string): Sort<Entity> {
  const descending = token.startsWith("-");
  const field = descending ? token.slice(1) : token;
  return { field: field as FieldPath<Entity>, direction: descending ? "desc" : "asc" };
}

/** Bootstrap-validate every field named inside a `filter.default` expression against `filter.fields`. */
function validateFilterDefaultFields<Entity>(
  entityName: string,
  expression: FilterExpression<Entity>,
  filterable: ReadonlySet<string>,
): void {
  if (expression.kind === "condition") {
    if (!filterable.has(expression.field as string)) {
      throw new ConfigurationException(
        entityName,
        "filter.default",
        `field '${expression.field as string}' is not in 'filter.fields'`,
      );
    }
    return;
  }
  for (const child of expression.children) {
    validateFilterDefaultFields(entityName, child, filterable);
  }
}

/** Resolve and bootstrap-validate `filter.default` against `filter.fields`. */
function resolveFilterDefault<Entity extends object>(
  entityName: string,
  expression: FilterExpression<Entity> | undefined,
  filterable: readonly FieldPath<Entity>[],
): FilterExpression<Entity> | null {
  if (expression === undefined) {
    return null;
  }
  validateFilterDefaultFields(entityName, expression, new Set(filterable as readonly string[]));
  return expression;
}

/** Resolve and bootstrap-validate `sort.default` against `sort.fields`. */
function resolveSortDefault<Entity extends object>(
  entityName: string,
  tokens: readonly string[] | undefined,
  sortable: readonly FieldPath<Entity>[],
): readonly Sort<Entity>[] {
  if (tokens === undefined) {
    return [];
  }
  if (!Array.isArray(tokens)) {
    throw new ConfigurationException(
      entityName,
      "sort.default",
      `expected an array of strings, got ${JSON.stringify(tokens)}`,
    );
  }
  const sortableSet = new Set(sortable as readonly string[]);
  const result: Sort<Entity>[] = [];
  for (const raw of tokens) {
    if (typeof raw !== "string" || raw === "" || raw === "-") {
      throw new ConfigurationException(
        entityName,
        "sort.default",
        `expected a non-empty field name, got ${JSON.stringify(raw)}`,
      );
    }
    const entry = parseSortToken<Entity>(raw);
    if (!sortableSet.has(entry.field as string)) {
      throw new ConfigurationException(
        entityName,
        "sort.default",
        `field '${entry.field as string}' is not in 'sort.fields'`,
      );
    }
    result.push(entry);
  }
  return result;
}

/** Resolve and bootstrap-validate `select.default` against `select.fields`. */
function resolveSelectDefault<Entity extends object>(
  entityName: string,
  fields: readonly string[] | undefined,
  selectable: readonly FieldPath<Entity>[],
): readonly FieldPath<Entity, 1>[] | undefined {
  if (fields === undefined) {
    return undefined;
  }
  const selectableSet = new Set(selectable as readonly string[]);
  for (const field of fields) {
    if (!selectableSet.has(field)) {
      throw new ConfigurationException(entityName, "select.default", `field '${field}' is not in 'select.fields'`);
    }
  }
  return fields as unknown as readonly FieldPath<Entity, 1>[];
}

/** Resolve and bootstrap-validate `include.default` against `include.fields`. */
function resolveIncludeDefault<Entity extends object>(
  entityName: string,
  names: readonly string[] | undefined,
  includable: readonly IncludePath<Entity, 1>[],
): readonly string[] {
  if (names === undefined) {
    return [];
  }
  const includableSet = new Set(includable as readonly string[]);
  for (const name of names) {
    if (!includableSet.has(name)) {
      throw new ConfigurationException(
        entityName,
        "include.default",
        `'${name}' is not on include.fields, so it would load a relation clients cannot ask for`,
      );
    }
  }
  return names;
}

/**
 * Resolve `search`, backfilling `mode`/`driver` from their defaults. `false`
 * (the default) means search stays off.
 */
function resolveSearchConfig<Entity extends object>(
  entityName: string,
  stringColumns: readonly FieldPath<Entity>[],
  configured: EntityConfig<Entity>["search"],
): ResolvedSearchConfig<Entity> | false {
  if (configured === false || configured === undefined) {
    return false;
  }
  const mode = configured.mode === undefined ? BUILT_IN_SEARCH_DEFAULTS.mode : configured.mode;
  if (mode !== "substring" && mode !== "words") {
    throw new ConfigurationException(
      entityName,
      "search.mode",
      `expected "substring" or "words", got ${JSON.stringify(mode)}`,
    );
  }
  const driver = configured.driver === undefined ? BUILT_IN_SEARCH_DEFAULTS.driver : configured.driver;
  if (driver !== "orm") {
    throw new ConfigurationException(
      entityName,
      "search.driver",
      `expected "orm" (the only driver this schema accepts today), got ${JSON.stringify(driver)}`,
    );
  }
  return {
    fields: resolveFieldSelector(stringColumns, configured.fields),
    default: configured.default ?? null,
    mode,
    driver,
  };
}

/**
 * Resolves every field-group block in one pass: `filter`, `sort`, `select`,
 * `search`, `include` (issue #386, replacing `resolveAllowed`). Each block's
 * `fields` derives from the entity's **own scalar columns** when not
 * configured explicitly — relation paths are never filterable/sortable/
 * selectable unless opted in explicitly, and `include.fields` defaults the
 * other way (opt-in, ADR-0028). Anything outside a block's `fields` is a
 * 400 at query time, never a silent drop.
 *
 * Computed fields join the `select.fields` base set (so `select=fullName`
 * works with no further configuration) unless the descriptor opts out with
 * `selectable: false`, and are barred from `filter.fields`/`sort.fields`
 * outright — there is no column to translate to `WHERE`/`ORDER BY`
 * (ADR-0019).
 */
function resolveFieldGroups<Entity extends object>(
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
  computed: ComputedFieldMap<Entity>,
): {
  readonly filter: ResolvedFilterConfig<Entity>;
  readonly sort: ResolvedSortConfig<Entity>;
  readonly sortDefault: readonly Sort<Entity>[];
  readonly select: ResolvedSelectConfig<Entity>;
  readonly search: ResolvedSearchConfig<Entity> | false;
  readonly include: ResolvedIncludeConfig<Entity> & { readonly default?: readonly string[] };
} {
  const entityName = metadata.name;
  const ownColumns = metadata.fields.map((field) => field.name) as unknown as readonly FieldPath<Entity>[];
  const stringColumns = metadata.fields
    .filter((field) => field.kind === "string")
    .map((field) => field.name) as unknown as readonly FieldPath<Entity>[];
  const selectableBase = [
    ...(ownColumns as readonly string[]),
    ...Object.keys(computed).filter((name) => computed[name]?.selectable !== false),
  ] as unknown as readonly FieldPath<Entity>[];
  const relationNames = metadata.relations.map((relation) => relation.name) as unknown as readonly IncludePath<
    Entity,
    1
  >[];

  const knownFieldNames = [
    ...(ownColumns as readonly string[]),
    ...(relationNames as readonly string[]),
    ...Object.keys(computed),
  ];

  const filterConfig = entityConfig?.filter;
  validateFieldNames(entityName, "filter.fields", filterConfig?.fields, knownFieldNames);
  const { fields: filterFields, operators } = resolveFilterFields(entityName, ownColumns, filterConfig?.fields);

  const sortConfig = entityConfig?.sort;
  validateFieldNames(entityName, "sort.fields", sortConfig?.fields, knownFieldNames);
  const sortFields = resolveFieldSelector(ownColumns, sortConfig?.fields);

  const selectConfig = entityConfig?.select;
  rejectRelationDottedSelectable(entityName, selectableBase as readonly string[], selectConfig?.fields);
  const selectFields = resolveFieldSelector(
    selectableBase,
    selectConfig?.fields as SelectableFieldSelector<Entity, string> | undefined,
  ) as unknown as readonly FieldPath<Entity>[];

  const includeConfig = entityConfig?.include;
  const includeFields = resolveIncludableSelector(entityName, relationNames, includeConfig?.fields);

  const COMPUTED_REJECTION = {
    "filter.fields": { verb: "filtered on", clause: "WHERE" },
    "sort.fields": { verb: "sorted on", clause: "ORDER BY" },
  } as const;
  for (const [key, fields] of [
    ["filter.fields", filterFields],
    ["sort.fields", sortFields],
  ] as const) {
    for (const field of fields as readonly string[]) {
      if (!Object.prototype.hasOwnProperty.call(computed, field)) {
        continue;
      }
      const { verb, clause } = COMPUTED_REJECTION[key];
      throw new ConfigurationException(
        entityName,
        key,
        `'${field}' is a computed field on '${entityName}', which can never be ${verb} — ` +
          `it has no column to translate to ${clause}`,
      );
    }
  }

  const search = resolveSearchConfig(entityName, stringColumns, entityConfig?.search);
  if (search !== false) {
    for (const field of search.fields as readonly string[]) {
      if (Object.prototype.hasOwnProperty.call(computed, field)) {
        throw new ConfigurationException(
          entityName,
          "search.fields",
          `'${field}' is a computed field on '${entityName}', which can never be searched on — ` +
            `it has no column to translate to WHERE`,
        );
      }
      if (field.includes(".")) {
        continue;
      }
      const fieldKind = metadata.fields.find((column) => column.name === field)?.kind;
      if (fieldKind !== undefined && fieldKind !== "string") {
        throw new ConfigurationException(
          entityName,
          "search.fields",
          `'${field}' is a '${fieldKind}'-kind column on '${entityName}', which an 'ILIKE' fragment ` +
            `cannot usefully match — 'search.fields' entries must be string-kind columns, or relation paths`,
        );
      }
    }
  }

  assertIsApplyFunction(entityName, "filter.apply", filterConfig?.apply);
  assertIsApplyFunction(entityName, "sort.apply", sortConfig?.apply);
  assertIsApplyFunction(entityName, "select.apply", selectConfig?.apply);
  assertIsApplyFunction(entityName, "include.apply", includeConfig?.apply);

  const filter: ResolvedFilterConfig<Entity> = deepFreeze({
    fields: filterFields,
    operators,
    default: resolveFilterDefault(entityName, filterConfig?.default, filterFields),
    apply: filterConfig?.apply,
    limits: resolveFilterLimits(entityName, filterConfig?.limits),
  });
  const sort: ResolvedSortConfig<Entity> = deepFreeze({ fields: sortFields, apply: sortConfig?.apply });
  const selectDefault = resolveSelectDefault(
    entityName,
    selectConfig?.default as readonly string[] | undefined,
    selectFields,
  );
  const select: ResolvedSelectConfig<Entity> = deepFreeze({
    fields: selectFields,
    default: selectDefault,
    apply: selectConfig?.apply,
  });
  const includeDefault = resolveIncludeDefault(
    entityName,
    includeConfig?.default as readonly string[] | undefined,
    includeFields,
  );
  const include: ResolvedIncludeConfig<Entity> & { readonly default?: readonly string[] } = deepFreeze({
    fields: includeFields,
    limits: resolveIncludeLimits(entityName, includeConfig?.limits),
    default: includeDefault,
    apply: includeConfig?.apply,
  });
  const sortDefault = resolveSortDefault(entityName, sortConfig?.default, sortFields);

  return { filter, sort, sortDefault, select, search, include };
}

/**
 * The default response projection, or `null` for "leave it derived"
 * (ADR-0026).
 *
 * Explicit configuration is the trigger: an unwritten `select.fields`
 * narrows nothing, which is what keeps this change confined to entities
 * that asked for it.
 *
 * The two spellings resolve against **different bases**, and that asymmetry
 * is the whole point rather than an oversight. A plain array is the author's
 * own list and is used verbatim. `{ exclude }` means "everything except
 * these", and *everything* here has to be the readable projection — every
 * column plus **every** declared computed field — not `selectableBase`,
 * which drops computed fields declaring `selectable: false`.
 *
 * Resolving `{ exclude }` against the narrower base retires a contract the
 * author never touched: `selectable: false` is documented as keeping a field
 * in the projection while making its name a 400 in `select=`, so
 * `{ exclude: ["email"] }` would silently delete an unrelated audit field
 * from every response. That is the same "narrowing by a list nobody wrote"
 * this function exists to prevent, one level down.
 */
function resolveProjection<Entity extends object>(
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
  computed: ComputedFieldMap<Entity>,
  select: ResolvedSelectConfig<Entity>,
): readonly FieldPath<Entity>[] | null {
  const selector = entityConfig?.select?.fields;
  if (selector === undefined) {
    return null;
  }
  if (!("exclude" in selector)) {
    return select.fields;
  }
  const readable = [...metadata.fields.map((field) => field.name), ...Object.keys(computed)];
  const excluded = new Set(selector.exclude as readonly string[]);
  return readable.filter((name) => !excluded.has(name)) as unknown as readonly FieldPath<Entity>[];
}

/**
 * `select.fields` addresses this entity's own columns and its declared
 * computed-field names — nothing else (ADR-0045). A relation is selected
 * with `select[<relation>]=`, and an included relation's projection is
 * governed by the *target* entity's own `select.fields` (ADR-0026
 * decision 4), never the including entity's config.
 *
 * So a relation-dotted `select.fields` entry has no meaning here and is a
 * bootstrap `ConfigurationException`, in both the array and the
 * `{ exclude }` form.
 */
function rejectRelationDottedSelectable(
  entityName: string,
  known: readonly string[],
  selector: SelectableFieldSelector<object, string> | undefined,
): void {
  if (selector === undefined) {
    return;
  }
  const knownNames = new Set(known);
  const entries = "exclude" in selector ? selector.exclude : selector;
  const keyPath = "exclude" in selector ? "select.fields.exclude" : "select.fields";
  for (const entry of entries as readonly string[]) {
    if (!entry.includes(".") || knownNames.has(entry)) {
      continue;
    }
    throw new ConfigurationException(
      entityName,
      keyPath,
      `'${entry}' is a relation-dotted path. select.fields takes ${entityName}'s own columns and ` +
        `computed-field names only — an included relation's projection is governed by the target entity's own ` +
        `select.fields (ADR-0045). Drop this entry, or restrict the relation on the target entity's config.`,
    );
  }
}

/**
 * Bootstrap check for an explicit `filter.fields`/`sort.fields` array
 * override (issue #367 finding 1). These allowlists gate the *only* two
 * client inputs `@kavo/typeorm` interpolates raw into SQL — a join path and
 * a `where`/`addOrderBy` column reference, neither of which can be
 * parameter-bound — so an explicit array here is used verbatim
 * (`resolveFieldSelector`'s plain-array branch) with nothing else standing
 * between it and the driver. `{ exclude }` overrides are skipped: they
 * subtract from `base`, which is already known-safe own columns. The map
 * form (`filter.fields` only) is skipped the same way — its keys are
 * checked by `resolveFilterFields` itself.
 */
function validateFieldNames(
  entityName: string,
  key: "filter.fields" | "sort.fields",
  selector: unknown,
  knownFieldNames: readonly string[],
): void {
  if (selector === undefined || !Array.isArray(selector)) {
    return;
  }
  const known = new Set(knownFieldNames);
  for (const field of selector as readonly string[]) {
    const segments = field.split(".");
    if (segments.length === 1) {
      if (!known.has(field)) {
        throw new ConfigurationException(
          entityName,
          key,
          `'${field}' is not a column on '${entityName}' — ${key} entries must name a real ` +
            `column, or a relation path ('relation.field') for a relation-dotted entry.`,
        );
      }
      continue;
    }
    for (const segment of segments) {
      if (!IDENTIFIER.test(segment)) {
        throw new ConfigurationException(
          entityName,
          key,
          `'${field}' is not a valid relation path — '${segment}' is not a valid identifier. ` +
            `${key} entries reach raw SQL unquoted, so every segment must be letters, digits, ` +
            `and underscores only.`,
        );
      }
    }
  }
}

/**
 * `include.fields`'s own resolver, not `resolveFieldSelector` reused: the
 * unconfigured default is `[]`, not `base` — the opt-in direction
 * `IncludeConfig.fields`'s doc comment calls out (ADR-0028). An explicit
 * array is used verbatim (and is checked for typos later, when
 * `DefaultRelationRegistry` builds the registry); `{ exclude }` still
 * resolves against `base` (every relation), so `{ exclude: [] }` is the one
 * spelling that opts every relation in at once.
 */
function resolveIncludableSelector<Entity>(
  entityName: string,
  base: readonly IncludePath<Entity, 1>[],
  selector: RelationFieldSelector<Entity> | undefined,
): readonly IncludePath<Entity, 1>[] {
  if (selector === undefined) {
    return [];
  }
  if (!("exclude" in selector)) {
    return selector;
  }
  const known = new Set<string>(base as readonly string[]);
  for (const name of selector.exclude) {
    if (known.has(name as string)) {
      continue;
    }
    throw new ConfigurationException(
      entityName,
      "include.fields.exclude",
      `'${name}' is not a relation of ${entityName} (relations: ${[...known].join(", ") || "none"})`,
    );
  }
  const excluded = new Set(selector.exclude);
  return base.filter((path) => !excluded.has(path));
}

/**
 * Bootstrap validation for `pagination.strategy: "since"` (ADR-0022):
 * `pagination.since.field` names a real, `date`- or `string`-kind column
 * on `filter.fields` and `select.fields`, and `idField` (the forced sort's
 * tiebreaker) is too. Unlike cursor pagination's equivalent check
 * (`QueryNormalizer.resolveKeyset`, run per request against the *effective*
 * sort, which is client-choosable), the since strategy's sort is *forced*
 * and entirely config-known — the same reason `resolveSoftDelete` validates
 * its marker field here rather than per request.
 */
function validateSincePagination<Entity extends object>(
  scope: string,
  metadata: EntityMetadata<Entity>,
  settings: KavoSettings,
  filter: ResolvedFilterConfig<Entity>,
  select: ResolvedSelectConfig<Entity>,
): void {
  if (settings.pagination.strategy !== "since") {
    return;
  }
  const { field } = settings.pagination.since;
  const filterable = filter.fields as readonly string[];
  const selectable = select.fields as readonly string[];

  const sinceColumn = metadata.fields.find((column) => column.name === field);
  if (sinceColumn === undefined) {
    throw new ConfigurationException(
      scope,
      "pagination.since.field",
      `entity '${metadata.name}' has no '${field}' column — set 'pagination.since.field' to an existing column`,
    );
  }
  if (sinceColumn.kind !== "date" && sinceColumn.kind !== "string") {
    throw new ConfigurationException(
      scope,
      "pagination.since.field",
      `'${field}' must be a 'date'- or 'string'-kind column to page by, got '${sinceColumn.kind}'`,
    );
  }
  const tiebreaker = metadata.compositeIdFields ?? [metadata.idField];
  const columnsToCheck: Array<{ column: string; reason: string }> = [
    { column: field, reason: "'pagination.since.field'" },
  ];
  for (const name of tiebreaker) {
    columnsToCheck.push({
      column: name,
      reason:
        metadata.compositeIdFields === undefined
          ? "the forced tiebreaker 'idField'"
          : `the forced tiebreaker column '${name}' (compositeIdFields)`,
    });
  }
  for (const { column, reason } of columnsToCheck) {
    if (!filterable.includes(column)) {
      throw new ConfigurationException(
        scope,
        "pagination.since.field",
        `${reason} '${column}' must be on 'filter.fields' for 'since' pagination to compose its keyset predicate`,
      );
    }
    if (!selectable.includes(column)) {
      throw new ConfigurationException(
        scope,
        "pagination.since.field",
        `${reason} '${column}' must be on 'select.fields' for 'since' pagination to read the next boundary off a row`,
      );
    }
  }
}

/**
 * Debug dump: the resolved configuration for one
 * entity as a plain printable object — what you `console.log` when a
 * merge result surprises you.
 */
export function describeResolvedConfig<Entity>(
  config: ResolvedEntityConfig<Entity>,
  operations: readonly OperationId[] = [],
): Record<string, unknown> {
  return {
    entityName: config.entityName,
    settings: config.settings,
    filter: config.filter,
    sort: config.sort,
    select: config.select,
    search: config.search,
    include: config.include,
    computed: Object.keys(config.computed),
    softDelete: config.softDelete,
    relations: config.relations.all().map((relation) => ({
      name: relation.name,
      cardinality: relation.cardinality,
      includable: relation.includable,
      strategy: relation.strategy,
      write: relation.write,
    })),
    operations: Object.fromEntries(operations.map((operation) => [operation, config.settingsFor(operation)])),
  };
}
