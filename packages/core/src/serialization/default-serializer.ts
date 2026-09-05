import type { KavoContext } from "../context/kavo-context.js";
import type { ComputedFieldMap } from "../config/computed-field.js";
import type { DtoClass } from "../dto/dto.js";
import type { Deserializer, Serializer } from "./serializer.js";
import type { EntityCatalog } from "../metadata/entity-catalog.js";
import type { EntityMetadata } from "../metadata/entity-metadata.js";
import type { IncludeNode, IncludeTree } from "../relations/include-tree.js";
import { dtoShapeKeys } from "../dto/dto-shape.js";
import { decodeCompositeId } from "../metadata/composite-id.js";
import { AssociationInvalidShapeException } from "../errors/exceptions.js";

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
   * The default response projection: what serves when the request sends
   * no `select=` of its own (`select.default`, issue #386). `null` means
   * "no configured default" — `keys` (or every own key) applies instead.
   */
  readonly defaultKeys?: readonly string[] | null;
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
 *    **intersected with an explicitly configured `select.fields`**
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
    selectDefault: readonly string[] | null = null,
  ) {
    this.rootProjection = {
      keys: narrowToProjection([...metadata.fields.map((field) => field.name), ...Object.keys(computed)], projection),
      defaultKeys: selectDefault,
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
      selectionSet(context.query?.select.root as readonly string[] | null | undefined),
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
    const selection = selectionSet(context.query?.select.root as readonly string[] | null | undefined);
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
    const keys = (selection === null ? projection.defaultKeys : null) ?? projection.keys ?? Object.keys(source);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (projection.relations.has(key)) {
        continue;
      }
      // Before the computed branch: a deselected computed field's `resolve`
      // must never run, or `select=` would pay for work it discards.
      if (selection !== null && !selection.has(key)) {
        continue;
      }
      // Own properties only: `keys` can come from a DTO class or from the
      // row itself, and an inherited `constructor`/`toString` must not be
      // mistaken for a declared computed field.
      if (Object.prototype.hasOwnProperty.call(projection.computed, key)) {
        const value = projection.computed[key]?.resolve(entity as never, context as never);
        // `undefined` is absence, `null` is data — the same distinction the
        // column branch draws below, so a resolver that opts out of
        // emitting a value reads the same programmatically as it does once
        // `JSON.stringify` has dropped the key.
        if (value !== undefined) {
          result[key] = value;
        }
        continue;
      }
      // Reached only when the key names no computed field: the branch order
      // above is normative, because a row *can* carry a computed key —
      // a TypeORM entity with a `get fullName()`, or an adapter row with a
      // column the metadata seam does not describe. Resolving wins; reading
      // the row here would resurrect the exact accident ADR-0019 replaced.
      if (key in source) {
        result[key] = source[key];
      }
    }
    for (const [name, node] of Object.entries(include)) {
      // Absent means "not loaded" — a programmatic caller can hand the
      // engine an entity the adapter never hydrated.
      if (!(name in source)) {
        continue;
      }
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
    if (info === undefined) {
      return { keys: null, relations: NO_RELATIONS, computed: NO_COMPUTED_FIELDS };
    }
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
 * `select.fields` (ADR-0026). `null` leaves it alone, which is what
 * an entity that never configured the key gets.
 *
 * Filtering the derived list rather than using the allowlist directly keeps
 * the derived order and keeps the projection a subset of what the entity
 * actually has, even if an explicit `selectable` names a column the derived
 * key set does not carry.
 */
function narrowToProjection(derived: readonly string[], projection: readonly string[] | null): readonly string[] {
  if (projection === null) {
    return derived;
  }
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
 * Relation properties are writable **by association only** (ADR-0014): a
 * single-key relation takes an `{ id }` reference (or an array of them for
 * a to-many) — a bare scalar id is rejected (`AssociationInvalidShapeException`),
 * not accepted as shorthand. A nested object carrying more than the id is
 * narrowed to the id, because a deep nested write is not something this
 * layer should do by accident.
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
/**
 * What `associate()` needs to know about a relation's target, resolved
 * lazily off the catalog: its single `idField`, or — for a composite-key
 * target (issue #263) — the full ordered `compositeIdFields` tuple.
 */
type RelationIdSpec = { readonly idField: string } | { readonly compositeIdFields: readonly string[] };

export class DefaultDeserializer<Entity = unknown> implements Deserializer<Entity> {
  private readonly writableProjection: readonly string[];
  private readonly relationIdFields: ReadonlyMap<string, () => RelationIdSpec | undefined>;
  private readonly computedNames: ReadonlySet<string>;

  constructor(metadata: EntityMetadata<Entity>, catalog?: EntityCatalog, computed: ComputedFieldMap<Entity> = {}) {
    this.computedNames = new Set(Object.keys(computed));
    // A composite-key entity (issue #261) has no single `idField` to
    // exclude — its key columns are a natural key the client legitimately
    // supplies on `createOne`, so the derived default keeps them (narrowed
    // back out of `update.fields`'s default in `resolveAllowed`, which is
    // what actually keeps them immutable after creation).
    const columns = metadata.fields
      .filter(
        (field) => !field.generated && (metadata.compositeIdFields !== undefined || field.name !== metadata.idField),
      )
      .map((field) => field.name);
    const relations = new Map<string, () => RelationIdSpec | undefined>();
    for (const relation of metadata.relations) {
      // Lazily: the target may enter the catalog after this entity does.
      relations.set(relation.name, () => {
        const target = catalog?.get(relation.target())?.metadata;
        if (target === undefined) {
          return undefined;
        }
        return target.compositeIdFields !== undefined
          ? { compositeIdFields: target.compositeIdFields }
          : { idField: target.idField };
      });
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
    // A registered `create`/`update`/`patch` DTO — including one synthesized
    // from the `{ fields }` shorthand (issue #386, `dto-fields-shorthand.ts`)
    // — *replaces* the derived writable projection rather than narrowing it
    // (ADR-0026's `select.fields`-vs-`dto.item` precedent): `creatable`/
    // `updatable` are reached through `dto.create`/`dto.update`'s shorthand
    // now, not a separate allowlist key.
    const allowed = explicit ?? this.writableProjection;
    // Only the derived default excludes the marker — an explicit DTO's own
    // key set is deliberately left alone, same as the id (see class doc).
    // Optional chaining: this class is exported and constructible directly
    // against a context that never went through the engine (a test stub,
    // say), and the exclusion degrading to "none" there is the same
    // graceful fallback the id/computed-field guards already make.
    const softDeleteField = explicit === null ? (context.config?.softDelete?.field ?? null) : null;
    // `create.default`/`update.default` (`createOne` and `updateOne` only —
    // never `patchOne`, whose omission means "leave unchanged" rather than
    // "reset"). Optional chaining for the same reason `softDeleteField`
    // above uses it: this class is constructible directly against a
    // context that never went through the engine.
    const writeDefault =
      context.operation === "createOne"
        ? context.config?.createDefault
        : context.operation === "updateOne"
          ? context.config?.updateDefault
          : undefined;
    const source = raw as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of allowed) {
      // A computed field has no column behind it, so a value for it could
      // only ever reach the adapter as an unknown write (ADR-0019).
      if (this.computedNames.has(key)) {
        continue;
      }
      if (key === softDeleteField) {
        continue;
      }
      // Own properties only. `raw` is a wire body, so an inherited key is
      // never something the client sent — but it *is* something a polluted
      // `Object.prototype` would supply, silently adding a writable field to
      // every request that omits it. Defence in depth: the filter parser no
      // longer offers a way to pollute (see `emptyNode` there), and this
      // keeps a pollution introduced anywhere else out of writes.
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        if (writeDefault !== undefined && Object.prototype.hasOwnProperty.call(writeDefault, key)) {
          result[key] = (writeDefault as Record<string, unknown>)[key];
        }
        continue;
      }
      const spec = this.relationIdFields.get(key)?.();
      result[key] = spec === undefined ? source[key] : associate(source[key], spec, key, context);
    }
    return result as Shape;
  }
}

/**
 * `{ id: 5, … }` → `{ id: 5 }`; arrays element-wise; `null`/`undefined` →
 * `null`.
 *
 * A single-key target accepts only a reference object naming its `idField`
 * (`{owner: {id: 5}}`) — narrowed to just that key before it ever reaches
 * the adapter, so a nested write like `{owner: {id: 5, name: "Rae"}}` still
 * associates rather than cascading. A bare scalar (`{owner: 5}`) is
 * **rejected**, not accepted as shorthand: ADR-0014 originally treated the
 * two as equivalent, but a bare scalar left a caller's intent ambiguous —
 * is `5` the related row's id, or a mistyped value for some other field
 * named `owner`? — and, resolved wrong, surfaced as an opaque FK-constraint
 * failure from the database rather than a 400 naming the actual problem
 * (issue #291). {@link AssociationInvalidShapeException} names it instead.
 *
 * A composite-key target (issue #263) has no single `idField` to key a
 * reference object by, so it accepts two shapes instead: an object naming
 * each of the target's `compositeIdFields` directly (`{owner: {userId:
 * "u1", topic: "billing"}}`), or a bare scalar carrying the same
 * `~`-delimited wire id a route already uses (`{owner: "u1~billing"}`,
 * `encodeCompositeId`/`decodeCompositeId`) — composite keys have no single
 * column a bare scalar could be mistaken for, so the ambiguity above does
 * not apply there and that shorthand is unchanged.
 */
function associate<Entity>(
  value: unknown,
  spec: RelationIdSpec,
  relation: string,
  context: KavoContext<Entity>,
): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((element) => associate(element, spec, relation, context)).filter((element) => element !== null);
  }
  if ("idField" in spec) {
    const { idField } = spec;
    if (typeof value === "object") {
      const id = (value as Record<string, unknown>)[idField];
      return id === undefined ? null : { [idField]: id };
    }
    throw new AssociationInvalidShapeException({
      messageParams: { relation, idField, entity: context.entityName },
      context: { entityName: context.entityName, operation: context.operation, correlationId: context.correlationId },
    });
  }
  const { compositeIdFields } = spec;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const field of compositeIdFields) {
      const fieldValue = record[field];
      if (fieldValue === undefined) {
        return null;
      }
      result[field] = fieldValue;
    }
    return result;
  }
  if (typeof value === "string") {
    const parts = decodeCompositeId(value, compositeIdFields.length);
    if (parts === null) {
      return null;
    }
    return Object.fromEntries(compositeIdFields.map((field, index) => [field, parts[index]]));
  }
  return null;
}
