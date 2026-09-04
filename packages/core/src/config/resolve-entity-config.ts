import type { KavoSettings } from "./settings.js";
import type { DeepPartial } from "../types/utility.js";
import type { ComputedFieldDescriptor, ComputedFieldMap } from "./computed-field.js";
import type { EntityConfig, OperationConfig, RelationFieldSelector, SelectableFieldSelector } from "./entity-config.js";
import type { ResolvedEntityConfig, ResolvedQueryAllowed } from "./resolved-entity-config.js";
import type { DtoClass } from "../dto/dto.js";
import type { EntityMetadata } from "../metadata/entity-metadata.js";
import type { FieldPath } from "../types/field-path.js";
import type { IncludePath } from "../types/include-path.js";
import type { OperationId, StandardOperationId } from "../operations/operation.js";
import type { RealtimeTransport } from "../realtime/realtime-transport.js";
import type { CacheStore } from "../caching/cache-store.js";
import type { Policy } from "../policy/kavo-policy.js";
import { createMemoryCacheStore } from "../caching/cache-store.js";
import { STANDARD_OPERATION_IDS } from "../operations/operation.js";
import { BUILT_IN_DEFAULTS } from "./defaults.js";
import { deepFreeze, mergeSettings } from "./merge-settings.js";
import { validateSettings } from "./validate-settings.js";
import { dtoShapeKeys } from "../dto/dto-shape.js";
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
 */
const SETTINGS_KEYS = [
  "pagination",
  "limits",
  "search",
  "errors",
  "relations",
  "defaults",
  "cache",
  "softDelete",
  "realtime",
  "arrayMutation",
  "authorization",
] as const satisfies readonly (keyof KavoSettings)[];

/**
 * An `EntityConfig`/`OperationConfig` mixes settings keys with structural
 * keys (`dto`, `allowed`, `computed`, `handler`, …); only the settings
 * subset participates in the merge algebra.
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

/**
 * Backfill `search`'s `mode`/`driver` after a merge. `false` (the
 * default) stays `false` — search off. Any object turns search on, and a
 * nearer scope re-enabling from `false` may name only the keys it changes
 * (`search: { mode: "words" }`), so the missing ones fall back to the
 * built-in defaults here rather than being left `undefined`.
 */
function normalizeSearch(settings: KavoSettings): KavoSettings {
  const search = settings.search;
  if (search === false) {
    return settings;
  }
  const defaults = BUILT_IN_DEFAULT_SEARCH;
  return {
    ...settings,
    search: { mode: search.mode ?? defaults.mode, driver: search.driver ?? defaults.driver },
  };
}

const BUILT_IN_DEFAULT_SEARCH = Object.freeze({ mode: "substring" as const, driver: "orm" as const });

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
  rejectComputedWriteDtoKeys(entityName, entityConfig, computed);
  const policy = resolvePolicy(entityName, entityConfig, globalPolicy);
  const allowed = resolveAllowed(metadata, entityConfig, computed);
  const projection = resolveProjection(metadata, entityConfig, computed, allowed);
  const entitySettings = normalizeSearch(
    mergeSettings(
      BUILT_IN_DEFAULTS,
      globalDefaults,
      pickSettings(entityConfig as Readonly<Record<string, unknown>> | undefined),
    ),
  );
  validateSettings(entityName, entitySettings);
  validateDefaults(entityName, entitySettings, allowed);
  validateSincePagination(entityName, metadata, entitySettings, allowed);
  const relations = new DefaultRelationRegistry<Entity>(
    metadata.relations,
    allowed.includable as readonly string[],
    entitySettings.relations.edges,
    entityName,
    entitySettings.arrayMutation,
    entitySettings.defaults.include,
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
    const merged = normalizeSearch(mergeSettings(entitySettings, settings));
    const scope = `${entityName}.operations.${operation}`;
    validateSettings(scope, merged);
    validateDefaults(scope, merged, allowed);
    validateSincePagination(scope, metadata, merged, allowed);
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
    allowed,
    projection,
    softDelete: resolveSoftDelete(metadata, entitySettings),
    dto: new DefaultDtoResolver<Entity>(entityConfig?.dto),
    computed,
    relations,
    // Shallow-frozen: the array itself can't be mutated, but a transport's
    // own internal state is left alone (ADR-0023).
    realtimeTransports: Object.freeze([...realtimeTransports]),
    cacheStore,
    policy,
  };
  return Object.freeze(resolved);
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

