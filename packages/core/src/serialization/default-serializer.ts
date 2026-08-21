import type { KavoContext } from "../context/kavo-context.js";
import type { ComputedFieldMap } from "../config/computed-field.js";
import type { DtoClass } from "../dto/dto.js";
import type { Deserializer, Serializer } from "./serializer.js";
import type { EntityCatalog } from "../metadata/entity-catalog.js";
import type { EntityMetadata } from "../metadata/entity-metadata.js";
import type { IncludeNode, IncludeTree } from "../relations/include-tree.js";
import { dtoShapeKeys } from "../dto/dto-shape.js";

/**
 * Computed fields as the projector consumes them: entity type erased,
 * because one serializer projects rows of several entity types — the
 * root's, and every included relation target's, which it reads off the
 * catalog. The entity-typed contract is `ComputedFieldDescriptor<Entity>`,
 * which is what the *caller* declares and what every `ComputedFieldMap`
 * flowing in here satisfies.
 */
type ErasedComputedFields = Readonly<Record<string, { resolve(entity: never, context: never): unknown }>>;

const NO_COMPUTED_FIELDS: ErasedComputedFields = Object.freeze({});
const NO_RELATIONS: ReadonlySet<string> = new Set<string>();

/** The projection rules for one entity type, resolved from the catalog. */
interface Projection {
  /** Allowed keys, or `null` when the shape is unknown (own keys apply). */
  readonly keys: readonly string[] | null;
  /**
   * Relation property names — never emitted unless the node is included.
   * A `Set` rather than an array: `project` tests every key against it, so
   * an array would make the per-row cost quadratic in the entity's width.
   */
  readonly relations: ReadonlySet<string>;
  /** Computed fields, evaluated instead of read off the row (ADR-0019). */
  readonly computed: ErasedComputedFields;
}

/**
 * A sparse fieldset as `project` consumes it. Built once per response (or
 * once per relation node), never once per row — the same reason
 * `Projection.relations` is a `Set`.
 */
function selectionSet(selection: readonly string[] | null | undefined): ReadonlySet<string> | null {
  return selection == null ? null : new Set(selection);
}

/**
 * Default response mapping. Serialization order is normative:
 * **DTO mapping first, then field selection** — selection can only narrow
 * what the resolved DTO exposes.
 *
 * Projection sources, in order:
 * 1. An explicit DTO class with initialized fields → its key set.
 * 2. Otherwise the entity-derived default: every scalar column from
 *    adapter metadata, plus every declared computed field (ADR-0019),
 *    **intersected with an explicitly configured `allowlists.selectable`**
 *    (ADR-0026). A DTO wins outright: it is the narrower, more specific
 *    statement, and intersecting the two would make a DTO that deliberately
 *    exposes a field silently not do so.
 *
 * A key that names a computed field is produced by calling the
 * descriptor's `resolve`, never by reading it off the row — which is what
 * makes computed fields behave identically over a TypeORM class instance
 * and a Prisma/Mongoose plain object.
 *
 * Relation properties are emitted **only** for nodes on the request's
 * include tree, each projected through its own target entity's
 * DTO — a relation never widens what its target exposes. That is also why
 * a relation key on a registered DTO stays absent until it is included:
 * the DTO documents the shape, the include decides the load.
 */
export class DefaultSerializer<Entity = unknown> implements Serializer<Entity> {
  private readonly rootProjection: Projection;

  constructor(
    metadata: EntityMetadata<Entity>,
    private readonly catalog?: EntityCatalog,
    computed: ComputedFieldMap<Entity> = {},
    projection: readonly string[] | null = null,
  ) {
    this.rootProjection = {
      keys: narrowToProjection([...metadata.fields.map((field) => field.name), ...Object.keys(computed)], projection),
      relations: new Set(metadata.relations.map((relation) => relation.name)),
      computed,
    };
  }

  serializeItem<ItemDto>(
    entity: Entity,
    dto: DtoClass<ItemDto & object> | null,
    context: KavoContext<Entity>,
  ): ItemDto {
    return this.project(
      entity,
      narrowToDto(this.rootProjection, dto),
      selectionSet(context.query?.fields.root as readonly string[] | null | undefined),
      context.query?.include ?? {},
      context,
    ) as ItemDto;
  }

