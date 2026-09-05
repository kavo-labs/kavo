import type { KavoSettings } from "./settings.js";
import type { DeepPartial } from "../types/utility.js";
import type { EntityConfig, OperationConfig, RelationFieldSelector, SelectableFieldSelector } from "./entity-config.js";
import type { ResolvedEntityConfig, ResolvedQueryAllowlists } from "./resolved-entity-config.js";
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
  "query",
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
 * keys (`dto`, `allowlists`, `handler`, …); only the settings subset
 * participates in the merge algebra.
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
 * Backfill `query.search`'s `mode`/`driver` after a merge. `false` (the
 * default) stays `false` — search off. Any object turns search on, and a
 * nearer scope re-enabling from `false` may name only the keys it changes
 * (`search: { mode: "words" }`), so the missing ones fall back to the
 * built-in defaults here rather than being left `undefined`.
 */
function normalizeSearch(settings: KavoSettings): KavoSettings {
  const search = settings.query.search;
  if (search === false) {
    return settings;
  }
  const defaults = BUILT_IN_DEFAULT_SEARCH;
  return {
    ...settings,
    query: {
      ...settings.query,
      search: { mode: search.mode ?? defaults.mode, driver: search.driver ?? defaults.driver },
    },
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
  rejectDerivedWriteDtoKeys(entityName, metadata, entityConfig);
  const policy = resolvePolicy(entityName, entityConfig, globalPolicy);
  const allowlists = resolveAllowlists(metadata, entityConfig);
  const projection = resolveProjection(metadata, entityConfig, allowlists);
  const entitySettings = normalizeSearch(
    mergeSettings(
      BUILT_IN_DEFAULTS,
      globalDefaults,
      pickSettings(entityConfig as Readonly<Record<string, unknown>> | undefined),
    ),
  );
  validateSettings(entityName, entitySettings);
  validateDefaultSort(entityName, entitySettings, allowlists);
  validateSincePagination(entityName, metadata, entitySettings, allowlists);
  validateIncludableRelations(entityName, entitySettings, allowlists);
  const relations = new DefaultRelationRegistry<Entity>(
    metadata.relations,
    allowlists.includable as readonly string[],
    entitySettings.relations.edges,
    entityName,
    entitySettings.arrayMutation,
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
    validateDefaultSort(scope, merged, allowlists);
    validateSincePagination(scope, metadata, merged, allowlists);
    validateIncludableRelations(scope, merged, allowlists);
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
    allowlists,
    projection,
    softDelete: resolveSoftDelete(metadata, entitySettings),
    dto: new DefaultDtoResolver<Entity>(entityConfig?.dto),
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

/** The DTO slots whose classes describe a **write** payload. */
const WRITE_DTO_SLOTS = ["create", "update", "patch"] as const;

/**
 * A registered `create`/`update`/`patch` DTO naming an ORM-derived field
 * (`FieldMetadata.derivedExpression`) is a bootstrap error.
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
 * writable projection, which never contains a derived-field name.
 */
function rejectDerivedWriteDtoKeys<Entity extends object>(
  entityName: string,
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
): void {
  const names = new Set(
    metadata.fields.filter((field) => field.derivedExpression !== undefined).map((field) => field.name),
  );
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
      `the '${slot}' DTO declares '${declared}', which is an ORM-derived field on '${entityName}' — ` +
        `a derived field has no writable storage behind it, so the value is stripped from every write ` +
        `payload while the generated OpenAPI body still advertises the property; drop it from the DTO`,
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
 * ORM-derived fields (`FieldMetadata.derivedExpression`) are excluded from
 * every default base and must be opted in explicitly via `allowlists` —
 * the same rule a relation follows (ADR-0046): metadata supplies shape,
 * never permission.
 */
function resolveAllowlists<Entity extends object>(
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
): ResolvedQueryAllowlists<Entity> {
  const ownFields = metadata.fields.filter((field) => field.derivedExpression === undefined);
  const derivedNames = new Set(
    metadata.fields.filter((field) => field.derivedExpression !== undefined).map((field) => field.name),
  );
  const ownColumns = ownFields.map((field) => field.name) as unknown as readonly FieldPath<Entity>[];
  const stringColumns = ownFields
    .filter((field) => field.kind === "string")
    .map((field) => field.name) as unknown as readonly FieldPath<Entity>[];
  const selectableBase = ownColumns;
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
  const writableColumns = ownFields
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
  const configured = entityConfig?.allowlists;
  // `allowlists.selectable` addresses this entity's own columns and,
  // opted in explicitly, its ORM-derived fields — nothing else (ADR-0045).
  // A relation is
  // selected with `select[<relation>]=`, never `select=<relation>.<field>`,
  // and an included relation's projection is governed by the *target*
  // entity's own `selectable` (ADR-0026 decision 4). A relation-dotted
  // entry here — an ADR-0044 ceiling, a relation-headed typo, or an `a.b.c`
  // deep path — is therefore a bootstrap error, not a silently inert line.
  rejectRelationDottedSelectable(
    metadata.name,
    selectableBase as readonly string[],
    configured?.selectable as unknown as SelectableFieldSelector<object> | undefined,
  );
  const selectableResolved = resolveFieldSelector(
    selectableBase,
    configured?.selectable,
  ) as unknown as readonly FieldPath<Entity>[];
  const allowlists = {
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
  // `searchable` has no ORM-independent way to translate a derived
  // expression into an `ILIKE` fragment, so a derived field can never join
  // it, opted in explicitly or not.
  for (const field of allowlists.searchable as readonly string[]) {
    if (!derivedNames.has(field)) {
      continue;
    }
    throw new ConfigurationException(
      metadata.name,
      "allowlists.searchable",
      `'${field}' is an ORM-derived field on '${metadata.name}', which can never be searched on — ` +
        `it has no column to translate to a 'WHERE ... ILIKE' fragment`,
    );
  }
  // Derived fields have no writable storage behind them, so they can never
  // be written — `creatable`/`updatable` reject one by name at bootstrap
  // for the same reason `rejectDerivedWriteDtoKeys` rejects one named in a
  // write DTO, rather than letting it fall out silently later.
  for (const key of ["creatable", "updatable"] as const) {
    for (const field of allowlists[key] as readonly string[]) {
      if (!derivedNames.has(field)) {
        continue;
      }
      throw new ConfigurationException(
        metadata.name,
        `allowlists.${key}`,
        `'${field}' is an ORM-derived field on '${metadata.name}', which is never writable — ` +
          `it has no writable storage behind it`,
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
  for (const field of allowlists.searchable as readonly string[]) {
    if (field.includes(".")) {
      continue;
    }
    const kind = fieldKinds.get(field);
    if (kind !== undefined && kind !== "string") {
      throw new ConfigurationException(
        metadata.name,
        "allowlists.searchable",
        `'${field}' is a '${kind}'-kind column on '${metadata.name}', which an 'ILIKE' fragment ` +
          `cannot usefully match — 'searchable' entries must be string-kind columns, or relation paths`,
      );
    }
  }
  return deepFreeze(allowlists);
}

/**
 * `query.defaultSort` fields are checked against the same sortable
 * allowlist client-supplied `sort` fields are checked against at request
 * time — but here, at bootstrap, so a misconfigured default fails fast
 * instead of surfacing as a broken `ORDER BY` on the first request.
 */
export function validateDefaultSort<Entity>(
  scope: string,
  settings: KavoSettings,
  allowlists: ResolvedQueryAllowlists<Entity>,
): void {
  const sortable = allowlists.sortable as readonly string[];
  for (const entry of settings.query.defaultSort) {
    if (!sortable.includes(entry.field)) {
      throw new ConfigurationException(
        scope,
        "query.defaultSort",
        `field '${entry.field}' is not in the sortable allowlist`,
      );
    }
  }
}

/**
 * Cross-checks `relations.edges.<name>.defaultInclude` against
 * `allowlists.includable` (ADR-0028): `defaultInclude: true` on a relation
 * the entity never opted into `include=` would load something clients
 * cannot ask for — the same rule `validate-settings.ts` enforced when
 * `defaultInclude` and `includable` lived on the same `edges` entry, now
 * checked against the allowlist that carries permission instead.
 */
function validateIncludableRelations<Entity>(
  scope: string,
  settings: KavoSettings,
  allowlists: ResolvedQueryAllowlists<Entity>,
): void {
  const includable = new Set(allowlists.includable as readonly string[]);
  for (const [name, edge] of Object.entries(settings.relations.edges)) {
    if (edge.defaultInclude === true && !includable.has(name)) {
      throw new ConfigurationException(
        scope,
        `relations.edges.${name}`,
        `defaultInclude requires an includable relation — '${name}' is not on allowlists.includable, ` +
          `so it would load a relation clients cannot ask for`,
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
  allowlists: ResolvedQueryAllowlists<Entity>,
): void {
  if (settings.pagination.strategy !== "since") {
    return;
  }
  const { field } = settings.pagination.since;
  const filterable = allowlists.filterable as readonly string[];
  const selectable = allowlists.selectable as readonly string[];

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
 * derived-and-explicitly-opted-in fields for `selectable`. An explicit
 * array is used as-is; `{ exclude }` resolves to `base` minus the named
 * paths, so a path outside `base` can never appear via `exclude` and stays
 * fail-closed like the plain default.
 */
/**
 * The default response projection, or `null` for "leave it derived"
 * (ADR-0026).
 *
 * Explicit configuration is the trigger: an unwritten `selectable` narrows
 * nothing, which is what keeps this change confined to entities that asked
 * for it.
 *
 * The two spellings resolve against the **same base** — the entity's own
 * (non-derived) columns. A plain array is the author's own list and is
 * used verbatim, and can name an opted-in derived field explicitly.
 * `{ exclude }` means "every own column except these" — a derived field is
 * opt-in only (ADR-0046) and so is never reachable through `{ exclude }`,
 * the same as a relation.
 */
function resolveProjection<Entity extends object>(
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
  allowlists: ResolvedQueryAllowlists<Entity>,
): readonly FieldPath<Entity>[] | null {
  const selector = entityConfig?.allowlists?.selectable;
  if (selector === undefined) {
    return null;
  }
  if (!("exclude" in selector)) {
    return allowlists.selectable;
  }
  const readable = metadata.fields.filter((field) => field.derivedExpression === undefined).map((field) => field.name);
  const excluded = new Set(selector.exclude as readonly string[]);
  return readable.filter((name) => !excluded.has(name)) as unknown as readonly FieldPath<Entity>[];
}

/**
 * `allowlists.selectable` addresses this entity's own columns — and, opted
 * in explicitly, its ORM-derived fields (ADR-0046) — nothing else
 * (ADR-0045). A relation is selected with `select[<relation>]=`, and an
 * included relation's projection is governed by the *target* entity's own
 * `selectable` (ADR-0026 decision 4), never the including entity's config.
 *
 * So a relation-dotted `selectable` entry has no meaning here and is a
 * bootstrap `ConfigurationException`, in both the array and the
 * `{ exclude }` form. The check: an entry that contains a `.` and is not
 * itself a known field name — which catches an ADR-0044 ceiling entry
 * (`dictionary.id`), a relation-headed typo (`notARelation.field`), and an
 * `a.b.c` deep path in one rule. A genuine dotted column name (no adapter
 * emits one today, but the rule stays precise) is left alone.
 *
 * `known` is the entity's own column names — `selectableBase`.
 */
function rejectRelationDottedSelectable(
  entityName: string,
  known: readonly string[],
  selector: SelectableFieldSelector<object> | undefined,
): void {
  if (selector === undefined) {
    return;
  }
  const knownNames = new Set(known);
  const entries = "exclude" in selector ? selector.exclude : selector;
  const keyPath = "exclude" in selector ? "allowlists.selectable.exclude" : "allowlists.selectable";
  for (const entry of entries as readonly string[]) {
    if (!entry.includes(".") || knownNames.has(entry)) {
      continue;
    }
    throw new ConfigurationException(
      entityName,
      keyPath,
      `'${entry}' is a relation-dotted path. allowlists.selectable takes ${entityName}'s own columns and ` +
        `opted-in derived-field names only — an included relation's projection is governed by the target entity's ` +
        `own allowlists.selectable (ADR-0045). Drop this entry, or restrict the relation on the target entity's config.`,
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

/**
 * `includable`'s own resolver, not `resolveFieldSelector` reused: the
 * unconfigured default is `[]`, not `base` — the opt-in direction
 * `QueryAllowlists.includable`'s doc comment calls out (ADR-0028). An
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
      "allowlists.includable.exclude",
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
    allowlists: config.allowlists,
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
