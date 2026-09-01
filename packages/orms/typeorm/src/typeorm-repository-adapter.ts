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
  ArrayMutationMemberNotFoundException,
  ConfigurationException,
  JsonPatchTargetNotFoundException,
  NotDeletedException,
  NotFoundException,
  PatchNoChangesException,
  decodeCompositeId,
  hasKeyset,
  readFilter,
} from "@kavo/core";
import type { DataSource, DeepPartial, ObjectLiteral, Repository, SelectQueryBuilder } from "typeorm";
import { In } from "typeorm";
import { FilterTranslator } from "./filter-translator.js";
import { mapDriverError } from "./error-mapping.js";
import { fieldKindOf } from "./metadata.js";

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
   * The full ordered primary-key column list for a composite-key entity
   * (issue #261), `null` for the single-key case, which every method
   * below keeps behaving exactly as it did before this field existed.
   */
  private readonly compositeIdFields: readonly string[] | null;
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
    this.compositeIdFields =
      metadata.primaryColumns.length > 1 ? metadata.primaryColumns.map((column) => column.propertyName) : null;
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
      if (entity !== null) {
        await this.loadBatches([entity], this.entity, include);
      }
      return entity;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async findOne(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<Entity | null> {
    try {
      const entity = await this.buildQuery(query, context).take(1).getOne();
      if (entity !== null) {
        await this.loadBatches([entity], this.entity, query.include);
      }
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
      if (node.strategy === "key") {
        // `strategy: "key"` (issue #364): pull the local FK id into a
        // scratch property on the same query — no `leftJoinAndSelect`, no
        // batch. `finalizeKeyNodes` turns it into `{ <pk>: value }` / null.
        qb.loadRelationIdAndMap(
          `${parentAlias}.${keyScratch(node.relation.name)}`,
          `${parentAlias}.${node.relation.name}`,
        );
        continue;
      }
      if (node.strategy !== "join") {
        continue;
      }
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
    if (rows.length === 0) {
      return;
    }
    for (const node of Object.values(tree)) {
      if (node.strategy === "key") {
        // The FK id already rode in on the owning query as a scratch
        // property (`joinIncludes`); turn it into `{ <pk>: value }` / null.
        const scratch = keyScratch(node.relation.name);
        for (const row of rows) {
          const fk = row[scratch];
          delete row[scratch];
          row[node.relation.name] = fk === null || fk === undefined ? null : { [node.idField!]: fk };
        }
        continue;
      }
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
    const pkFields = metadata.primaryColumns.map((column) => column.propertyName);
    // `entity` here is whichever entity is the *parent* being re-loaded by
    // id — for a composite-key parent (issue #261) `whereInIds` already
    // accepts an array of `{ column: value }` objects natively, so the
    // only generalization needed is a canonical map key wider than a bare
    // column value; `pkFields.length === 1` keeps the single-key case
    // identical to before this method knew composite keys existed.
    const rowId = (row: ObjectLiteral): unknown =>
      pkFields.length === 1 ? row[pkFields[0]!] : Object.fromEntries(pkFields.map((field) => [field, row[field]]));
    const rowKey = (row: ObjectLiteral): unknown =>
      pkFields.length === 1 ? row[pkFields[0]!] : JSON.stringify(pkFields.map((field) => row[field]));
    const seen = new Map<unknown, unknown>();
    for (const parent of parents) {
      const key = rowKey(parent);
      if (!seen.has(key)) {
        seen.set(key, rowId(parent));
      }
    }
    const ids = [...seen.values()];
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
    const byId = new Map(loaded.map((row) => [rowKey(row), row[node.relation.name]]));
    const empty = node.relation.cardinality === "many" ? [] : null;
    for (const parent of parents) {
      parent[node.relation.name] = byId.get(rowKey(parent)) ?? empty;
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
    if (softDelete.strategy !== "soft") {
      return;
    }
    if (softDelete.field === this.deleteDateColumn) {
      if (onlyDeleted) {
        qb.withDeleted().andWhere(`${this.alias}.${softDelete.field} IS NOT NULL`);
        return;
      }
      if (withDeleted) {
        qb.withDeleted();
      }
      return;
    }
    if (onlyDeleted) {
      qb.andWhere(`${this.alias}.${softDelete.field} IS NOT NULL`);
      return;
    }
    if (!withDeleted) {
      qb.andWhere(`${this.alias}.${softDelete.field} IS NULL`);
    }
  }

  /**
   * `id: EntityId` (one delimited string, `encodeCompositeId`/
   * `decodeCompositeId`, issue #261) decoded into the `{ column: value }`
   * record TypeORM's own composite-key criteria shape already is —
   * `FindOptionsWhere<Entity>`, which `Repository.update`/`.delete` and
   * `SelectQueryBuilder.where` all accept natively, so no bespoke WHERE
   * building is needed beyond this decode. Only ever called when
   * `compositeIdFields` is set; the engine has already shape-validated
   * `id` (`KavoEngine.coerceId`), so a decode failure here means an id
   * reached the adapter some other way (a direct `RepositoryAdapter` call,
   * bypassing the engine) — worth a clear configuration-shaped error, not
   * a driver-level one.
   */
  private compositeCriteria(id: EntityId): Record<string, unknown> {
    const fields = this.compositeIdFields!;
    const parts = decodeCompositeId(String(id), fields.length);
    if (parts === null) {
      throw new ConfigurationException(
        this.alias,
        "id",
        `id '${String(id)}' does not decode into ${fields.length} key columns (${fields.join(", ")})`,
      );
    }
    const metadata = this.dataSource.getMetadata(this.entity);
    const criteria: Record<string, unknown> = {};
    for (const [index, field] of fields.entries()) {
      const column = metadata.primaryColumns.find((candidate) => candidate.propertyName === field)!;
      criteria[field] = fieldKindOf(column) === "number" ? Number(parts[index]) : parts[index];
    }
    return criteria;
  }

  /**
   * The criteria argument every `Repository.update`/`.delete` call below
   * passes: the bare `id` for a single-key entity (unchanged from before
   * this field existed), `compositeCriteria(id)`'s decoded record
   * otherwise — both are shapes TypeORM's own criteria parameter accepts.
   */
  private updateCriteria(id: EntityId): unknown {
    return this.compositeIdFields === null ? id : this.compositeCriteria(id);
  }

  /**
   * A `findOne({ where: … })` criteria object — always a plain object,
   * unlike {@link updateCriteria} above, whose bare-scalar single-key form
   * is only valid as a `Repository.update`/`.delete`/`RelationQueryBuilder.of`
   * argument. `findOne`'s `where` is never a bare scalar for either case:
   * `{ [idField]: id }` for a single-key entity (unchanged from before this
   * field existed), `compositeCriteria(id)`'s decoded record otherwise.
   */
  private findOneCriteria(id: EntityId): Record<string, unknown> {
    return this.compositeIdFields === null ? { [this.idField]: id } : this.compositeCriteria(id);
  }

  private byId(
    id: EntityId,
    context: KavoContext<Entity>,
    withDeleted: boolean,
    onlyDeleted = false,
  ): SelectQueryBuilder<Entity> {
    const qb = this.repository.createQueryBuilder(this.alias);
    if (this.compositeIdFields === null) {
      qb.where(`${this.alias}.${this.idField} = :id`, { id });
    } else {
      qb.where(this.compositeCriteria(id) as ObjectLiteral);
    }
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
    this.requirePatchChanges(id, data, context);
    return this.mergeAndSave(id, data, context);
  }

  /**
   * `patch` (unlike `update`) rejects a body that carries no field changes
   * — checked against the same immutable-key strip `mergeAndSave` applies,
   * so a body naming only the id and/or the soft-delete marker is treated
   * the same as a genuinely empty one. Raised before the row is even
   * loaded: this is a client-input problem, not a state one.
   */
  private requirePatchChanges(id: EntityId, rawData: Partial<Entity>, context: KavoContext<Entity>): void {
    const data = stripImmutableKeys(rawData, this.compositeIdFields ?? [this.idField], context.config.softDelete.field);
    if (Object.keys(data).length === 0) {
      throw new PatchNoChangesException({
        messageParams: { entity: context.entityName, id: String(id) },
        context: errorContext(context),
      });
    }
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
  private async mergeAndSave(id: EntityId, rawData: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    try {
      // Scoped to live rows: a soft-deleted row is invisible to updates,
      // exactly as it is to reads. Reviving one is `restore`'s job.
      const existing = await this.byId(id, context, false).getOne();
      if (existing === null) {
        throw this.notFound(id, context);
      }
      // Defence in depth, mirroring the deserializer's own exclusion: even
      // an explicit write DTO that legitimately names the id (to assign a
      // natural key on `create`) must not be allowed to reassign an
      // *existing* row's identity, and the soft-delete marker is
      // `deleteOne`/`restoreOne`'s state machine to change, not an
      // ordinary column an update/patch body happens to include.
      const data = stripImmutableKeys(
        rawData,
        this.compositeIdFields ?? [this.idField],
        context.config.softDelete.field,
      );
      // Everything the body carried may have been the id and/or the marker
      // — TypeORM's `update` rejects an empty value set outright, and there
      // is nothing left to change: the current row, unmodified, is the
      // correct answer.
      if (Object.keys(data).length === 0) {
        return existing;
      }
      this.repository.merge(existing, data as never);
      const touchesRelation = Object.keys(data).some((key) => this.relationProperties.has(key));
      if (touchesRelation) {
        return await this.repository.save(existing);
      }
      if (this.compositeIdFields === null) {
        await this.repository.update(id, data as never);
      } else {
        await this.repository.update(this.compositeCriteria(id) as never, data as never);
      }
      return existing;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async delete(id: EntityId, context: KavoContext<Entity>): Promise<void> {
    const softDelete = context.config.softDelete;
    try {
      if (softDelete.strategy === "hard") {
        const result = await this.repository.delete(this.updateCriteria(id) as never);
        if (result.affected === 0) {
          throw this.notFound(id, context);
        }
        return;
      }
      const { field } = softDelete;
      const existing = await this.byId(id, context, true).getOne();
      if (existing === null) {
        throw this.notFound(id, context);
      }
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
        await this.repository.update(this.updateCriteria(id) as never, { [field]: new Date() } as never);
      }
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async restore(id: EntityId, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const { field } = this.requireSoftDelete(context, "restore");
      const existing = await this.byId(id, context, true).getOne();
      if (existing === null) {
        throw this.notFound(id, context);
      }
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
      await this.repository.update(this.updateCriteria(id) as never, { [field]: null } as never);
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
      const result = await this.repository.delete(this.updateCriteria(id) as never);
      if (result.affected === 0) {
        throw this.notFound(id, context);
      }
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  /**
   * `false` only for a composite-key entity's (issue #263) many-to-many
   * relation — `@JoinTable()`'s junction columns pointing back at the
   * owning side make `relation.joinColumns.length` 2+, and TypeORM's own
   * `RelationQueryBuilder.add`/`.set` validate the *member* value's shape
   * against that count (`relation.joinColumns.length > 1` in
   * `node_modules/typeorm/query-builder/RelationQueryBuilder.js`), which no
   * bare member id — Tag, Topic, whatever the target's own single-column
   * id is — ever satisfies. A one-to-many relation's FK lives on the child
   * row instead, so `joinColumns` there is empty and this never refuses it.
   */
  supportsArrayMutation(relation: string): boolean {
    if (this.compositeIdFields === null) {
      return true;
    }
    const relationMetadata = this.dataSource
      .getMetadata(this.entity)
      .relations.find((candidate) => candidate.propertyName === relation);
    return (relationMetadata?.joinColumns.length ?? 0) <= 1;
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
      if (existing === null) {
        throw this.notFound(id, context);
      }

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

      const relationBuilder = this.dataSource
        .createQueryBuilder()
        .relation(this.entity, relation)
        .of(this.updateCriteria(id));
      const current = (await relationBuilder.loadMany()) as ObjectLiteral[];
      const currentIds = new Set(current.map((row) => row[relatedIdField] as EntityId));
      const desiredIds = new Set(memberIds ?? []);
      const toAdd = [...desiredIds].filter((memberId) => !currentIds.has(memberId));
      const toRemove = [...currentIds].filter((memberId) => !desiredIds.has(memberId));
      if (toAdd.length > 0) {
        // `addAndRemove` on a to-many owned by a foreign-key column (the
        // one-to-many case) issues `UPDATE … WHERE id IN (…)`, which simply
        // affects zero rows for a member id that doesn't exist — no
        // constraint violation for `mapDriverError` to translate. Checked
        // explicitly so a nonexistent member id is a 404, not a silent
        // no-op the caller reads back as success.
        const targetRepository = this.dataSource.getRepository<ObjectLiteral>(
          relationMetadata.inverseEntityMetadata.target as ClassRef<ObjectLiteral>,
        );
        const found = await targetRepository.find({
          where: { [relatedIdField]: In(toAdd) } as never,
          select: { [relatedIdField]: true } as never,
        });
        const foundIds = new Set(found.map((row) => row[relatedIdField] as EntityId));
        const missing = toAdd.filter((memberId) => !foundIds.has(memberId));
        if (missing.length > 0) {
          throw new NotFoundException({
            messageParams: { entity: relationMetadata.inverseEntityMetadata.name, id: missing.join(", ") },
            context: errorContext(context),
          });
        }
      }
      if (toAdd.length > 0 || toRemove.length > 0) {
        await relationBuilder.addAndRemove(toAdd, toRemove);
      }

      const reloaded = await this.repository.findOne({
        where: this.findOneCriteria(id) as never,
        relations: { [relation]: true } as never,
      });
      if (reloaded === null) {
        throw this.notFound(id, context);
      }
      return reloaded;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  /**
   * `arrayMutation`'s `jsonPatch` strategy (ADR-0029's jsonPatch
   * amendment): incremental add/remove of one relation's membership.
   * Unlike `replaceRelation` above — whose read and write are two separate
   * round trips, a known gap its own doc comment names — this method's
   * read (current membership, which decides whether a `remove` target
   * exists) and its write must commit together: `dataSource.transaction`
   * wraps both, so a concurrent writer can never make the "is this id
   * currently a member?" judgment stale by the time the removal executes.
   */
  async patchRelation(
    id: EntityId,
    relation: string,
    changes: { readonly add: readonly EntityId[]; readonly remove: readonly EntityId[] },
    context: KavoContext<Entity>,
  ): Promise<Entity> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const existing = await manager.getRepository(this.entity).findOne({ where: this.findOneCriteria(id) as never });
        if (existing === null) {
          throw this.notFound(id, context);
        }

        const relationMetadata = manager.connection
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
        const relatedEntityName = relationMetadata.inverseEntityMetadata.name;

        const relationBuilder = manager
          .createQueryBuilder()
          .relation(this.entity, relation)
          .of(this.updateCriteria(id));
        const current = (await relationBuilder.loadMany()) as ObjectLiteral[];
        const currentIds = new Set(current.map((row) => row[relatedIdField] as EntityId));

        // A `remove` target that isn't currently a member is a distinct,
        // explicit failure (RFC 6902 requires a `remove`'s target location
        // to exist) — not the same as `replaceRelation`'s "add of a missing
        // row" question below, and not a silent no-op either.
        const missingRemovals = changes.remove.filter((memberId) => !currentIds.has(memberId));
        if (missingRemovals.length > 0) {
          // The parent entity — `relation` is one of *its* edges, not one of
          // `relatedEntityName`'s — matching `ArrayMutationInvalidShapeException`'s
          // own `{ entity: context.entityName, relation }` convention
          // (`kavo-engine.ts`).
          throw new JsonPatchTargetNotFoundException({
            messageParams: { entity: context.entityName, relation, id: missingRemovals.join(", ") },
            context: errorContext(context),
          });
        }

        // Idempotent: an `add` of an id already a member changes nothing.
        const toAdd = changes.add.filter((memberId) => !currentIds.has(memberId));
        if (toAdd.length > 0) {
          const targetRepository = manager.getRepository<ObjectLiteral>(
            relationMetadata.inverseEntityMetadata.target as ClassRef<ObjectLiteral>,
          );
          const found = await targetRepository.find({
            where: { [relatedIdField]: In(toAdd) } as never,
            select: { [relatedIdField]: true } as never,
          });
          const foundIds = new Set(found.map((row) => row[relatedIdField] as EntityId));
          const missing = toAdd.filter((memberId) => !foundIds.has(memberId));
          if (missing.length > 0) {
            throw new NotFoundException({
              messageParams: { entity: relatedEntityName, id: missing.join(", ") },
              context: errorContext(context),
            });
          }
        }

        if (toAdd.length > 0 || changes.remove.length > 0) {
          await relationBuilder.addAndRemove(toAdd, changes.remove);
        }

        const reloaded = await manager.getRepository(this.entity).findOne({
          where: this.findOneCriteria(id) as never,
          relations: { [relation]: true } as never,
        });
        if (reloaded === null) {
          throw this.notFound(id, context);
        }
        return reloaded;
      });
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  /**
   * `arrayMutation`'s `resource` strategy (ADR-0029's resource amendment):
   * `GET :id/<relation>`'s current-membership read. A pure read, unlike the
   * three writes below — no transaction needed.
   *
   * The existence check goes through `byId` (soft-delete-scoped), the same
   * as `replaceRelation`'s own — a soft-deleted parent (on a custom marker
   * column; `@DeleteDateColumn` is excluded by TypeORM's own repository API
   * regardless) must 404 here exactly as it does on `GET /entity/:id`, not
   * stay reachable through the one primitive that skipped the check.
   */
  async readRelation(id: EntityId, relation: string, context: KavoContext<Entity>): Promise<Entity> {
    try {
      this.relationMetadataOf(this.dataSource, relation, context);
      const existing = await this.byId(id, context, false).getOne();
      if (existing === null) {
        throw this.notFound(id, context);
      }
      const reloaded = await this.repository.findOne({
        where: this.findOneCriteria(id) as never,
        relations: { [relation]: true } as never,
      });
      if (reloaded === null) {
        throw this.notFound(id, context);
      }
      return reloaded;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  /**
   * `arrayMutation`'s `resource` strategy: `POST :id/<relation>`, adding one
   * member by id. Idempotent (an id already a member changes nothing);
   * adding an id with no matching row raises `NotFoundException` — the same
   * existence check `replaceRelation`/`patchRelation` already raise.
   */
  async addRelationMember(
    id: EntityId,
    relation: string,
    memberId: EntityId,
    context: KavoContext<Entity>,
  ): Promise<Entity> {
    return this.mutateSingleRelationMember(id, relation, memberId, "add", context);
  }

  /**
   * `arrayMutation`'s `resource` strategy: `DELETE :id/<relation>`, removing
   * one member by id. Removing an id that is not currently a member raises
   * `ArrayMutationMemberNotFoundException` rather than a silent no-op.
   */
  async removeRelationMember(
    id: EntityId,
    relation: string,
    memberId: EntityId,
    context: KavoContext<Entity>,
  ): Promise<Entity> {
    return this.mutateSingleRelationMember(id, relation, memberId, "remove", context);
  }

  /**
   * Shared transactional core of `addRelationMember`/`removeRelationMember`
   * — the read that decides "is this id currently a member?" and the write
   * it gates must commit together, the same reason `patchRelation`'s
   * `jsonPatch` `add`/`remove` does: a concurrent writer can never make that
   * judgment stale between the check and the change.
   */
  private async mutateSingleRelationMember(
    id: EntityId,
    relation: string,
    memberId: EntityId,
    action: "add" | "remove",
    context: KavoContext<Entity>,
  ): Promise<Entity> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // Soft-delete-scoped, the same as `replaceRelation`'s own existence
        // check (`byId`) — a soft-deleted parent must 404 here too, not
        // stay reachable through `add`/`removeRelationMember`.
        const existingQb = manager.getRepository(this.entity).createQueryBuilder(this.alias);
        if (this.compositeIdFields === null) {
          existingQb.where(`${this.alias}.${this.idField} = :id`, { id });
        } else {
          existingQb.where(this.compositeCriteria(id) as ObjectLiteral);
        }
        this.scopeToLive(existingQb, context, false, false);
        const existing = await existingQb.getOne();
        if (existing === null) {
          throw this.notFound(id, context);
        }

        const relationMetadata = this.relationMetadataOf(manager, relation, context);
        const relatedIdField = relationMetadata.inverseEntityMetadata.primaryColumns[0]!.propertyName;
        const relatedEntityName = relationMetadata.inverseEntityMetadata.name;

        const relationBuilder = manager
          .createQueryBuilder()
          .relation(this.entity, relation)
          .of(this.updateCriteria(id));
        // A targeted existence check rather than `relationBuilder.loadMany()`
        // — this only ever needs "is *this one* id currently a member?",
        // not the full current membership `patchRelation`'s batch diff
        // genuinely needs, so it stays O(1) against the join regardless of
        // how large the relation is.
        const memberCheckQb = manager
          .createQueryBuilder(this.entity, this.alias)
          .innerJoin(`${this.alias}.${relation}`, "member", `member.${relatedIdField} = :memberId`, { memberId });
        if (this.compositeIdFields === null) {
          memberCheckQb.where(`${this.alias}.${this.idField} = :id`, { id });
        } else {
          memberCheckQb.andWhere(this.compositeCriteria(id) as ObjectLiteral);
        }
        const isMember = await memberCheckQb.getExists();

        if (action === "remove") {
          if (!isMember) {
            throw new ArrayMutationMemberNotFoundException({
              messageParams: { entity: context.entityName, relation, id: String(memberId) },
              context: errorContext(context),
            });
          }
          await relationBuilder.remove(memberId);
        } else if (!isMember) {
          // Idempotent: an `add` of an id already a member changes nothing.
          const targetRepository = manager.getRepository<ObjectLiteral>(
            relationMetadata.inverseEntityMetadata.target as ClassRef<ObjectLiteral>,
          );
          const found = await targetRepository.findOne({ where: { [relatedIdField]: memberId } as never });
          if (found === null) {
            throw new NotFoundException({
              messageParams: { entity: relatedEntityName, id: String(memberId) },
              context: errorContext(context),
            });
          }
          await relationBuilder.add(memberId);
        }

        const reloaded = await manager.getRepository(this.entity).findOne({
          where: this.findOneCriteria(id) as never,
          relations: { [relation]: true } as never,
        });
        if (reloaded === null) {
          throw this.notFound(id, context);
        }
        return reloaded;
      });
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  /**
   * The relation's TypeORM metadata, by property name — shared by every
   * `arrayMutation` primitive that needs the related entity's own id field
   * and name. Takes the datasource-or-manager the caller is already
   * scoped to (a bare read here, a transaction's `manager` in a write),
   * rather than always reaching for `this.dataSource`, so a write's lookup
   * stays inside the same transaction as the change it informs.
   */
  private relationMetadataOf(
    source: DataSource | { readonly connection: DataSource },
    relation: string,
    context: KavoContext<Entity>,
  ) {
    const connection = "connection" in source ? source.connection : source;
    const relationMetadata = connection
      .getMetadata(this.entity)
      .relations.find((candidate) => candidate.propertyName === relation);
    if (relationMetadata === undefined) {
      throw new ConfigurationException(
        context.entityName,
        `relations.edges.${relation}.write`,
        `'${relation}' is not a relation of '${context.entityName}' known to TypeORM`,
      );
    }
    return relationMetadata;
  }

  private notFound(id: EntityId, context: KavoContext<Entity>): NotFoundException {
    return new NotFoundException({
      messageParams: { entity: context.entityName, id: String(id) },
      context: errorContext(context),
    });
  }
}

/**
 * `mergeAndSave`'s defence-in-depth strip: a shallow copy of `data` with
 * the id field and (when soft-deletable) the resolved marker field
 * removed, so neither reaches `merge`/`update` regardless of what a write
 * DTO declared. Also drops any key whose value is `undefined` — a DTO
 * instance can carry these as *own* properties (e.g. a class-fields
 * subclass under `useDefineForClassFields`, issue #289) even though the
 * client never sent that key, and `undefined` never means "set this to
 * nothing" in JSON. Leaving them in would make an effectively-empty patch
 * look non-empty to both this function's caller and `requirePatchChanges`.
 */
function stripImmutableKeys<Entity>(
  data: Partial<Entity>,
  idFields: readonly string[],
  softDeleteField: string | null,
): Partial<Entity> {
  const copy = { ...(data as Record<string, unknown>) };
  for (const idField of idFields) {
    delete copy[idField];
  }
  if (softDeleteField !== null) {
    delete copy[softDeleteField];
  }
  for (const key of Object.keys(copy)) {
    if (copy[key] === undefined) {
      delete copy[key];
    }
  }
  return copy as Partial<Entity>;
}

/** The loaded rows on one relation of a set of parents, flattened. */
/**
 * The scratch property `strategy: "key"` maps the local FK id onto,
 * before it is rewritten as `{ <pk>: value }`. Namespaced so it cannot
 * collide with a real column or relation of the entity.
 */
function keyScratch(relationName: string): string {
  return `__kavoKey__${relationName}`;
}

function relatedRows(parents: readonly ObjectLiteral[], name: string): readonly ObjectLiteral[] {
  const rows: ObjectLiteral[] = [];
  for (const parent of parents) {
    const value = parent[name];
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      rows.push(...(value as ObjectLiteral[]));
    } else {
      rows.push(value as ObjectLiteral);
    }
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