  /**
   * The DTO narrowing and the fieldset `Set` are the same for every row of
   * one response, so they are resolved once here rather than once per item
   * — this is `serializeItem`'s body with the per-row constants hoisted,
   * not a second projection path.
   */
  serializeList<ListDto>(
    entities: readonly Entity[],
    dto: DtoClass<ListDto & object> | null,
    context: KavoContext<Entity>,
  ): readonly ListDto[] {
    const projection = narrowToDto(this.rootProjection, dto as DtoClass | null);
    const selection = selectionSet(context.query?.fields.root as readonly string[] | null | undefined);
    const include = context.query?.include ?? {};
    return entities.map((entity) => this.project(entity, projection, selection, include, context) as ListDto);
  }

  /**
   * One entity → one plain object: allowed keys narrowed by the sparse
   * fieldset, then the included relations grafted on. Keys the adapter
   * fetched for stitching but nobody selected are dropped right here —
   * "kept internally, stripped late".
   */
  private project(
    entity: unknown,
    projection: Projection,
    selection: ReadonlySet<string> | null,
    include: IncludeTree,
    context: KavoContext<Entity>,
  ): Record<string, unknown> {
    const source = entity as Record<string, unknown>;
    const keys = projection.keys ?? Object.keys(source);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (projection.relations.has(key)) continue;
      // Before the computed branch: a deselected computed field's `resolve`
      // must never run, or `fields=` would pay for work it discards.
      if (selection !== null && !selection.has(key)) continue;
      // Own properties only: `keys` can come from a DTO class or from the
      // row itself, and an inherited `constructor`/`toString` must not be
      // mistaken for a declared computed field.
      if (Object.prototype.hasOwnProperty.call(projection.computed, key)) {
        const value = projection.computed[key]?.resolve(entity as never, context as never);
        // `undefined` is absence, `null` is data — the same distinction the
        // column branch draws below, so a resolver that opts out of
        // emitting a value reads the same programmatically as it does once
        // `JSON.stringify` has dropped the key.
        if (value !== undefined) result[key] = value;
        continue;
      }
      // Reached only when the key names no computed field: the branch order
      // above is normative, because a row *can* carry a computed key —
      // a TypeORM entity with a `get fullName()`, or an adapter row with a
      // column the metadata seam does not describe. Resolving wins; reading
      // the row here would resurrect the exact accident ADR-0019 replaced.
      if (key in source) result[key] = source[key];
    }
    for (const [name, node] of Object.entries(include)) {
      // Absent means "not loaded" — a programmatic caller can hand the
      // engine an entity the adapter never hydrated.
      if (!(name in source)) continue;
      result[name] = this.projectRelated(source[name], node, context);
    }
    return result;
  }

  private projectRelated(value: unknown, node: IncludeNode, context: KavoContext<Entity>): unknown {
    if (value === null || value === undefined) {
      return node.relation.cardinality === "many" ? [] : null;
    }
    const target = this.projectionFor(node);
    // Resolved once per node, not once per element of a to-many.
    const selection = selectionSet(node.fields);
    const one = (row: unknown): Record<string, unknown> => this.project(row, target, selection, node.children, context);
    return Array.isArray(value) ? value.map(one) : one(value);
  }

  /**
   * The target entity's own projection: its registered `item` DTO (or
   * `list` for a to-many, which itself falls back to `item`), else the
   * target's columns plus its own computed fields — which is how a
   * computed field on an included relation resolves without this class
   * ever knowing more than one entity (ADR-0019).
   */
  private projectionFor(node: IncludeNode): Projection {
    const info = this.catalog?.get(node.relation.target());
    if (info === undefined) return { keys: null, relations: NO_RELATIONS, computed: NO_COMPUTED_FIELDS };
    const dto = info.config.dto.resolve(node.relation.cardinality === "many" ? "list" : "item", "findMany");
    const computed: ErasedComputedFields = info.config.computed;
    // The target's own `selectable`, not the root's: an include never
    // widens what its target exposes, and that has to hold for the
    // projection allowlist as well as for the DTO (ADR-0026). Without it,
    // hiding a credential on `User` would leak it again the moment some
    // other entity included `user`.
    return {
      keys:
        dtoShapeKeys(dto) ??
        narrowToProjection(
          [...info.metadata.fields.map((field) => field.name), ...Object.keys(computed)],
          info.config.projection as readonly string[] | null,
        ),
      relations: new Set(info.metadata.relations.map((relation) => relation.name)),
      computed,
    };
  }
}

