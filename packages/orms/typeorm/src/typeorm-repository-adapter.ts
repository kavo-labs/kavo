import type {
  ClassRef,
  Filter,
  KavoContext,
  EntityId,
  IncludeNode,
  IncludeTree,
  NormalizedQueryContext,
  RepositoryAdapter,
  ResolvedSoftDelete,
} from "@kavo/core";
import {
  AlreadyDeletedException,
  ConfigurationException,
  NotDeletedException,
  NotFoundException,
  hasKeyset,
  readFilter,
} from "@kavo/core";
import type { DataSource, DeepPartial, ObjectLiteral, Repository, SelectQueryBuilder } from "typeorm";
import { FilterTranslator } from "./filter-translator.js";
import { mapDriverError } from "./error-mapping.js";

/**
 * `RepositoryAdapter` over a TypeORM `Repository`: CRUD with hard *or*
 * soft delete, restore, purge, filtering, sorting, pagination, optional
 * counting.
 *
 * API split: the **QueryBuilder API** serves every
 * read — it is the only surface that can express the translated filter
 * AST, relation-path joins, and skip/take — while the **Repository API**
 * serves writes, where entity hydration and column defaults matter and no
 * dynamic SQL is needed.
 *
 * Relation includes load two ways, per the strategy core
 * resolved: to-one nodes join into the main query, to-many nodes take one
 * extra batched query per level. The engine's transaction handle
 * (`context.transaction`) is the remaining attachment seam.
 */
export class TypeOrmRepositoryAdapter<Entity extends ObjectLiteral> implements RepositoryAdapter<Entity> {
  private readonly repository: Repository<Entity>;
  private readonly alias: string;
  private readonly idField: string;
  /**
   * The `@DeleteDateColumn` property, when the entity declares one. It is
   * what decides *how* a soft delete is written: TypeORM's own
   * `softDelete`/`restore` (which also stamp `@UpdateDateColumn` and know
   * about the default exclusion) for the declared column, a plain column
   * write for a `softDelete.field` that is an ordinary column.
   */
  private readonly deleteDateColumn: string | null;
  /** Kept for batch loading, which re-enters through the DataSource. */
  private readonly entity: ClassRef<Entity>;
  /**
   * Relation property names, so `mergeAndSave` can tell a plain-column
   * patch/update (one `UPDATE`, no preload needed) from one that touches a
   * relation (join-table rows need `save`'s subject diffing against the
   * currently-persisted relation state).
   */
  private readonly relationProperties: ReadonlySet<string>;

  constructor(
    private readonly dataSource: DataSource,
    entity: ClassRef<Entity>,
  ) {
    this.repository = dataSource.getRepository(entity);
    const metadata = dataSource.getMetadata(entity);
    this.alias = metadata.name;
    this.idField = metadata.primaryColumns[0]!.propertyName;
    this.deleteDateColumn = metadata.deleteDateColumn?.propertyName ?? null;
    this.entity = entity;
    this.relationProperties = new Set(metadata.relations.map((relation) => relation.propertyName));
  }

  // ── Reads (QueryBuilder API) ────────────────────────────────────────