/** The DTO slots whose classes describe a **write** payload (ADR-0019 §4). */
const WRITE_DTO_SLOTS = ["create", "update", "patch"] as const;

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
 * writable projection, which never contains a computed name.
 */
function rejectComputedWriteDtoKeys<Entity extends object>(
  entityName: string,
  entityConfig: EntityConfig<Entity> | undefined,
  computed: ComputedFieldMap<Entity>,
): void {
  const names = new Set(Object.keys(computed));
  if (names.size === 0) {
    return;
  }
  const dto = entityConfig?.dto as Readonly<Record<string, DtoClass | undefined>> | undefined;
  if (dto === undefined) {
    return;
  }
  for (const slot of WRITE_DTO_SLOTS) {
    const declared = dtoShapeKeys(dto[slot] ?? null)?.find((key) => names.has(key));
    if (declared === undefined) {
      continue;
    }
    throw new ConfigurationException(
      entityName,
      `dto.${slot}`,
      `the '${slot}' DTO declares '${declared}', which is a computed field on '${entityName}' — ` +
        `a computed field has no column behind it, so the value is stripped from every write ` +
        `payload while the generated OpenAPI body still advertises the property; drop it from the ` +
        `DTO, or make it a real column if it is meant to be written`,
    );
  }
}

/**
 * Allowlist derivation (security posture): when a list is not
 * configured explicitly, it defaults to the entity's **own scalar
 * columns** — relation paths are never filterable/sortable/selectable
 * unless opted in explicitly. Anything outside the list is a 400 at query
 * time, never a silent drop.
 *
 * Computed fields join the `selectable` base set (so `select=fullName`
 * works with no further configuration) unless the descriptor opts out with
 * `selectable: false`, and are barred from `filterable`/`sortable`
 * outright — there is no column to translate to `WHERE`/`ORDER BY`
 * (ADR-0019).
 */