/**
 * The entity-derived key set, narrowed to an explicitly configured
 * `allowlists.selectable` (ADR-0026). `null` leaves it alone, which is what
 * an entity that never configured the key gets.
 *
 * Filtering the derived list rather than using the allowlist directly keeps
 * the derived order and, more importantly, keeps the projection a subset of
 * what the entity actually has: an explicit `selectable` may legitimately
 * name a relation path, which is not a key this projection ever emits.
 */
function narrowToProjection(derived: readonly string[], projection: readonly string[] | null): readonly string[] {
  if (projection === null) return derived;
  const allowed = new Set(projection);
  return derived.filter((key) => allowed.has(key));
}

/**
 * DTO mapping, step one of the normative order: a registered class with a
 * runtime shape replaces the projection's key set and nothing else — the
 * relation and computed tables still describe the same entity, so a DTO
 * that names a computed field still gets it evaluated, and one that omits
 * it narrows it away like any other field.
 */
function narrowToDto(projection: Projection, dto: DtoClass | null): Projection {
  const keys = dtoShapeKeys(dto);
  return keys === null ? projection : { ...projection, keys };
}

/**
 * Default request-body mapping. Picks the keys the operation's
 * input shape allows and silently drops everything else — with no
 * validation subsystem in v6, stripping unknown and non-writable keys
 * (generated columns) is the safe default: a client cannot write `id` or
 * `createdAt` by including them in a body.
 *
 * Relation properties are writable **by association only** (ADR-0014):
 * a scalar id, an `{ id }` reference, or an array of either.
 * A nested object carrying more than the id is narrowed to the id, because
 * a deep nested write is not something this layer should do by accident.
 *
 * Computed fields are **never** writable (ADR-0019), and this class is the
 * inner of the two layers that make that true. A registered
 * `create`/`update`/`patch` DTO naming a computed field is rejected at
 * bootstrap (`resolveComputedFields`' neighbour in `resolve-entity-config`),
 * so through `createCrud` the derived writable projection is the only one
 * that reaches here and it never carries a computed name. The explicit
 * strip below is what keeps that true for a `DefaultDeserializer`
 * constructed directly — it is exported, and its contract is "computed
 * names never reach the adapter", not "the config resolver checked first".
 *
 * The primary key is excluded from the derived default **regardless of
 * `generated`**: an app-assigned id (a natural key, a
 * `@BeforeInsert`-populated UUID) is not driver-generated but must not be
 * reassignable by an ordinary write. It has no per-call scope — an entity's
 * identifier is fixed metadata — so it is excluded once, at construction.
 *
 * The soft-delete marker gets the same exclusion, but resolved **per call**
 * from `context.config.softDelete.field` rather than baked in at
 * construction: `softDelete` is an ordinary settings key (entity → operation
 * → per-call, ADR-0013), so the field an operation actually writes through
 * can differ from the entity's own default — an `update`/`patch` this class
 * cannot see through `context` is exactly what the per-adapter strip in each
 * `RepositoryAdapter.update`/`patch` already covers as defence in depth, but
 * `create` has no such backstop (an explicit DTO may legitimately assign a
 * natural key there), so the marker exclusion has to track the same scope
 * `context.config` resolves it at, not the scope this class was built in.
 * A marker that isn't the ORM's own delete-date column is an ordinary
 * writable column with no special exclusion otherwise — either gap would
 * let a client rewrite a row's identity or its deleted state through the
 * generic write route instead of `create`'s intentional choice of id or
 * `deleteOne`/`restoreOne`'s state machine. Unlike computed fields, both are
 * a deliberately narrower guarantee: an explicit write DTO naming the id or
 * marker field still reaches it, because both are real columns with
 * legitimate opt-in uses (assigning a natural key on `create`) that a
 * computed field never has.
 */
export class DefaultDeserializer<Entity = unknown> implements Deserializer<Entity> {
  private readonly writableProjection: readonly string[];
  private readonly relationIdFields: ReadonlyMap<string, () => string | undefined>;
  private readonly computedNames: ReadonlySet<string>;

