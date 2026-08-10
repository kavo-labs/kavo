import type { OperationDescriptor, OperationRegistry } from "./operation-registry.js";
import type { OperationCardinality, OperationId, OperationKind, StandardOperationId } from "./operation.js";
import type { OperationHandler } from "./operation-handler.js";
import type { CustomOperationConfig, EntityConfig } from "../config/entity-config.js";
import type { DtoClass } from "../dto/dto.js";
import { ConfigurationException } from "../errors/exceptions.js";

/**
 * Map-backed operation registry, insertion-ordered.
 *
 * `entityName` exists purely so the configuration errors below can name the
 * entity they came from. It defaults the way `DefaultRelationRegistry`'s
 * does, and both real call sites (`createCrud`, `@Kavo`) supply the real
 * name — a config error reading `entity 'unknown'` was issue #7's third
 * finding.
 */
export class DefaultOperationRegistry<Entity = unknown> implements OperationRegistry<Entity> {
  private readonly entries = new Map<OperationId, OperationDescriptor<Entity>>();

  constructor(private readonly entityName: string = "entity") {}

  get(id: OperationId): OperationDescriptor<Entity> | undefined {
    return this.entries.get(id);
  }

  has(id: OperationId): boolean {
    return this.entries.has(id);
  }

  all(): readonly OperationDescriptor<Entity>[] {
    return [...this.entries.values()];
  }

  register(descriptor: OperationDescriptor<Entity>): void {
    this.entries.set(descriptor.id, descriptor);
  }

  replace(id: OperationId, handler: OperationHandler<Entity>): void {
    const existing = this.entries.get(id);
    if (existing === undefined) {
      throw new ConfigurationException(
        this.entityName,
        `operations.${id}`,
        `cannot override '${id}': no such registered operation (registered: ${this.idList()})`,
      );
    }
    this.entries.set(id, { ...existing, handler });
  }

  disable(id: OperationId): void {
    const existing = this.entries.get(id);
    if (existing === undefined) {
      throw new ConfigurationException(
        this.entityName,
        `operations.${id}`,
        `cannot disable '${id}': no such registered operation (registered: ${this.idList()})`,
      );
    }
    this.entries.set(id, { ...existing, enabled: false });
  }

  private idList(): string {
    return [...this.entries.keys()].sort().join(", ") || "none";
  }
}

interface StandardOperationShape {
  readonly kind: OperationKind;
  readonly cardinality: OperationCardinality;
  /** Whether the operation is on unless config says otherwise. */
  readonly enabled: boolean;
  /**
   * Operates on soft-deleted rows, so it only makes sense on a
   * soft-deletable entity. `restoreOne` switches on when the config
   * declares soft delete; `purgeOne` stays off until asked for by name.
   */
  readonly requiresSoftDelete?: boolean;
}

/**
 * The standard operation table. The engine dispatches every operation
 * through the registry — these are just its default entries (ADR-0006),
 * and `@kavo/nest` route generation walks the same registry.
 *
 * `enabled` here is the *unconditional* default;
 * `restoreOne`/`purgeOne` layer the soft-delete rule on top (see
 * {@link createOperationRegistry}).
 */
export const STANDARD_OPERATIONS: Readonly<Record<StandardOperationId, StandardOperationShape>> = Object.freeze({
  createOne: { kind: "write", cardinality: "one", enabled: true },
  findOne: { kind: "read", cardinality: "one", enabled: true },
  findMany: { kind: "read", cardinality: "many", enabled: true },
  updateOne: { kind: "write", cardinality: "one", enabled: true },
  patchOne: { kind: "write", cardinality: "one", enabled: true },
  deleteOne: { kind: "write", cardinality: "one", enabled: true },
  restoreOne: { kind: "write", cardinality: "one", enabled: false, requiresSoftDelete: true },
  purgeOne: { kind: "write", cardinality: "one", enabled: false, requiresSoftDelete: true },
});

/** The standard ids as a lookup, so the custom loop can skip them in O(1). */
const STANDARD_IDS: ReadonlySet<string> = new Set(Object.keys(STANDARD_OPERATIONS));

/**
 * The same ids keyed by their lowercase spelling, which is how a custom id
 * is checked for being a standard one with the wrong case
 * (`createOperationRegistry`).
 */