  async findOneById(
    id: EntityId,
    query: NormalizedQueryContext<Entity> | null,
    context: KavoContext<Entity>,
  ): Promise<Entity | null> {
    try {
      const include = query?.include ?? {};
      const qb = this.byId(id, context, query?.withDeleted ?? false, query?.onlyDeleted ?? false);
      this.joinIncludes(qb, include, this.alias);
      const entity = await qb.getOne();
      if (entity !== null) await this.loadBatches([entity], this.entity, include);
      return entity;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async findOne(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<Entity | null> {
    try {
      const entity = await this.buildQuery(query, context).take(1).getOne();
      if (entity !== null) await this.loadBatches([entity], this.entity, query.include);
      return entity;
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
      const entities = await this.buildQuery(query, context, { filter: readFilter(query) })
        .skip(hasKeyset(pagination) ? 0 : pagination.offset)
        .take(pagination.limit)
        .getMany();
      await this.loadBatches(entities, this.entity, query.include);
      return entities;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async count(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<number> {
    try {
      // A dedicated count query — never getManyAndCount: the engine only
      // calls this when `query.count` is true, so `total: null` costs
      // zero queries.
      // No includes: counting distinct roots never needs their relations.
      return await this.buildQuery(query, context, { sorted: false, includes: false }).getCount();
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  /**
   * Shared read pipeline: soft-delete scope, filter joins + WHERE, then
   * ORDER BY.
   */
  private buildQuery(
    query: NormalizedQueryContext<Entity>,
    context: KavoContext<Entity>,
    options: { sorted?: boolean; includes?: boolean; filter?: Filter<Entity> } = {},
  ): SelectQueryBuilder<Entity> {
    const qb = this.repository.createQueryBuilder(this.alias);
    this.scopeToLive(qb, context, query.withDeleted, query.onlyDeleted);
    const translator = new FilterTranslator(qb, this.alias);
    // Include joins first, then filters: both name joins the same way, so
    // a filter on `owner.name` reuses the selecting join instead of adding
    // a second one under a duplicate alias.
    if (options.includes !== false) {
      this.joinIncludes(qb, query.include, this.alias, translator);
    }
    translator.apply(options.filter ?? query.filter);
    if (options.sorted !== false) {
      for (const sort of query.sort) {
        qb.addOrderBy(translator.columnRef(sort.field as string), sort.direction === "desc" ? "DESC" : "ASC");
      }
    }
    return qb;
  }

  // ── Relation includes ───────────────────────────────────────────────

  /**
   * Join every `join`-strategy node of the tree into one query. Aliases are
   * deterministic (`Owner__pets__owner`) and match `FilterTranslator`'s
   * scheme, so a filter on an included path reuses the same join; each
   * alias is registered with the translator to keep it from adding a
   * second one.
   */
  private joinIncludes<Row extends ObjectLiteral>(
    qb: SelectQueryBuilder<Row>,
    tree: IncludeTree,
    parentAlias: string,
    translator?: FilterTranslator<Entity>,
  ): void {
    for (const node of Object.values(tree)) {
      if (node.strategy !== "join") continue;
      this.joinNode(qb, node, parentAlias, translator);
    }
  }

  /** One join node plus its own join-strategy subtree. */
  private joinNode<Row extends ObjectLiteral>(
    qb: SelectQueryBuilder<Row>,
    node: IncludeNode,
    parentAlias: string,
    translator?: FilterTranslator<Entity>,
  ): string {
    const alias = `${parentAlias}__${node.relation.name}`;
    // Soft-deleted related rows are excluded from includes — spelled out
    // rather than left to TypeORM's default, because a root `withDeleted`
    // must not silently widen the relation too.
    const live = node.softDelete.strategy === "soft" ? `${alias}.${node.softDelete.field} IS NULL` : undefined;
    qb.leftJoinAndSelect(`${parentAlias}.${node.relation.name}`, alias, live);
    translator?.registerJoin(alias);
    this.joinIncludes(qb, node.children, alias, translator);
    return alias;
  }

  /**
   * Load every `batch` node for a set of already-fetched parents: one
   * query per relation level, parents batched by id, stitched in memory.
   *
   * The parents are re-selected by id with the relation joined, which
   * needs no inverse-side declaration and keeps the shape identical to the
   * join path. Root pagination has already happened by then, which is the
   * point: a to-many never multiplies the rows that pagination counts.
   */
  private async loadBatches(rows: readonly ObjectLiteral[], entity: ClassRef, tree: IncludeTree): Promise<void> {
    if (rows.length === 0) return;
    for (const node of Object.values(tree)) {
      if (node.strategy === "batch") {
        await this.batchLoad(rows, entity, node);
        continue;
      }
      // A join node arrived with the main query; its own to-many children
      // still need their batch, one level down.
      await this.loadBatches(relatedRows(rows, node.relation.name), node.relation.target(), node.children);
    }
  }

  private async batchLoad(parents: readonly ObjectLiteral[], entity: ClassRef, node: IncludeNode): Promise<void> {
    const metadata = this.dataSource.getMetadata(entity);
    const idField = metadata.primaryColumns[0]!.propertyName;
    const ids = [...new Set(parents.map((parent) => parent[idField] as unknown))];
    const alias = metadata.name;

    const qb = this.dataSource
      .getRepository<ObjectLiteral>(entity as ClassRef<ObjectLiteral>)
      .createQueryBuilder(alias)
      // The parents are already chosen; their own deleted state must not
      // filter them back out of their own reload.
      .withDeleted()
      .whereInIds(ids);
    this.joinNode(qb, node, alias);

    const loaded = await qb.getMany();
    const byId = new Map(loaded.map((row) => [row[idField], row[node.relation.name]]));
    const empty = node.relation.cardinality === "many" ? [] : null;
    for (const parent of parents) {
      parent[node.relation.name] = byId.get(parent[idField]) ?? empty;
    }
    await this.loadBatches(relatedRows(parents, node.relation.name), node.relation.target(), node.children);
  }

  // ── Soft delete ──────────────────────────────────────────────────────

  /**
   * Three-way soft-delete scope: exclude deleted rows by default, include
   * both live and deleted with `withDeleted`, or restrict to only deleted
   * with `onlyDeleted` (mutually exclusive — validated upstream). Two
   * marker shapes, one rule each: TypeORM already excludes its own
   * `@DeleteDateColumn` (so opting *in* is the explicit step), while an
   * ordinary marker column needs the `IS NULL`/`IS NOT NULL` predicate
   * spelled out. Entities that aren't soft-deletable touch neither branch.
   */
  private scopeToLive(
    qb: SelectQueryBuilder<Entity>,
    context: KavoContext<Entity>,
    withDeleted: boolean,
    onlyDeleted = false,
  ): void {
    const softDelete = context.config.softDelete;
    if (softDelete.strategy !== "soft") return;
    if (softDelete.field === this.deleteDateColumn) {
      if (onlyDeleted) {
        qb.withDeleted().andWhere(`${this.alias}.${softDelete.field} IS NOT NULL`);
        return;
      }
      if (withDeleted) qb.withDeleted();
      return;
    }
    if (onlyDeleted) {
      qb.andWhere(`${this.alias}.${softDelete.field} IS NOT NULL`);
      return;
    }
    if (!withDeleted) qb.andWhere(`${this.alias}.${softDelete.field} IS NULL`);
  }

  private byId(
    id: EntityId,
    context: KavoContext<Entity>,
    withDeleted: boolean,
    onlyDeleted = false,
  ): SelectQueryBuilder<Entity> {
    const qb = this.repository.createQueryBuilder(this.alias).where(`${this.alias}.${this.idField} = :id`, { id });
    this.scopeToLive(qb, context, withDeleted, onlyDeleted);
    return qb;
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

  private isDeleted(row: Entity, field: string): boolean {
    return row[field] !== null && row[field] !== undefined;
  }

  // ── Writes (Repository API) ─────────────────────────────────────────

  async create(data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const entity = this.repository.create(data as DeepPartial<Entity>);
      return await this.repository.save(entity);
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async update(id: EntityId, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    return this.mergeAndSave(id, data, context);
  }

  async patch(id: EntityId, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    return this.mergeAndSave(id, data, context);
  }

  /**
   * update and patch share one load-merge-save primitive: the *shape* of
   * `data` differs (full body vs. sparse) because the DTO layer differs,
   * not the persistence mechanics.
   *
   * A plain-column write goes through `repository.update` — one `UPDATE`,
   * no preload — since `repository.save` always issues its own pre-flight
   * SELECT to diff the subject against the database, which would double
   * the read already done here. A write that touches a relation still
   * needs `save`: join-table rows are persisted by diffing against the
   * *currently loaded* relation state on `existing`, which is exactly what
   * the extra preload would otherwise fetch.
   */
  private async mergeAndSave(id: EntityId, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    try {
      // Scoped to live rows: a soft-deleted row is invisible to updates,
      // exactly as it is to reads. Reviving one is `restore`'s job.
      const existing = await this.byId(id, context, false).getOne();
      if (existing === null) throw this.notFound(id, context);
      this.repository.merge(existing, data as never);
      const touchesRelation = Object.keys(data).some((key) => this.relationProperties.has(key));
      if (touchesRelation) {
        return await this.repository.save(existing);
      }
      await this.repository.update(id, data as never);
      return existing;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async delete(id: EntityId, context: KavoContext<Entity>): Promise<void> {
    const softDelete = context.config.softDelete;
    try {
      if (softDelete.strategy === "hard") {
        const result = await this.repository.delete(id);
        if (result.affected === 0) throw this.notFound(id, context);
        return;
      }
      const { field } = softDelete;
      const existing = await this.byId(id, context, true).getOne();
      if (existing === null) throw this.notFound(id, context);
      if (this.isDeleted(existing, field)) {
        throw new AlreadyDeletedException({
          messageParams: { entity: context.entityName, id: String(id) },
          context: errorContext(context),
        });
      }
      if (field === this.deleteDateColumn) {
        // softRemove over the already-loaded row (not softDelete(id)): it
        // goes through the same subject-persist path as `save`, so
        // @DeleteDateColumn entities get their soft-remove lifecycle hooks,
        // matching restore's `recover` counterpart below.
        await this.repository.softRemove(existing);
      } else {
        await this.repository.update(id, { [field]: new Date() } as never);
      }
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async restore(id: EntityId, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const { field } = this.requireSoftDelete(context, "restore");
      const existing = await this.byId(id, context, true).getOne();
      if (existing === null) throw this.notFound(id, context);
      if (!this.isDeleted(existing, field)) {
        throw new NotDeletedException({
          messageParams: { entity: context.entityName, id: String(id) },
          context: errorContext(context),
        });
      }
      if (field === this.deleteDateColumn) {
        // recover returns the same row with the column cleared in memory
        // and in the database, so no re-read is needed afterward.
        return await this.repository.recover(existing);
      }
      // A plain marker column is a single-field write with no relation
      // involvement: mutate the already-loaded row instead of re-reading it.
      await this.repository.update(id, { [field]: null } as never);
      existing[field as keyof Entity] = null as never;
      return existing;
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
        const existing = await this.byId(id, context, true).getOne();
        if (existing === null) throw this.notFound(id, context);
        if (!this.isDeleted(existing, softDelete.field)) {
          throw new NotDeletedException({
            messageParams: { entity: context.entityName, id: String(id) },
            context: errorContext(context),
          });
        }
      }
      const result = await this.repository.delete(id);
      if (result.affected === 0) throw this.notFound(id, context);
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  /**
   * `arrayMutation`'s `replace` strategy (ADR-0014): whole-array replace of
   * a to-many relation, computed as an add/remove diff against the
   * currently persisted membership so TypeORM's `RelationQueryBuilder`
   * touches only the join rows that actually change — `addAndRemove` is
   * the primitive that gets `set`-like replace semantics for a to-many
   * edge, since TypeORM's own `.set()` only exists on the to-one side.
   *
   * The related entity's own id field — not this entity's `idField` — is
   * what `memberIds` names and what the diff compares against.
   */
  async replaceRelation(
    id: EntityId,
    relation: string,
    memberIds: readonly EntityId[] | null,
    context: KavoContext<Entity>,
  ): Promise<Entity> {
    try {
      const existing = await this.byId(id, context, false).getOne();
      if (existing === null) throw this.notFound(id, context);

      const relationMetadata = this.dataSource
        .getMetadata(this.entity)
        .relations.find((candidate) => candidate.propertyName === relation);
      if (relationMetadata === undefined) {
        throw new ConfigurationException(
          context.entityName,
          `relations.edges.${relation}.write`,
          `'${relation}' is not a relation of '${context.entityName}' known to TypeORM`,
        );
      }
      const relatedIdField = relationMetadata.inverseEntityMetadata.primaryColumns[0]!.propertyName;

      const relationBuilder = this.dataSource.createQueryBuilder().relation(this.entity, relation).of(id);
      const current = (await relationBuilder.loadMany()) as ObjectLiteral[];
      const currentIds = new Set(current.map((row) => row[relatedIdField] as EntityId));
      const desiredIds = new Set(memberIds ?? []);
      const toAdd = [...desiredIds].filter((memberId) => !currentIds.has(memberId));
      const toRemove = [...currentIds].filter((memberId) => !desiredIds.has(memberId));
      if (toAdd.length > 0 || toRemove.length > 0) {
        await relationBuilder.addAndRemove(toAdd, toRemove);
      }

      const reloaded = await this.repository.findOne({
        where: { [this.idField]: id } as never,
        relations: { [relation]: true } as never,
      });
      if (reloaded === null) throw this.notFound(id, context);
      return reloaded;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  private notFound(id: EntityId, context: KavoContext<Entity>): NotFoundException {
    return new NotFoundException({
      messageParams: { entity: context.entityName, id: String(id) },
      context: errorContext(context),
    });
  }
}

/** The loaded rows on one relation of a set of parents, flattened. */
function relatedRows(parents: readonly ObjectLiteral[], name: string): readonly ObjectLiteral[] {
  const rows: ObjectLiteral[] = [];
  for (const parent of parents) {
    const value = parent[name];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) rows.push(...(value as ObjectLiteral[]));
    else rows.push(value as ObjectLiteral);
  }
  return rows;
}

function errorContext<Entity>(context: KavoContext<Entity>) {
  return {
    entityName: context.entityName,
    operation: context.operation,
    correlationId: context.correlationId,
  };
}
