import type { KavoSettings } from "./settings.js";
import type { DeepPartial } from "../types/utility.js";
import type { ComputedFieldDescriptor, ComputedFieldMap } from "./computed-field.js";
import type { EntityConfig, OperationConfig, QueryFieldSelector, RelationFieldSelector } from "./entity-config.js";
import type { ResolvedEntityConfig, ResolvedQueryAllowlists } from "./resolved-entity-config.js";
import type { DtoClass } from "../dto/dto.js";
import type { EntityMetadata } from "../metadata/entity-metadata.js";
import type { FieldPath } from "../types/field-path.js";
import type { IncludePath } from "../types/include-path.js";
import type { OperationId, StandardOperationId } from "../operations/operation.js";
import type { RealtimeTransport } from "../realtime/realtime-transport.js";
import type { CacheStore } from "../caching/cache-store.js";
import type { PolicyNode } from "../policy/kavo-policy.js";
import { createMemoryCacheStore } from "../caching/cache-store.js";
import { STANDARD_OPERATION_IDS } from "../operations/operation.js";
import { collectOwnerFields, normalizePolicyShorthand, policyNeedsEntity } from "../policy/kavo-policy.js";
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
] as const satisfies readonly (keyof KavoSettings)[];

/**
 * An `EntityConfig`/`OperationConfig` mixes settings keys with structural
 * keys (`dto`, `allowlists`, `computed`, `handler`, …); only the settings
 * subset participates in the merge algebra.
 */