const STANDARD_IDS_BY_LOWERCASE: ReadonlyMap<string, string> = new Map(
  [...STANDARD_IDS].map((id) => [id.toLowerCase(), id]),
);

/** Provides the handler for one standard operation id. */
export type StandardHandlerFactory<Entity> = (id: StandardOperationId) => OperationHandler<Entity>;

type DtoOverrideField = "input" | "output" | "query";

/**
 * Which `dto.<field>` overrides (issue #131) are meaningful on each
 * standard operation — `StandardOperationsConfig` (`config/entity-config.ts`)
 * makes the same rule unrepresentable at the type level via `Pick`; this
 * is its runtime mirror, for configs built from an erased or cast type
 * (the same defence `resolveAllowlists` and `rejectComputedWriteDtoKeys`
 * apply to their own structural invariants). `deleteOne`/`purgeOne` are
 * void results with no query — neither field applies.
 */
const DTO_OVERRIDE_FIELDS: Readonly<Record<StandardOperationId, readonly DtoOverrideField[]>> = Object.freeze({
  createOne: ["input", "output"],
  findOne: ["output", "query"],
  findMany: ["output", "query"],
  updateOne: ["input", "output"],
  patchOne: ["input", "output"],
  deleteOne: [],
  restoreOne: ["output"],
  purgeOne: [],
});

/**
 * Which `dto.<field>` overrides a **custom** operation supports, derived
 * from its declared `kind` rather than looked up by id (issue #145). Same
 * rule the standard table above encodes, stated once: a read has no
 * request body to narrow, a write runs no query resolution.
 */
const CUSTOM_DTO_OVERRIDE_FIELDS: Readonly<Record<OperationKind, readonly DtoOverrideField[]>> = Object.freeze({
  read: ["output", "query"],
  write: ["input", "output"],
});

/**
 * Validates one entry's `operations.<id>.dto` against the fields that
 * operation actually has, and returns the three descriptor fields it
 * resolves to (`null` for an unset or inapplicable field).
 */
function resolveDtoOverride(
  entityName: string,
  id: OperationId,
  allowed: readonly DtoOverrideField[],
  settings: { readonly dto?: unknown } | undefined,
): Pick<OperationDescriptor, "input" | "output" | "query"> {
  const dto = settings?.dto as Readonly<Partial<Record<DtoOverrideField, DtoClass>>> | undefined;
  const resolved: Record<DtoOverrideField, DtoClass | null> = { input: null, output: null, query: null };
  if (dto === undefined) return resolved;

  for (const field of Object.keys(dto) as DtoOverrideField[]) {
    if (dto[field] === undefined) continue;
    if (!allowed.includes(field)) {
      throw new ConfigurationException(
        entityName,
        `operations.${id}.dto.${field}`,
        allowed.length === 0
          ? `'${id}' has a void result and no query, so a 'dto.${field}' override has nothing to narrow — remove it`
          : `'${id}' has no '${field}' position — it only supports ${allowed.map((f) => `'${f}'`).join(", ")}`,
      );
    }
    resolved[field] = dto[field] as DtoClass;
  }
  return resolved;
}

const unboundHandler = (id: OperationId, entityName: string): OperationHandler<unknown> => ({
  execute(): Promise<never> {
    throw new ConfigurationException(
      entityName,
      `operations.${id}`,
      `operation '${id}' has no bound handler — this registry was built ` + `for inspection (route generation) only`,
    );
  },
});