function resolveAllowed<Entity extends object>(
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
  computed: ComputedFieldMap<Entity>,
): ResolvedQueryAllowed<Entity> {
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
  // The same base `DefaultDeserializer`'s derived writable projection uses:
  // every non-generated scalar column except the primary key, plus every
  // relation (associable by id, ADR-0014). Kept in lockstep with that
  // constructor deliberately — `creatable`/`updatable` narrow the same set
  // the deserializer falls back to when no DTO is registered.
  //
  // A composite-key entity (issue #261) has no single `idField` to exclude
  // — its key columns are a *natural* key the client supplies on
  // `createOne`, so they stay in the writable base and `creatable`'s
  // default. They are immutable afterward, so `updatable`'s default
  // excludes them explicitly instead — the one place `creatable` and
  // `updatable` genuinely diverge from their shared `writableBase`.
  const compositeIdFields = metadata.compositeIdFields;
  const writableColumns = metadata.fields
    .filter((field) => !field.generated && (compositeIdFields !== undefined || field.name !== metadata.idField))
    .map((field) => field.name);
  const writableBase = [...writableColumns, ...(relationNames as readonly string[])] as unknown as readonly FieldPath<
    Entity,
    1
  >[];
  const updatableBase =
    compositeIdFields === undefined
      ? writableBase
      : ((writableBase as readonly string[]).filter(
          (name) => !compositeIdFields.includes(name),
        ) as unknown as readonly FieldPath<Entity, 1>[]);
  const configured = entityConfig?.allowed;
  // `allowed.selectable` addresses this entity's own columns and its
  // declared computed-field names — nothing else (ADR-0045). A relation is
  // selected with `select[<relation>]=`, never `select=<relation>.<field>`,
  // and an included relation's projection is governed by the *target*
  // entity's own `selectable` (ADR-0026 decision 4). A relation-dotted
  // entry here — an ADR-0044 ceiling, a relation-headed typo, or an `a.b.c`
  // deep path — is therefore a bootstrap error, not a silently inert line.
  rejectRelationDottedSelectable(metadata.name, selectableBase as readonly string[], configured?.selectable);
  const selectableResolved = resolveFieldSelector(
    selectableBase,
    configured?.selectable,
  ) as unknown as readonly FieldPath<Entity>[];
  // `filterable`/`sortable` feed `@kavo/typeorm`'s `columnRef`, which
  // interpolates the field string raw into SQL (join paths, `where(...)`,
  // `addOrderBy(...)`) — identifiers can't be parameter-bound. An explicit
  // array override is used verbatim (`resolveFieldSelector`'s plain-array
  // branch), so an entry here is the *only* thing standing between an HTTP
  // client and a raw SQL identifier. A bare (non-dotted) entry is checked
  // against this entity's own columns, its relation names (filtering by a
  // to-one relation's FK directly, e.g. `filter[author][eq]=1`), and its
  // computed-field names (left for the existing, more specific
  // COMPUTED_REJECTION check below to name); a relation-dotted entry can't
  // be checked the same way — its target metadata isn't in scope here — so
  // each of its segments is instead checked against a strict identifier
  // charset, closing the injection surface even without cross-entity
  // metadata (issue #367 finding 1). `@kavo/typeorm`'s `columnRef`
  // re-checks the charset at request time as defense in depth; this is the
  // fail-fast bootstrap half.
  const knownFieldNames = [
    ...(ownColumns as readonly string[]),
    ...(relationNames as readonly string[]),
    ...Object.keys(computed),
  ];
  validateAllowlistFieldNames(metadata.name, "filterable", configured?.filterable, knownFieldNames);
  validateAllowlistFieldNames(metadata.name, "sortable", configured?.sortable, knownFieldNames);
  const allowed = {
    filterable: resolveFieldSelector(ownColumns, configured?.filterable),
    sortable: resolveFieldSelector(ownColumns, configured?.sortable),
    selectable: selectableResolved,
    includable: resolveIncludableSelector(metadata.name, relationNames, configured?.includable),
    // Unlike `filterable`/`sortable`, its unconfigured default is narrower
    // than "every own column" — a non-string column has nothing an `ILIKE`
    // fragment can usefully match (doc 05 §4).
    searchable: resolveFieldSelector(stringColumns, configured?.searchable),
    creatable: resolveFieldSelector(writableBase, configured?.creatable),
    updatable: resolveFieldSelector(updatableBase, configured?.updatable),
  };
  const COMPUTED_REJECTION = {
    filterable: { verb: "filtered on", clause: "WHERE" },
    sortable: { verb: "sorted on", clause: "ORDER BY" },
    searchable: { verb: "searched on", clause: "WHERE" },
  } as const;
  for (const key of ["filterable", "sortable", "searchable"] as const) {
    for (const field of allowed[key] as readonly string[]) {
      if (!Object.prototype.hasOwnProperty.call(computed, field)) {
        continue;
      }
      const { verb, clause } = COMPUTED_REJECTION[key];
      throw new ConfigurationException(
        metadata.name,
        `allowed.${key}`,
        `'${field}' is a computed field on '${metadata.name}', which can never be ${verb} — ` +
          `it has no column to translate to ${clause}`,
      );
    }
  }
  // Computed fields have no column behind them, so they can never be
  // written (ADR-0019) — `creatable`/`updatable` reject one by name at
  // bootstrap for the same reason `rejectComputedWriteDtoKeys` rejects one
  // named in a write DTO, rather than letting it fall out silently later.
  for (const key of ["creatable", "updatable"] as const) {
    for (const field of allowed[key] as readonly string[]) {
      if (!Object.prototype.hasOwnProperty.call(computed, field)) {
        continue;
      }
      throw new ConfigurationException(
        metadata.name,
        `allowed.${key}`,
        `'${field}' is a computed field on '${metadata.name}', which is never writable (ADR-0019) — ` +
          `it has no column behind it`,
      );
    }
  }
  // `searchable`'s *default* is filtered to string-kind own columns, but an
  // explicit override is used verbatim (`resolveFieldSelector`) — so a
  // deliberately (or mistakenly) named non-string own column would
  // otherwise slip past bootstrap and only fail at request time, as a raw
  // driver error (`LOWER(int)` has no meaning) rather than the clean 400
  // every other misconfiguration in this file produces. Own columns are
  // checkable here; a relation-path entry (`'brand.createdAt'`) is not —
  // its target metadata isn't in scope — so it stays unchecked, the same
  // laxity `filterable`/`sortable` already have for relation paths.
  const fieldKinds = new Map(metadata.fields.map((field) => [field.name, field.kind]));
  for (const field of allowed.searchable as readonly string[]) {
    if (field.includes(".")) {
      continue;
    }
    const kind = fieldKinds.get(field);
    if (kind !== undefined && kind !== "string") {
      throw new ConfigurationException(
        metadata.name,
        "allowed.searchable",
        `'${field}' is a '${kind}'-kind column on '${metadata.name}', which an 'ILIKE' fragment ` +
          `cannot usefully match — 'searchable' entries must be string-kind columns, or relation paths`,
      );
    }
  }
  return deepFreeze(allowed);
}