function pickSettings(config: Readonly<Record<string, unknown>> | undefined): DeepPartial<KavoSettings> | undefined {
  if (config === undefined) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (config[key] !== undefined) picked[key] = config[key];
  }
  return picked as DeepPartial<KavoSettings>;
}

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
): ResolvedEntityConfig<Entity> {
  const entityName = metadata.name;
  const computed = resolveComputedFields(metadata, entityConfig);
  rejectComputedWriteDtoKeys(entityName, entityConfig, computed);
  const policy = resolvePolicy(entityName, entityConfig, metadata);
  const allowlists = resolveAllowlists(metadata, entityConfig, computed);
  const projection = resolveProjection(metadata, entityConfig, computed, allowlists);
  const entitySettings = mergeSettings(
    BUILT_IN_DEFAULTS,
    globalDefaults,
    pickSettings(entityConfig as Readonly<Record<string, unknown>> | undefined),
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
    if (typeof config === "boolean") continue;
    const settings = pickSettings(config as Readonly<Record<string, unknown>>);
    if (settings === undefined || Object.keys(settings).length === 0) continue;
    const merged = mergeSettings(entitySettings, settings);
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
 * Operations with no single row to check an `owner`/`when` node against:
 * `createOne` has no entity yet, `findMany` has a set of rows rather than
 * one. Configuring an entity-aware node on either is a bootstrap error
 * (ADR-0032), not a runtime one — the same "catch it before it's baked in"
 * treatment every other bootstrap validation in this file gets.
 */
const ENTITY_AWARE_POLICY_FORBIDDEN: ReadonlySet<StandardOperationId> = new Set(["createOne", "findMany"]);

/**
 * Resolve `policy`: entity-scope `policy.<id>` with `operations.<id>.policy`
 * merged in where present (the latter wins, the same fallback `dto` uses),
 * normalized from the array shorthand, and validated against
 * {@link ENTITY_AWARE_POLICY_FORBIDDEN} (ADR-0032). Also rejects, at
 * bootstrap: an empty-array shorthand (`policy: { updateOne: [] }` reads
 * like "lock this down" but an empty `and()` is vacuously `true` — always
 * allow, the opposite of what it looks like); an `owner(field)` whose first
 * dotted segment names a relation (the pre-fetch loads no relations, so it
 * would silently deny every caller instead of ever passing); and a
 * `policy.<key>` naming something other than a standard operation id (a
 * typo that would otherwise protect nothing, silently).
 */
function resolvePolicy<Entity extends object>(
  entityName: string,
  entityConfig: EntityConfig<Entity> | undefined,
  metadata: EntityMetadata<Entity>,
): Readonly<Partial<Record<StandardOperationId, PolicyNode<Entity>>>> {
  const entityLevel = entityConfig?.policy ?? {};
  const relationNames = new Set(metadata.relations.map((relation) => relation.name));

  for (const key of Object.keys(entityLevel)) {
    if (!STANDARD_OPERATION_IDS.includes(key as StandardOperationId)) {
      throw new ConfigurationException(
        entityName,
        `policy.${key}`,
        `'${key}' is not a standard operation id (${STANDARD_OPERATION_IDS.join(", ")}) — ` +
          `a misspelled key here protects nothing`,
      );
    }
  }

  const resolved: Partial<Record<StandardOperationId, PolicyNode<Entity>>> = {};
  for (const id of STANDARD_OPERATION_IDS) {
    const operationConfig = entityConfig?.operations?.[id];
    const operationShorthand =
      typeof operationConfig === "object" && operationConfig !== null
        ? (operationConfig as OperationConfig<Entity>).policy
        : undefined;
    const shorthand = operationShorthand ?? entityLevel[id];
    if (shorthand === undefined) continue;
    if (Array.isArray(shorthand) && shorthand.length === 0) {
      throw new ConfigurationException(
        entityName,
        `policy.${id}`,
        `an empty permission array allows every caller — vacuously true, the opposite of what it reads as. ` +
          `Name at least one permission, or omit '${id}' from 'policy' to leave it genuinely unrestricted`,
      );
    }
    const node = normalizePolicyShorthand(shorthand);
    if (ENTITY_AWARE_POLICY_FORBIDDEN.has(id) && policyNeedsEntity(node)) {
      throw new ConfigurationException(
        entityName,
        `policy.${id}`,
        `'${id}' has no single entity to check an 'owner'/'when' node against — ` +
          `${id === "createOne" ? "the row doesn't exist yet" : "it resolves a set of rows, not one"}. ` +
          `Use 'permission'/'role'/'authenticated' here instead.`,
      );
    }
    for (const field of collectOwnerFields(node)) {
      const [first] = field.split(".");
      if (first !== undefined && relationNames.has(first)) {
        throw new ConfigurationException(
          entityName,
          `policy.${id}`,
          `owner('${field}') crosses the '${first}' relation — the policy stage's pre-fetch loads no relations, ` +
            `so this would silently deny every caller. Address a column on the entity itself, or check the ` +
            `relation from inside a 'when()' predicate, which can load it through 'context.repository' itself`,
        );
      }
    }
    resolved[id] = node;
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
  if (declared === undefined) return NO_COMPUTED_FIELDS;

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
  if (names.size === 0) return;
  const dto = entityConfig?.dto as Readonly<Record<string, DtoClass | undefined>> | undefined;
  if (dto === undefined) return;
  for (const slot of WRITE_DTO_SLOTS) {
    const declared = dtoShapeKeys(dto[slot] ?? null)?.find((key) => names.has(key));
    if (declared === undefined) continue;
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
 * Computed fields join the `selectable` base set (so `fields=fullName`
 * works with no further configuration) unless the descriptor opts out with
 * `selectable: false`, and are barred from `filterable`/`sortable`
 * outright — there is no column to translate to `WHERE`/`ORDER BY`
 * (ADR-0019).
 */
function resolveAllowlists<Entity extends object>(
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
  computed: ComputedFieldMap<Entity>,
): ResolvedQueryAllowlists<Entity> {
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
  const configured = entityConfig?.allowlists;
  const allowlists = {
    filterable: resolveFieldSelector(ownColumns, configured?.filterable),
    sortable: resolveFieldSelector(ownColumns, configured?.sortable),
    selectable: resolveFieldSelector(selectableBase, configured?.selectable),
    includable: resolveIncludableSelector(metadata.name, relationNames, configured?.includable),
    // Unlike `filterable`/`sortable`, its unconfigured default is narrower
    // than "every own column" — a non-string column has nothing an `ILIKE`
    // fragment can usefully match (doc 05 §4).
    searchable: resolveFieldSelector(stringColumns, configured?.searchable),
  };
  const COMPUTED_REJECTION = {
    filterable: { verb: "filtered on", clause: "WHERE" },
    sortable: { verb: "sorted on", clause: "ORDER BY" },
    searchable: { verb: "searched on", clause: "WHERE" },
  } as const;
  for (const key of ["filterable", "sortable", "searchable"] as const) {
    for (const field of allowlists[key] as readonly string[]) {
      if (!Object.prototype.hasOwnProperty.call(computed, field)) continue;
      const { verb, clause } = COMPUTED_REJECTION[key];
      throw new ConfigurationException(
        metadata.name,
        `allowlists.${key}`,
        `'${field}' is a computed field on '${metadata.name}', which can never be ${verb} — ` +
          `it has no column to translate to ${clause}`,
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
    if (field.includes(".")) continue;
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
  if (settings.pagination.strategy !== "since") return;
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
  for (const [column, reason] of [
    [field, "'pagination.since.field'"],
    [metadata.idField, "the forced tiebreaker 'idField'"],
  ] as const) {
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
 * in the projection while making its name a 400 in `fields=`, so
 * `{ exclude: ["email"] }` would silently delete an unrelated audit field
 * from every response. That is the same "narrowing by a list nobody wrote"
 * this function exists to prevent, one level down.
 */
function resolveProjection<Entity extends object>(
  metadata: EntityMetadata<Entity>,
  entityConfig: EntityConfig<Entity> | undefined,
  computed: ComputedFieldMap<Entity>,
  allowlists: ResolvedQueryAllowlists<Entity>,
): readonly FieldPath<Entity>[] | null {
  const selector = entityConfig?.allowlists?.selectable;
  if (selector === undefined) return null;
  if (!("exclude" in selector)) return allowlists.selectable;
  const readable = [...metadata.fields.map((field) => field.name), ...Object.keys(computed)];
  const excluded = new Set(selector.exclude as readonly string[]);
  return readable.filter((name) => !excluded.has(name)) as unknown as readonly FieldPath<Entity>[];
}

function resolveFieldSelector<Entity>(
  base: readonly FieldPath<Entity>[],
  selector: QueryFieldSelector<Entity> | undefined,
): readonly FieldPath<Entity>[] {
  if (selector === undefined) return base;
  if (!("exclude" in selector)) return selector;
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
  if (selector === undefined) return [];
  if (!("exclude" in selector)) return selector;
  const known = new Set<string>(base as readonly string[]);
  for (const name of selector.exclude) {
    if (known.has(name as string)) continue;
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