/**
 * Build one entity's operation registry from its config (the
 * control surface configures exactly this): one entry per **custom** id —
 * every `operations` key that is not one of the standard eight (issue
 * #145) — then the standard entries, honoring `operations.<id>: false`
 * (disable), `operations.<id>: true` / `{ enabled: true }` (enable), and
 * `operations.<id>.handler` (override — default scaffolding stays).
 *
 * **Custom entries come first, and that order is a routing decision.**
 * Registration order is route-generation order (ADR-0012), and an HTTP
 * router matches in the order routes were declared: registered after
 * `findOne`, a custom `GET /orders/pending` would be swallowed by
 * `GET /orders/:id` and answered with "'pending' is not a valid number"
 * rather than reaching its handler. A literal path has to be declared
 * before the parameterized one it resembles, so the custom half goes first.
 * The consequence in the other direction is deliberate too: a custom
 * operation whose `meta.routes` reproduces a standard route's shape wins
 * it, which is what an explicitly configured route should do.
 *
 * A standard *id* is still resolved only by the standard loop — the custom
 * loop skips those keys outright — so `operations.deleteOne` is an override
 * of the standard entry, never a redefinition of it, whatever it carries.
 *
 * The soft-delete operations default from the config alone, never
 * from ORM metadata: `restoreOne` turns on when the entity config
 * declares soft delete (`softDelete.strategy: "soft"` or an explicit
 * `softDelete.field`), `purgeOne` only when named outright. Route
 * generation runs at decoration time, where no ORM metadata exists
 * (ADR-0012), so both registry builds — engine and `@kavo/nest` — must
 * reach the same answer from the same input (ADR-0013). Enabling either
 * on an entity that does not resolve to a soft delete strategy is a
 * bootstrap error, raised in `createCrud` where metadata is known.
 *
 * `handlers` binds the built-in behaviors; when omitted the entries carry
 * throwing placeholders — that mode exists for consumers that only need
 * the table (`@kavo/nest` route generation), never for execution.
 *
 * `globalOperations` is the resolved `KavoSettings.operations` boolean map
 * (issue #38's global default): it fills `byDefault` for an id the entity
 * config doesn't mention at all, sitting between the unconditional/soft-delete
 * default and the entity's own `operations.<id>` — which always wins when
 * present, boolean shorthand or long form alike.
 *
 * `entityName` is only ever read back out in a configuration error's text.
 * It is a trailing optional rather than a leading one, and the three
 * optionals were deliberately *not* consolidated into an options bag:
 * this factory is a barrel export, so a bag would be a breaking change to
 * public API bought for a nicer call at two internal sites.
 */
export function createOperationRegistry<Entity extends object>(
  config: EntityConfig<Entity> | undefined,
  handlers?: StandardHandlerFactory<Entity>,
  globalOperations?: Readonly<Partial<Record<StandardOperationId, boolean>>>,
  entityName?: string,
): OperationRegistry<Entity> {
  const registry = new DefaultOperationRegistry<Entity>(entityName);
  const scope = entityName ?? "entity";
  const operations = config?.operations ?? {};
  const softDeleteDeclared = declaresSoftDelete(config);

  for (const [id, entry] of Object.entries(operations as unknown as Readonly<Record<string, unknown>>)) {
    if (STANDARD_IDS.has(id)) continue;
    registerCustomOperation(registry, scope, id, entry);
  }

  for (const [id, shape] of Object.entries(STANDARD_OPERATIONS) as [StandardOperationId, StandardOperationShape][]) {
    const operationConfig = operations[id];
    const settings = typeof operationConfig === "object" ? operationConfig : undefined;
    rejectCustomOperationKeys(scope, id, settings as Readonly<Record<string, unknown>> | undefined);
    const byDefault = shape.enabled || (id === "restoreOne" && softDeleteDeclared);
    const defaultForEntity = globalOperations?.[id] ?? byDefault;
    const dtoOverride = resolveDtoOverride(scope, id, DTO_OVERRIDE_FIELDS[id], settings);
    registry.register({
      id,
      kind: shape.kind,
      cardinality: shape.cardinality,
      enabled: typeof operationConfig === "boolean" ? operationConfig : (settings?.enabled ?? defaultForEntity),
      handler:
        settings?.handler ??
        handlers?.(id) ??
        (unboundHandler(id, entityName ?? "entity") as unknown as OperationHandler<Entity>),
      ...dtoOverride,
      meta: settings?.meta ?? {},
    });
  }
  return registry;
}

/**
 * Validate one custom `operations` entry and register it.
 *
 * Everything here is a bootstrap `ConfigurationException` naming the entity
 * and the key path, because a custom operation is declared once and every
 * way of getting it wrong is knowable then. The type system rejects most of
 * these already (`CustomOperationConfig` requires `handler` and closes
 * `kind`/`cardinality` to their unions); this is the runtime mirror, for
 * configs that arrive erased or cast — the same defence `resolveAllowlists`
 * and `rejectComputedWriteDtoKeys` apply to their own invariants.
 */