/**
 * Cross-checks the `defaults` block against the `allowed` allowlists it
 * omission-defaults for (issue #375, ADR-0028's precedent for the
 * `include` half): `defaults.sort` fields against `sortable`,
 * `defaults.select` fields against `selectable`, and `defaults.include`
 * relations against `includable` — the same checks each axis's
 * client-supplied counterpart gets at request time, but here, at
 * bootstrap, so a misconfigured default fails fast instead of surfacing as
 * a broken `ORDER BY`, an over-wide response, or a relation clients cannot
 * ask for on the first request.
 */
export function validateDefaults<Entity>(
  scope: string,
  settings: KavoSettings,
  allowed: ResolvedQueryAllowed<Entity>,
): void {
  const sortable = allowed.sortable as readonly string[];
  for (const entry of settings.defaults.sort) {
    const field = entry.startsWith("-") ? entry.slice(1) : entry;
    if (!sortable.includes(field)) {
      throw new ConfigurationException(scope, "defaults.sort", `field '${field}' is not in the sortable allowlist`);
    }
  }

  if (settings.defaults.select !== undefined) {
    const selectable = allowed.selectable as readonly string[];
    for (const field of settings.defaults.select) {
      if (!selectable.includes(field)) {
        throw new ConfigurationException(
          scope,
          "defaults.select",
          `field '${field}' is not in the selectable allowlist`,
        );
      }
    }
  }

  const includable = new Set(allowed.includable as readonly string[]);
  for (const relation of settings.defaults.include) {
    if (!includable.has(relation)) {
      throw new ConfigurationException(
        scope,
        "defaults.include",
        `'${relation}' is not on allowed.includable, so it would load a relation clients cannot ask for`,
      );
    }
  }
}

/**
 * Bootstrap validation for `pagination.strategy: "since"` (ADR-0022):
 * `pagination.since.field` names a real, `date`- or `string`-kind column
 * on `filterable` and `selectable`, and `idField` (the forced sort's
 * tiebreaker) is too. Unlike cursor pagination's equivalent check
 * (`QueryNormalizer.resolveKeyset`, run per request against the *effective*
 * sort, which is client-choosable), the since strategy's sort is *forced*
 * and entirely config-known — the same reason `resolveSoftDelete` validates
 * its marker field here rather than per request. A third-party strategy
 * that also emits a `since`-shaped `Pagination` under another name is not
 * covered — this check is name-gated on the literal `"since"`, the same
 * way the settings-shape checks above are.
 *
 * No-op for any other strategy, including a custom one registered as
 * `"since"` by name coincidence — that misconfiguration surfaces instead
 * as a normal per-request query issue once `QueryNormalizer` runs.
 */
