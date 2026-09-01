import type {
  ClassRef,
  EntityId,
  EntityMetadata,
  IncludeTree,
  KavoContext,
  NormalizedQueryContext,
  RepositoryAdapter,
  ResolvedSoftDelete,
  Filter,
} from "@kavo/core";
import {
  AlreadyDeletedException,
  ConfigurationException,
  NotDeletedException,
  NotFoundException,
  PatchNoChangesException,
  hasKeyset,
  readFilter,
} from "@kavo/core";
import { wrap, type EntityManager, type MikroORM } from "@mikro-orm/core";
import { mapDriverError } from "./error-mapping.js";
import { translateFilter, type FilterTranslatorOptions, type MikroWhere } from "./filter-translator.js";
import { toPlain, toPlainAll } from "./plain-entity.js";

/**
 * The subset of MikroORM's `FindOptions` this adapter constructs.
 *
 * Declared rather than borrowed: MikroORM's own `FindOptions<T, …>` is
 * generic over the entity and its populate hints, which the adapter cannot
 * supply from core's untyped `IncludeTree`. But the *keys* are Kavo's own
 * construction, and typing them is what makes a typo a compile error — a
 * silent `populatewhere` would drop the soft-delete scoping from every
 * include and leave only one test to notice.
 */
interface MikroFindOptions {
  readonly orderBy?: readonly Record<string, unknown>[];
  readonly populate?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * `RepositoryAdapter` over a MikroORM `EntityManager`: CRUD with hard *or*
 * soft delete, restore, purge, filtering, sorting, pagination, optional
 * counting, and nested relation includes.
 *
 * Two things are specific to MikroORM and load-bearing:
 *
 * **Every method forks the EntityManager.** MikroORM is a Unit-of-Work ORM:
 * an `EntityManager` owns an identity map that caches every entity it has
 * loaded, and reusing one across requests would serve stale rows and leak
 * one caller's entities into another's. `orm.em` is the *root* manager and
 * is not meant to be queried directly; `orm.em.fork()` gives each operation
 * a clean, isolated one, which is the same scope a request-scoped
 * `RequestContext` would give a hand-written MikroORM application.
 *
 * **The `join`/`batch` split is deliberately ignored**, exactly as in
 * `@kavo/prisma` and unlike `@kavo/typeorm`. The TypeORM adapter translates
 * it because it drives a raw SQL query builder, where a to-many `JOIN`
 * multiplies root rows and separate batched queries are how that is avoided.
 * MikroORM resolves `populate` with its own queries and applies
 * `limit`/`offset` to the root regardless of the load strategy, so a to-many
 * include never disturbs pagination here. There is nothing left for that
 * distinction to control, and MikroORM's `strategy` option is per-query
 * rather than per-relation anyway — it could not express a mixed tree. The
 * one strategy this adapter honors is `key` (issue #364): the edge is left
 * un-populated and its bare FK is rewritten to `{ <pk>: value }` / `null` in
 * `pruneIncluded`.
 */
export class MikroOrmRepositoryAdapter<Entity extends object> implements RepositoryAdapter<Entity> {
  private readonly entity: ClassRef<Entity>;
  private readonly idField: string;
  private readonly filterOptions: FilterTranslatorOptions;
  /**
   * Relation property name → the target entity's primary-key property.
   * Resolved lazily: a bidirectional relation's target may not be registered
   * with MikroORM's metadata storage at the time this adapter is built.
   */
  private readonly relationIdFields: ReadonlyMap<string, () => string>;

  constructor(
    private readonly orm: MikroORM,
    metadata: EntityMetadata<Entity>,
    options: { caseInsensitiveFilters?: boolean } = {},
  ) {
    this.entity = metadata.entity;
    this.idField = metadata.idField;
    this.filterOptions = {
      idField: metadata.idField,
      caseInsensitiveFilters: options.caseInsensitiveFilters ?? false,
    };
    const relationIdFields = new Map<string, () => string>();
    for (const relation of metadata.relations) {
      relationIdFields.set(relation.name, () => {
        const target = this.orm.getMetadata().getByClassName(relation.target().name, false);
        return target?.primaryKeys[0] ?? "id";
      });
    }
    this.relationIdFields = relationIdFields;
  }

  /** A clean, isolated `EntityManager` for one operation — see the class doc. */
  private fork(): EntityManager {
    return this.orm.em.fork();
  }

  // ── Reads ────────────────────────────────────────────────────────────

  async findOneById(
    id: EntityId,
    query: NormalizedQueryContext<Entity> | null,
    context: KavoContext<Entity>,
  ): Promise<Entity | null> {
    try {
      const include = query?.include ?? {};
      const where = this.scopeToLive(
        { [this.idField]: id },
        context,
        query?.withDeleted ?? false,
        query?.onlyDeleted ?? false,
      );
      const row = await this.fork().findOne(this.entity, where as never, this.populateOptions(include) as never);
      return row === null ? null : pruneIncluded(toPlain(row), include);
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async findOne(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<Entity | null> {
    try {
      // `em.find(…, { limit: 1 })` rather than `em.findOne`: MikroORM's
      // validator rejects `em.findOne` with an empty `where` outright, and an
      // unfiltered query is a legitimate shape here — `findOne`'s contract is
      // "first match of the query, or null", and a query with no filter
      // matches everything. `em.find` accepts it, so routing through it keeps
      // the contract without an empty-where special case. The two are
      // otherwise identical: `findOne` is itself a limit-1 `find`.
      const rows = await this.fork().find(
        this.entity,
        this.buildWhere(query, context) as never,
        {
          ...this.buildFindOptions(query),
          limit: 1,
        } as never,
      );
      const row = rows[0];
      return row === undefined ? null : pruneIncluded(toPlain(row), query.include);
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async findMany(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<readonly Entity[]> {
    try {
      // `readFilter` folds in the keyset predicate under cursor pagination
      // (a no-op otherwise), and a cursor page has no `offset` to skip by —
      // the keyset predicate *is* the skip.
      const { pagination } = query;
      const rows = await this.fork().find(
        this.entity,
        this.buildWhere(query, context, readFilter(query)) as never,
        {
          ...this.buildFindOptions(query),
          offset: hasKeyset(pagination) ? 0 : pagination.offset,
          limit: pagination.limit,
        } as never,
      );
      return toPlainAll(rows).map((row) => pruneIncluded(row, query.include));
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async count(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<number> {
    try {
      // A dedicated count query — never fetch-then-length: the engine only
      // calls this when `query.count` is true, so `total: null` costs zero
      // queries. No populate: counting matching roots never needs their
      // relations.
      return await this.fork().count(this.entity, this.buildWhere(query, context) as never);
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  /** The translated filter, narrowed to the request's soft-delete scope. */
  private buildWhere(
    query: NormalizedQueryContext<Entity>,
    context: KavoContext<Entity>,
    filter: Filter<Entity> = query.filter,
  ): MikroWhere {
    return this.scopeToLive(translateFilter(filter, this.filterOptions), context, query.withDeleted, query.onlyDeleted);
  }

  private buildFindOptions(query: NormalizedQueryContext<Entity>): MikroFindOptions {
    const orderBy = query.sort.map((sort) => nestOrderBy(sort.field as string, sort.direction));
    return {
      ...(orderBy.length > 0 && { orderBy }),
      ...this.populateOptions(query.include),
    };
  }

  // ── Relation includes ───────────────────────────────────────────────

  /**
   * Translate a validated `IncludeTree` into MikroORM's `populate` paths.
   *
   * Soft-delete scoping of included rows is deliberately **not** done here —
   * see {@link pruneIncluded}. MikroORM's `populateWhere` cannot express it:
   * a nested condition (`{ articles: { deletedAt: null, notes: { deletedAt:
   * null } } }`) is read as a relation-path predicate on the *parent*, so an
   * article with no live notes is dropped from the parent's collection
   * altogether rather than coming back with an empty one. The dotted spelling
   * MikroORM rejects outright, and the parent-only spelling silently leaves
   * every deeper level unscoped.
   */
  private populateOptions(tree: IncludeTree): MikroFindOptions {
    const paths = populatePaths(tree);
    return paths.length === 0 ? {} : { populate: paths };
  }

  // ── Soft delete ──────────────────────────────────────────────────────

  /**
   * Three-way soft-delete scope: exclude deleted rows by default, include
   * both live and deleted with `withDeleted`, or restrict to only deleted
   * with `onlyDeleted` (mutually exclusive — validated upstream).
   *
   * There is one shape to handle rather than TypeORM's two: MikroORM
   * declares no delete-date column of its own, so the marker is always an
   * ordinary property and always needs its predicate spelled out.
   */
  private scopeToLive(
    where: MikroWhere | undefined,
    context: KavoContext<Entity>,
    withDeleted: boolean,
    onlyDeleted = false,
  ): MikroWhere {
    const softDelete = context.config.softDelete;
    if (softDelete.strategy !== "soft") {
      return where ?? {};
    }
    if (onlyDeleted) {
      return and(where, { [softDelete.field]: { $ne: null } });
    }
    if (withDeleted) {
      return where ?? {};
    }
    return and(where, { [softDelete.field]: { $eq: null } });
  }

  /** The resolved strategy, refused when an operation requires soft. */
  private requireSoftDelete(context: KavoContext<Entity>, operation: string): ResolvedSoftDelete & { field: string } {
    const softDelete = context.config.softDelete;
    if (softDelete.strategy !== "soft") {
      throw new ConfigurationException(
        context.entityName,
        "softDelete",
        `'${operation}' requires a soft-deletable entity, but '${context.entityName}' ` +
          `resolves to a hard delete strategy`,
      );
    }
    return softDelete;
  }

  private isDeleted(row: Record<string, unknown>, field: string): boolean {
    return row[field] !== null && row[field] !== undefined;
  }

  /** One row by id, as a plain object, under the given soft-delete scope. */
  private async byId(
    id: EntityId,
    context: KavoContext<Entity>,
    withDeleted: boolean,
  ): Promise<Record<string, unknown> | null> {
    const where = this.scopeToLive({ [this.idField]: id }, context, withDeleted);
    const row = await this.fork().findOne(this.entity, where as never);
    return row === null ? null : (toPlain(row) as Record<string, unknown>);
  }

  // ── Writes ───────────────────────────────────────────────────────────

  async create(data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const em = this.fork();
      const created = em.create(this.entity, this.toWriteData(data) as never);
      await em.flush();
      return toPlain(created as Entity);
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async update(id: EntityId, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    return this.mergeAndFlush(id, data, context);
  }

  async patch(id: EntityId, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    this.requirePatchChanges(id, data, context);
    return this.mergeAndFlush(id, data, context);
  }

  /**
   * `patch` (unlike `update`) rejects a body that carries no field changes
   * — checked against the same immutable-key strip `mergeAndFlush` applies,
   * so a body naming only the id and/or the soft-delete marker is treated
   * the same as a genuinely empty one. Raised before the row is even
   * loaded: this is a client-input problem, not a state one.
   *
   * Also drops any key whose value is `undefined` — a DTO instance can
   * carry these as *own* properties (e.g. a class-fields subclass under
   * `useDefineForClassFields`, issue #289) even though the client never
   * sent that key, and `undefined` never means "set this to nothing" in
   * JSON.
   */
  private requirePatchChanges(id: EntityId, rawData: Partial<Entity>, context: KavoContext<Entity>): void {
    const softDeleteField = context.config.softDelete.field;
    const data = { ...(rawData as Record<string, unknown>) };
    delete data[this.idField];
    if (softDeleteField !== null) {
      delete data[softDeleteField];
    }
    for (const key of Object.keys(data)) {
      if (data[key] === undefined) {
        delete data[key];
      }
    }
    if (Object.keys(data).length === 0) {
      throw new PatchNoChangesException({
        messageParams: { entity: context.entityName, id: String(id) },
        context: errorContext(context),
      });
    }
  }

  /**
   * update and patch share one load-merge-flush primitive: the *shape* of
   * `data` differs (full body vs. sparse) because the DTO layer differs, not
   * the persistence mechanics.
   *
   * This goes through the Unit of Work rather than `nativeUpdate` — one
   * managed entity, assigned and flushed — so lifecycle hooks,
   * `onUpdate` properties, and relation diffing all behave as they would in
   * a hand-written MikroORM application. The row is loaded first anyway, to
   * turn a missing id into `NotFoundException`, so this costs no extra
   * query.
   */
  private async mergeAndFlush(id: EntityId, rawData: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const em = this.fork();
      // Scoped to live rows: a soft-deleted row is invisible to updates,
      // exactly as it is to reads. Reviving one is `restore`'s job.
      const where = this.scopeToLive({ [this.idField]: id }, context, false);
      const existing = await em.findOne(this.entity, where as never);
      if (existing === null) {
        throw this.notFound(id, context);
      }
      // Defence in depth, mirroring the deserializer's own exclusion: even
      // an explicit write DTO that legitimately names the id (to assign a
      // natural key on `create`) must not be allowed to reassign an
      // *existing* row's identity, and the soft-delete marker is
      // `deleteOne`/`restoreOne`'s state machine to change, not an
      // ordinary property an update/patch body happens to include.
      const softDeleteField = context.config.softDelete.field;
      const data = { ...(rawData as Record<string, unknown>) };
      delete data[this.idField];
      if (softDeleteField !== null) {
        delete data[softDeleteField];
      }
      wrap(existing).assign(this.toWriteData(data as Partial<Entity>) as never, { em });
      await em.flush();
      return toPlain(existing);
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async delete(id: EntityId, context: KavoContext<Entity>): Promise<void> {
    const softDelete = context.config.softDelete;
    try {
      if (softDelete.strategy === "hard") {
        const affected = await this.fork().nativeDelete(this.entity, { [this.idField]: id } as never);
        if (affected === 0) {
          throw this.notFound(id, context);
        }
        return;
      }
      const { field } = softDelete;
      const existing = await this.byId(id, context, true);
      if (existing === null) {
        throw this.notFound(id, context);
      }
      if (this.isDeleted(existing, field)) {
        throw new AlreadyDeletedException({
          messageParams: { entity: context.entityName, id: String(id) },
          context: errorContext(context),
        });
      }
      await this.fork().nativeUpdate(this.entity, { [this.idField]: id } as never, { [field]: new Date() } as never);
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async restore(id: EntityId, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const { field } = this.requireSoftDelete(context, "restore");
      const existing = await this.byId(id, context, true);
      if (existing === null) {
        throw this.notFound(id, context);
      }
      if (!this.isDeleted(existing, field)) {
        throw new NotDeletedException({
          messageParams: { entity: context.entityName, id: String(id) },
          context: errorContext(context),
        });
      }
      await this.fork().nativeUpdate(this.entity, { [this.idField]: id } as never, { [field]: null } as never);
      // Clearing the marker is a single-field write with no relation
      // involvement, so the already-loaded row is corrected in place rather
      // than re-read.
      existing[field] = null;
      return existing as Entity;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async purge(id: EntityId, context: KavoContext<Entity>): Promise<void> {
    const softDelete = context.config.softDelete;
    try {
      if (softDelete.strategy === "soft") {
        // Purge is the second step of a two-step delete: it removes a row
        // that is already soft-deleted, never a live one.
        const existing = await this.byId(id, context, true);
        if (existing === null) {
          throw this.notFound(id, context);
        }
        if (!this.isDeleted(existing, softDelete.field)) {
          throw new NotDeletedException({
            messageParams: { entity: context.entityName, id: String(id) },
            context: errorContext(context),
          });
        }
      }
      const affected = await this.fork().nativeDelete(this.entity, { [this.idField]: id } as never);
      if (affected === 0) {
        throw this.notFound(id, context);
      }
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  /**
   * Normalize the engine's write payload for MikroORM.
   *
   * Core's default deserializer narrows a relation value to `{ id }` (or an
   * array of them) — association by id, ADR-0014. MikroORM associates by
   * *primary key value*, and would read a nested `{ id }` object as a
   * request to create a new entity, so each relation value is unwrapped to
   * the bare key before it reaches `create`/`assign`.
   */
  private toWriteData(data: Partial<Entity>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...data };
    for (const [name, idFieldOf] of this.relationIdFields) {
      if (!(name in result)) {
        continue;
      }
      result[name] = unwrapAssociation(result[name], idFieldOf());
    }
    return result;
  }

  private notFound(id: EntityId, context: KavoContext<Entity>): NotFoundException {
    return new NotFoundException({
      messageParams: { entity: context.entityName, id: String(id) },
      context: errorContext(context),
    });
  }
}

/**
 * `{ id: 5 }` → `5`; arrays element-wise; scalars and `null` unchanged.
 *
 * An object carrying no id becomes `null` rather than being passed through.
 * That mirrors core's own `associate()` exactly, and it matters because core
 * only narrows a relation when the *target* entity is in its catalog — a
 * relation whose target was never `createCrud`-ed arrives here as whatever
 * the client sent. Handing that object to `em.create` would put a nested
 * write one cascade setting away from working, which is precisely what
 * ADR-0014 rules out: relations are associated by id, never deep-written.
 */
/**
 * Apply the two include-tree rules core expects of a loaded row: every
 * included relation is **present**, and no soft-deleted related row is in it.
 *
 * Both are done here, in memory, rather than in the query — see
 * `populateOptions` for why `populateWhere` cannot do the second one without
 * silently dropping parents. The cost is that soft-deleted related rows are
 * fetched and then discarded; the alternative spellings are wrong rather than
 * merely slower, so this is the honest trade. Soft-deleted *roots* are still
 * excluded in SQL (`scopeToLive`), which is where the volume is.
 *
 * "Present" matters because core's serializer treats an absent key as "the
 * adapter never hydrated this" and skips it — so an included to-many that
 * matches nothing must be `[]`, not missing. A root `withDeleted` never
 * widens an included relation: this prunes regardless of the root's scope.
 */
function pruneIncluded<Row>(row: Row, tree: IncludeTree): Row {
  const source = row as Record<string, unknown>;
  for (const node of Object.values(tree)) {
    const name = node.relation.name;
    const value = source[name];
    if (node.strategy === "key") {
      // An un-populated to-one comes back as its bare FK (`author: 1`) or,
      // from an uninitialized reference, an object carrying only the id.
      // Rewrite it to `{ <pk>: value }`, or `null` when absent (issue #364).
      const fk = unwrapAssociation(value, node.idField as string);
      source[name] = fk === null || fk === undefined ? null : { [node.idField as string]: fk };
      continue;
    }
    const deleted = (candidate: unknown): boolean => {
      if (node.softDelete.strategy !== "soft") {
        return false;
      }
      const marker = (candidate as Record<string, unknown>)[node.softDelete.field];
      return marker !== null && marker !== undefined;
    };

    if (Array.isArray(value)) {
      const live = value.filter((child) => !deleted(child));
      for (const child of live) {
        pruneIncluded(child, node.children);
      }
      source[name] = live;
      continue;
    }
    // A to-one that was populated is an object; anything else (a bare foreign
    // key from an uninitialized reference, `undefined`, `null`) becomes null.
    if (value !== null && typeof value === "object" && !deleted(value)) {
      pruneIncluded(value, node.children);
      continue;
    }
    source[name] = node.relation.cardinality === "many" ? [] : null;
  }
  return row;
}

function unwrapAssociation(value: unknown, idField: string): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    // Nulls are filtered, not mapped through, exactly as core's `associate`
    // does: a to-many element carrying no id contributes nothing, and passing
    // `[null]` to `em.create`/`assign` would fail at the driver as a 500
    // instead of being ignored.
    return value.map((element) => unwrapAssociation(element, idField)).filter((element) => element !== null);
  }
  if (typeof value === "object") {
    return (value as Record<string, unknown>)[idField] ?? null;
  }
  return value;
}

/** Combine two predicates, keeping `undefined` from degenerating into `{}`. */
function and(where: MikroWhere | undefined, extra: MikroWhere): MikroWhere {
  return where === undefined ? extra : { $and: [where, extra] };
}

/** The include tree flattened to the dotted paths MikroORM's `populate` takes. */
function populatePaths(tree: IncludeTree, prefix = ""): string[] {
  const paths: string[] = [];
  for (const node of Object.values(tree)) {
    // `strategy: "key"` (issue #364): never populated — its raw FK id is
    // read straight off the parent and rewritten by `pruneIncluded`.
    if (node.strategy === "key") {
      continue;
    }
    const path = prefix === "" ? node.relation.name : `${prefix}.${node.relation.name}`;
    paths.push(path);
    paths.push(...populatePaths(node.children, path));
  }
  return paths;
}

/** `"author.name"` + `"asc"` → `{ author: { name: "asc" } }`. */
function nestOrderBy(field: string, direction: "asc" | "desc"): Record<string, unknown> {
  const segments = field.split(".");
  return segments.slice(0, -1).reduceRight<Record<string, unknown>>((inner, segment) => ({ [segment]: inner }), {
    [segments[segments.length - 1]!]: direction,
  });
}

function errorContext<Entity>(context: KavoContext<Entity>) {
  return {
    entityName: context.entityName,
    operation: context.operation,
    correlationId: context.correlationId,
  };
}