function registerCustomOperation<Entity extends object>(
  registry: OperationRegistry<Entity>,
  entityName: string,
  id: string,
  entry: unknown,
): void {
  // A standard id spelled with the wrong case is the one near-miss worth
  // catching: ids are camelCase by convention, so `deleteone` is a slip
  // rather than a name, and silently registering a second, unrelated
  // operation next to the real `deleteOne` is the worst possible answer.
  // Any other resemblance is left alone — a custom id is arbitrary by
  // definition, and `findAny` is a legitimate name however close it reads
  // to `findOne`.
  const shadowed = STANDARD_IDS_BY_LOWERCASE.get(id.toLowerCase());
  if (shadowed !== undefined) {
    throw new ConfigurationException(
      entityName,
      `operations.${id}`,
      `'${id}' differs from the standard operation '${shadowed}' only by case — operation ids are ` +
        `camelCase, so this registers a second, unrelated operation instead of configuring '${shadowed}'`,
    );
  }
  if (typeof entry !== "object" || entry === null) {
    throw new ConfigurationException(
      entityName,
      `operations.${id}`,
      `'${id}' is not a standard operation, so it declares a custom one and needs a handler — ` +
        `the boolean shorthand only enables or disables an operation that already exists`,
    );
  }

  const custom = entry as CustomOperationConfig<Entity>;
  if (typeof custom.handler?.execute !== "function") {
    throw new ConfigurationException(
      entityName,
      `operations.${id}.handler`,
      `custom operation '${id}' has no handler — a custom operation has no built-in behavior to ` +
        `fall back to, so it must supply one: { handler: { execute(input, context) { … } } }`,
    );
  }
  const kind = requireOneOf(entityName, id, "kind", custom.kind, ["read", "write"] as const) ?? "write";
  const cardinality =
    requireOneOf(entityName, id, "cardinality", custom.cardinality, ["one", "many"] as const) ?? "one";

  registry.register({
    id,
    kind,
    cardinality,
    enabled: custom.enabled ?? true,
    handler: custom.handler,
    ...resolveDtoOverride(entityName, id, CUSTOM_DTO_OVERRIDE_FIELDS[kind], custom),
    meta: custom.meta ?? {},
  });
}

/**
 * A declared `kind`/`cardinality` checked against its closed set, passing
 * `undefined` through so the caller can apply its own default.
 */
function requireOneOf<Value extends string>(
  entityName: string,
  id: string,
  key: string,
  value: Value | undefined,
  allowed: readonly Value[],
): Value | undefined {
  if (value === undefined || allowed.includes(value)) return value;
  throw new ConfigurationException(
    entityName,
    `operations.${id}.${key}`,
    `'${String(value)}' is not a valid ${key} — it must be one of ${allowed.map((one) => `'${one}'`).join(", ")}`,
  );
}

/**
 * A standard id is configured, never redefined: `kind` and `cardinality`
 * are fixed by `STANDARD_OPERATIONS` and mean nothing on an
 * `operations.<standard id>` entry. Declaring one there is a custom
 * operation aimed at a name that is already taken — a type error on a
 * literal config (`OperationConfig` has no such key), and this on a cast
 * one, rather than a silently ignored declaration.
 */
function rejectCustomOperationKeys(
  entityName: string,
  id: StandardOperationId,
  settings: Readonly<Record<string, unknown>> | undefined,
): void {
  if (settings === undefined) return;
  for (const key of ["kind", "cardinality"] as const) {
    if (settings[key] === undefined) continue;
    throw new ConfigurationException(
      entityName,
      `operations.${id}.${key}`,
      `'${id}' is a standard operation, whose ${key} is fixed — remove it, or give the custom ` +
        `operation you meant to declare an id of its own`,
    );
  }
}

/**
 * Whether an entity config *declares* soft delete — the config-only signal
 * `restoreOne` defaults from. Declaring means saying so on this entity:
 * `strategy: "soft"`, or naming the marker field explicitly. Merely
 * inheriting the built-in `strategy: "auto"` is not a declaration: `auto`
 * is answered by ORM metadata, which decoration time cannot see.
 */
function declaresSoftDelete(config: { readonly softDelete?: unknown } | undefined): boolean {
  const softDelete = config?.softDelete;
  if (typeof softDelete !== "object" || softDelete === null) return false;
  const { strategy, field } = softDelete as { strategy?: string; field?: string };
  return strategy === "soft" || typeof field === "string";
}