  constructor(metadata: EntityMetadata<Entity>, catalog?: EntityCatalog, computed: ComputedFieldMap<Entity> = {}) {
    this.computedNames = new Set(Object.keys(computed));
    const columns = metadata.fields
      .filter((field) => !field.generated && field.name !== metadata.idField)
      .map((field) => field.name);
    const relations = new Map<string, () => string | undefined>();
    for (const relation of metadata.relations) {
      // Lazily: the target may enter the catalog after this entity does.
      relations.set(relation.name, () => catalog?.get(relation.target())?.metadata.idField);
    }
    this.relationIdFields = relations;
    // Relations join the derived default — associating by id is ordinary
    // CRUD, not an opt-in extra.
    this.writableProjection = [...columns, ...relations.keys()];
  }

  deserialize<Shape>(raw: unknown, dto: DtoClass<Shape & object> | null, context: KavoContext<Entity>): Shape {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {} as Shape;
    }
    const explicit = dtoShapeKeys(dto);
    // Only the derived default is narrowed by `creatable`/`updatable` — an
    // explicit DTO's own key set is deliberately left alone, exactly as it
    // already is for the id and the soft-delete marker below: a registered
    // DTO *replaces* the projection rather than intersecting with it
    // (ADR-0026's `selectable`-vs-`dto.item` precedent).
    const allowed = explicit ?? this.narrowToWritableAllowlist(context);
    // Only the derived default excludes the marker — an explicit DTO's own
    // key set is deliberately left alone, same as the id (see class doc).
    // Optional chaining: this class is exported and constructible directly
    // against a context that never went through the engine (a test stub,
    // say), and the exclusion degrading to "none" there is the same
    // graceful fallback the id/computed-field guards already make.
    const softDeleteField = explicit === null ? (context.config?.softDelete?.field ?? null) : null;
    const source = raw as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of allowed) {
      // A computed field has no column behind it, so a value for it could
      // only ever reach the adapter as an unknown write (ADR-0019).
      if (this.computedNames.has(key)) continue;
      if (key === softDeleteField) continue;
      // Own properties only. `raw` is a wire body, so an inherited key is
      // never something the client sent — but it *is* something a polluted
      // `Object.prototype` would supply, silently adding a writable field to
      // every request that omits it. Defence in depth: the filter parser no
      // longer offers a way to pollute (see `emptyNode` there), and this
      // keeps a pollution introduced anywhere else out of writes.
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const idField = this.relationIdFields.get(key)?.();
      result[key] = idField === undefined ? source[key] : associate(source[key], idField);
    }
    return result as Shape;
  }

  /**
   * Narrows {@link writableProjection} by `allowlists.creatable`/
   * `updatable` (issue #259) for the operation the call is actually
   * making — `createOne` reads `creatable`, `updateOne`/`patchOne` read
   * `updatable`, and every other operation (a custom write) is left
   * unnarrowed, since neither key names it. Both lists already default to
   * the same base this class derives on its own, so an entity that never
   * configured either sees no change: the filter is a no-op intersection.
   *
   * Optional chaining on `context.config`, same reason as the soft-delete
   * lookup above: this class is constructible directly against a context
   * that never went through the engine.
   */
  private narrowToWritableAllowlist(context: KavoContext<Entity>): readonly string[] {
    const allowlists = context.config?.allowlists;
    if (allowlists === undefined) return this.writableProjection;
    let allowlist: readonly string[] | undefined;
    if (context.operation === "createOne") {
      allowlist = allowlists.creatable as readonly string[];
    } else if (context.operation === "updateOne" || context.operation === "patchOne") {
      allowlist = allowlists.updatable as readonly string[];
    }
    if (allowlist === undefined) return this.writableProjection;
    const allowed = new Set(allowlist);
    return this.writableProjection.filter((key) => allowed.has(key));
  }
}

/** `5` → `{ id: 5 }`; `{ id: 5, … }` → `{ id: 5 }`; arrays element-wise. */
function associate(value: unknown, idField: string): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((element) => associate(element, idField)).filter((element) => element !== null);
  }
  if (typeof value === "object") {
    const id = (value as Record<string, unknown>)[idField];
    return id === undefined ? null : { [idField]: id };
  }
  return { [idField]: value };
}