function validateSincePagination<Entity extends object>(
  scope: string,
  metadata: EntityMetadata<Entity>,
  settings: KavoSettings,
  allowed: ResolvedQueryAllowed<Entity>,
): void {
  if (settings.pagination.strategy !== "since") {
    return;
  }
  const { field } = settings.pagination.since;
  const filterable = allowed.filterable as readonly string[];
  const selectable = allowed.selectable as readonly string[];

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
        `${reason} '${column}' must be on the filterable allowlist for 'since' pagination to compose its keyset predicate`,
      );
    }
    if (!selectable.includes(column)) {
      throw new ConfigurationException(
        scope,
        "pagination.since.field",
        `${reason} '${column}' must be on the selectable allowlist for 'since' pagination to read the next boundary off a row`,
      );
    }
  }
}

/**
 * Resolves one allowlist key's raw selector against that key's **base
 * set** — own columns for `filterable`/`sortable`, own columns plus the
 * selectable computed fields for `selectable`. An explicit array is used
 * as-is; `{ exclude }` resolves to `base` minus the named paths, so a path
 * outside `base` can never appear via `exclude` and stays fail-closed like
 * the plain default.
 */
/**
 * The default response projection, or `null` for "leave it derived"
 * (ADR-0026).
 *
 * Explicit configuration is the trigger: an unwritten `selectable` narrows
 * nothing, which is what keeps this change confined to entities that asked
 * for it.
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
  allowed: ResolvedQueryAllowed<Entity>,
): readonly FieldPath<Entity>[] | null {
  const selector = entityConfig?.allowed?.selectable;
  if (selector === undefined) {
    return null;
  }
  if (!("exclude" in selector)) {
    return allowed.selectable;
  }
  const readable = [...metadata.fields.map((field) => field.name), ...Object.keys(computed)];
  const excluded = new Set(selector.exclude as readonly string[]);
  return readable.filter((name) => !excluded.has(name)) as unknown as readonly FieldPath<Entity>[];
}

/**
 * `allowed.selectable` addresses this entity's own columns and its
 * declared computed-field names — nothing else (ADR-0045). A relation is
 * selected with `select[<relation>]=`, and an included relation's
 * projection is governed by the *target* entity's own `selectable`
 * (ADR-0026 decision 4), never the including entity's config.
 *
 * So a relation-dotted `selectable` entry has no meaning here and is a
 * bootstrap `ConfigurationException`, in both the array and the
 * `{ exclude }` form. The check: an entry that contains a `.` and is not
 * itself a known field name — which catches an ADR-0044 ceiling entry
 * (`dictionary.id`), a relation-headed typo (`notARelation.field`), and an
 * `a.b.c` deep path in one rule. A genuine dotted column name (no adapter
 * emits one today, but the rule stays precise) is left alone.
 *
 * `known` is the entity's own column names plus its computed-field names —
 * `selectableBase`. Computed-field descriptors declaring `selectable:
 * false` are absent from that set but also never carry a `.`, so the
 * distinction does not matter here.
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
  const keyPath = "exclude" in selector ? "allowed.selectable.exclude" : "allowed.selectable";
  for (const entry of entries as readonly string[]) {
    if (!entry.includes(".") || knownNames.has(entry)) {
      continue;
    }
    throw new ConfigurationException(
      entityName,
      keyPath,
      `'${entry}' is a relation-dotted path. allowed.selectable takes ${entityName}'s own columns and ` +
        `computed-field names only — an included relation's projection is governed by the target entity's own ` +
        `allowed.selectable (ADR-0045). Drop this entry, or restrict the relation on the target entity's config.`,
    );
  }
}

/**
 * Generic over the path type so it serves both `QueryFieldSelector`
 * (depth-capped-3 `FieldPath`) and `WritableFieldSelector` (depth-1) — the
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

/** Letters, digits, underscore, not leading with a digit — same charset `@kavo/typeorm`'s `columnRef` enforces at request time. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Bootstrap check for an explicit `filterable`/`sortable` array override
 * (issue #367 finding 1). These allowlists gate the *only* two client
 * inputs `@kavo/typeorm` interpolates raw into SQL — a join path and a
 * `where`/`addOrderBy` column reference, neither of which can be
 * parameter-bound — so an explicit array here is used verbatim
 * (`resolveFieldSelector`'s plain-array branch) with nothing else standing
 * between it and the driver. `{ exclude }` overrides are skipped: they
 * subtract from `base`, which is already known-safe own columns.
 *
 * A bare entry must name a real own column, relation, or computed field on
 * the entity; a relation-dotted entry (`profile.city`) can't be checked
 * against real metadata here — the target entity is out of scope for a
 * single entity's config resolution — so each of its segments is instead
 * required to look like an identifier. Either failure is a bootstrap
 * `ConfigurationException`, not a runtime 400: a bad allowlist entry is a
 * configuration bug, not a client mistake. Naming a real relation or
 * computed field is still generally wrong (a relation isn't a scalar
 * column, a computed field has none) — that is caught by the existing,
 * more specific checks downstream in `resolveAllowed`, which this
 * function defers to rather than duplicating.
 */
function validateAllowlistFieldNames(
  entityName: string,
  key: "filterable" | "sortable",
  selector: readonly string[] | { readonly exclude: readonly string[] } | undefined,
  knownFieldNames: readonly string[],
): void {
  if (selector === undefined || "exclude" in selector) {
    return;
  }
  const known = new Set(knownFieldNames);
  for (const field of selector) {
    const segments = field.split(".");
    if (segments.length === 1) {
      if (!known.has(field)) {
        throw new ConfigurationException(
          entityName,
          `allowed.${key}`,
          `'${field}' is not a column on '${entityName}' — allowed.${key} entries must name a real ` +
            `column, or a relation path ('relation.field') for a relation-dotted entry.`,
        );
      }
      continue;
    }
    for (const segment of segments) {
      if (!IDENTIFIER.test(segment)) {
        throw new ConfigurationException(
          entityName,
          `allowed.${key}`,
          `'${field}' is not a valid relation path — '${segment}' is not a valid identifier. ` +
            `allowed.${key} entries reach raw SQL unquoted, so every segment must be letters, digits, ` +
            `and underscores only.`,
        );
      }
    }
  }
}

/**
 * `includable`'s own resolver, not `resolveFieldSelector` reused: the
 * unconfigured default is `[]`, not `base` — the opt-in direction
 * `QueryAllowed.includable`'s doc comment calls out (ADR-0028). An
 * explicit array is used verbatim (and is checked for typos later, when
 * `DefaultRelationRegistry` builds the registry); `{ exclude }` still
 * resolves against `base` (every relation), so `{ exclude: [] }` is the one
 * spelling that opts every relation in at once.
 *
 * `{ exclude }`'s own names *are* checked here, unlike `resolveFieldSelector`'s
 * — a name that matches nothing in `base` would otherwise silently exclude
 * nothing, so `{ exclude: ["ptes"] }` on an entity whose relation is actually
 * `pets` would open *every* relation instead of the one name meant to stay
 * closed. That is a worse failure mode here than on `filterable`/`sortable`/
 * `selectable`: this is the one allowlist that is fail-closed by default, so
 * a typo silently flipping it wide open is exactly the mistake the opt-in
 * default exists to prevent.
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
      "allowed.includable.exclude",
      `'${name}' is not a relation of ${entityName} (relations: ${[...known].join(", ") || "none"})`,
    );
  }
  const excluded = new Set(selector.exclude);
  return base.filter((path) => !excluded.has(path));
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
    allowed: config.allowed,
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
