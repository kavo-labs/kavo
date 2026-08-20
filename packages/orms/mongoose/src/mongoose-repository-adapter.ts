import type {
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
  hasKeyset,
  readFilter,
} from "@kavo/core";
import { mapDriverError } from "./error-mapping.js";
import { translateFilter, type FilterTranslatorOptions, type MongoWhere } from "./filter-translator.js";
import { asModel } from "./metadata.js";
import type { MongooseModelLike } from "./mongoose-like.js";
import { toPlainDocument, toPlainResult } from "./plain-document.js";
import { assertQueryablePath } from "./relation-paths.js";

/** One `populate` entry — Mongoose's own option shape, built structurally. */
interface PopulateSpec {
  readonly path: string;
  readonly match?: Record<string, unknown>;
  readonly populate?: readonly PopulateSpec[];
}

/**
 * `RepositoryAdapter` over a Mongoose model: CRUD with hard *or* soft
 * delete, restore, purge, filtering, sorting, pagination, optional
 * counting, and relation loading through `populate`.
 *
 * **No join/batch split.** `@kavo/typeorm` translates
 * `IncludeNode.strategy` because it drives a SQL query builder, where a
 * to-many `JOIN` multiplies root rows and would break pagination.
 * Mongoose's `populate` has no such failure mode — it issues its own
 * separate query per edge and stitches in memory, to-one and to-many alike,
 * so a to-many include never disturbs root pagination. This adapter
 * therefore *ignores* `IncludeNode.strategy` and maps every node the same
 * way, exactly as `@kavo/prisma` does.
 *
 * **Every read is `lean`.** Hydrated Mongoose documents carry getters,
 * virtuals, and change tracking that core has no use for and the serializer
 * would have to strip; `lean: true` returns plain objects, and
 * `toPlainDocument` then renders their `ObjectId`s as strings.
 */
export class MongooseRepositoryAdapter<Entity extends object> implements RepositoryAdapter<Entity> {
  private readonly model: MongooseModelLike;
  /**
   * Every id lookup below spells the predicate `{ [idField]: { $eq: id } }`
   * rather than the `{ [idField]: id }` shorthand, for the same reason
   * `translateFilter` does (see `filter-translator.ts`): the shorthand
   * splices an *object* value in as operators, so an id arriving as
   * `{ "$gt": "" }` would silently address "the first document" instead of
   * one document. Nothing this package ships can produce a non-string id —
   * Nest binds it from `@Param` — but a custom operation calling
   * `engine.execute({ id })` with a value off a JSON body could, and a
   * `delete`/`purge` that matched the wrong document is not a failure worth
   * leaving to the caller's discipline.
   */
  private readonly idField: string;
  private readonly filterOptions: FilterTranslatorOptions;
  private readonly relationNames: ReadonlySet<string>;

  constructor(metadata: EntityMetadata<Entity>) {
    // The entity *is* the Mongoose model here, so the adapter needs no
    // second handle on the collection — see ADR-0018.
    this.model = asModel(metadata.entity);
    this.idField = metadata.idField;
    this.relationNames = new Set(metadata.relations.map((relation) => relation.name));
    this.filterOptions = { relationNames: this.relationNames };
  }

  // ── Reads ────────────────────────────────────────────────────────────

  async findOneById(
    id: EntityId,
    query: NormalizedQueryContext<Entity> | null,
    context: KavoContext<Entity>,
  ): Promise<Entity | null> {
    try {
      const where = this.scopeToLive(
        { [this.idField]: { $eq: id } },
        context,
        query?.withDeleted ?? false,
        query?.onlyDeleted ?? false,
      );
      const row = await this.model.findOne(where, null, this.readOptions(this.buildPopulate(query?.include ?? {})));
      return row === null || row === undefined ? null : (toPlainResult(row) as Entity);
    } catch (error) {
      throw this.mapError(error, context, true);
    }
  }

  async findOne(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<Entity | null> {
    try {
      const row = await this.model.findOne(
        this.buildWhere(query, context),
        null,
        this.readOptions(this.buildPopulate(query.include), this.buildSort(query)),
      );
      return row === null || row === undefined ? null : (toPlainResult(row) as Entity);
    } catch (error) {
      throw this.mapError(error, context);
    }
  }

  async findMany(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<readonly Entity[]> {
    try {
      // `readFilter` folds in the keyset predicate under cursor pagination
      // (a no-op otherwise), and a cursor page has no `offset` to skip by —
      // the keyset predicate *is* the skip.
      const { pagination } = query;
      const rows = await this.model.find(this.buildWhere(query, context, readFilter(query)), null, {
        ...this.readOptions(this.buildPopulate(query.include), this.buildSort(query)),
        skip: hasKeyset(pagination) ? 0 : pagination.offset,
        limit: pagination.limit,
      });
      return rows.map((row) => toPlainResult(row) as Entity);
    } catch (error) {
      throw this.mapError(error, context);
    }
  }

  async count(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<number> {
    try {
      // A dedicated count — never fetch-then-length. The engine calls this
      // only when `query.count` is true, so `total: null` costs no query.
      return await this.model.countDocuments(this.buildWhere(query, context));
    } catch (error) {
      throw this.mapError(error, context);
    }
  }

  private buildWhere(
    query: NormalizedQueryContext<Entity>,
    context: KavoContext<Entity>,
    filter: Filter<Entity> = query.filter,
  ): MongoWhere {
    return this.scopeToLive(translateFilter(filter, this.filterOptions), context, query.withDeleted, query.onlyDeleted);
  }

  private readOptions(populate: readonly PopulateSpec[] | undefined, sort?: Record<string, 1 | -1>) {
    return {
      lean: true,
      ...(sort && Object.keys(sort).length > 0 && { sort }),
      ...(populate && { populate }),
    };
  }

  /**
   * `[{ field: 'age', direction: 'desc' }]` → `{ age: -1 }`. Key insertion
   * order is the sort precedence, which MongoDB honours, so the multi-key
   * case needs no extra machinery.
   */
  private buildSort(query: NormalizedQueryContext<Entity>): Record<string, 1 | -1> {
    const sort: Record<string, 1 | -1> = {};
    for (const entry of query.sort) {
      const field = entry.field as string;
      assertQueryablePath(field, this.relationNames, "sorting");
      sort[field] = entry.direction === "desc" ? -1 : 1;
    }
    return sort;
  }

  // ── Relation includes ───────────────────────────────────────────────

  /**
   * Translate a validated `IncludeTree` into Mongoose `populate` specs.
   * Soft-deleted related documents are excluded through `match`, which
   * works identically on a to-one edge (the property comes back `null`) and
   * a to-many edge (the entry is filtered out of the array). A root
   * `withDeleted` is the root's own opt-in and never widens an included
   * relation — the same rule the other two adapters follow.
   */
  private buildPopulate(tree: IncludeTree): readonly PopulateSpec[] | undefined {
    const nodes = Object.values(tree);
    if (nodes.length === 0) return undefined;
    return nodes.map((node) => {
      const children = this.buildPopulate(node.children);
      return {
        path: node.relation.name,
        ...(node.softDelete.strategy === "soft" && { match: { [node.softDelete.field]: null } }),
        ...(children && { populate: children }),
      };
    });
  }

  // ── Soft delete ──────────────────────────────────────────────────────

  private scopeToLive(
    where: MongoWhere,
    context: KavoContext<Entity>,
    withDeleted: boolean,
    onlyDeleted = false,
  ): MongoWhere {
    const softDelete = context.config.softDelete;
    if (softDelete.strategy !== "soft") return where;
    if (onlyDeleted) {
      const deleted = { [softDelete.field]: { $ne: null } };
      return Object.keys(where).length === 0 ? deleted : { $and: [where, deleted] };
    }
    if (withDeleted) return where;
    const live = { [softDelete.field]: { $eq: null } };
    if (Object.keys(where).length === 0) return live;
    return { $and: [where, live] };
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

  private async byId(
    id: EntityId,
    context: KavoContext<Entity>,
    withDeleted: boolean,
  ): Promise<Record<string, unknown> | null> {
    const where = this.scopeToLive({ [this.idField]: { $eq: id } }, context, withDeleted);
    const row = await this.model.findOne(where, null, { lean: true });
    // Left as raw document data: the callers below only test the
    // delete-marker field, and anything returned to core goes through
    // `toPlainResult` at that point instead.
    return (row as Record<string, unknown> | null) ?? null;
  }

  // ── Writes ───────────────────────────────────────────────────────────

  async create(data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const created = await this.model.create(data as Record<string, unknown>);
      return toPlainResult(created) as Entity;
    } catch (error) {
      throw this.mapError(error, context);
    }
  }

  async update(id: EntityId, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    return this.writeExisting(id, data, context);
  }

  async patch(id: EntityId, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    return this.writeExisting(id, data, context);
  }

  /**
   * `update` and `patch` share one primitive: the *shape* of `data` differs
   * (full body vs. sparse) because the DTO layer differs, not the
   * persistence mechanics — the same split `@kavo/prisma` makes.
   *
   * The write is a single `findOneAndUpdate` against the **live** scope, so
   * a soft-deleted document is invisible to writes exactly as it is to
   * reads (reviving one is `restore`'s job), and a missing document is
   * reported without a separate existence check — no read-then-write gap
   * for a concurrent delete to slip through.
   */
  private async writeExisting(id: EntityId, rawData: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const where = this.scopeToLive({ [this.idField]: { $eq: id } }, context, false);
      // Defence in depth, mirroring the deserializer's own exclusion: even
      // an explicit write DTO that legitimately names the id (to assign a
      // natural key on `create`) must not be allowed to reassign an
      // *existing* document's identity, and the soft-delete marker is
      // `deleteOne`/`restoreOne`'s state machine to change, not an
      // ordinary path an update/patch body happens to include.
      const softDeleteField = context.config.softDelete.field;
      const changes = { ...(rawData as Record<string, unknown>) };
      delete changes[this.idField];
      if (softDeleteField !== null) delete changes[softDeleteField];
      if (Object.keys(changes).length === 0) {
        // MongoDB rejects an empty `$set`. Nothing to write is not an
        // error — it is the current document, unchanged.
        const existing = await this.byId(id, context, false);
        if (existing === null) throw this.notFound(id, context);
        return toPlainDocument(existing) as Entity;
      }
      // `runValidators` is off by default on every Mongoose update — only
      // `create` validates. Without it an entity's own schema constraints
      // (`enum`, `min`, `required`, custom validators) hold on POST and are
      // silently ignored on PUT/PATCH, so the same body is rejected on
      // create and accepted on update, and the collection fills with
      // documents that violate the schema it declares.
      const updated = await this.model.findOneAndUpdate(
        where,
        { $set: changes },
        { new: true, lean: true, runValidators: true },
      );
      if (updated === null || updated === undefined) throw this.notFound(id, context);
      return toPlainResult(updated) as Entity;
    } catch (error) {
      throw this.mapError(error, context, true);
    }
  }

  async delete(id: EntityId, context: KavoContext<Entity>): Promise<void> {
    const softDelete = context.config.softDelete;
    try {
      if (softDelete.strategy === "hard") {
        const existing = await this.byId(id, context, false);
        if (existing === null) throw this.notFound(id, context);
        await this.model.deleteOne({ [this.idField]: { $eq: id } });
        return;
      }
      const { field } = softDelete;
      // The write repeats the "still live" predicate the read established,
      // so the transition is atomic: two concurrent deletes cannot both
      // succeed, and the stored timestamp is the first one's, not the
      // last writer's. The read still happens, because "already deleted"
      // (409) and "never existed" (404) are different answers and only the
      // stored marker tells them apart — but it no longer *decides* the
      // write, it only explains a write that matched nothing.
      const updated = await this.model.findOneAndUpdate(
        { [this.idField]: { $eq: id }, [field]: { $eq: null } },
        { $set: { [field]: new Date() } },
        { lean: true },
      );
      if (updated === null || updated === undefined) {
        const existing = await this.byId(id, context, true);
        if (existing === null) throw this.notFound(id, context);
        throw new AlreadyDeletedException({
          messageParams: { entity: context.entityName, id: String(id) },
          context: errorContext(context),
        });
      }
    } catch (error) {
      throw this.mapError(error, context, true);
    }
  }

  async restore(id: EntityId, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const { field } = this.requireSoftDelete(context, "restore");
      // Same atomic shape as `delete`, mirrored: only a document that is
      // actually deleted may be restored, so the predicate is part of the
      // write rather than a check that precedes it.
      const restored = await this.model.findOneAndUpdate(
        { [this.idField]: { $eq: id }, [field]: { $ne: null } },
        { $set: { [field]: null } },
        { new: true, lean: true },
      );
      if (restored === null || restored === undefined) {
        const existing = await this.byId(id, context, true);
        if (existing === null) throw this.notFound(id, context);
        throw new NotDeletedException({
          messageParams: { entity: context.entityName, id: String(id) },
          context: errorContext(context),
        });
      }
      return toPlainResult(restored) as Entity;
    } catch (error) {
      throw this.mapError(error, context, true);
    }
  }

  async purge(id: EntityId, context: KavoContext<Entity>): Promise<void> {
    const softDelete = context.config.softDelete;
    try {
      if (softDelete.strategy === "soft") {
        // Purge is the second step of a two-step delete: it removes a
        // document that is already soft-deleted, never a live one.
        const existing = await this.byId(id, context, true);
        if (existing === null) throw this.notFound(id, context);
        if (!this.isDeleted(existing, softDelete.field)) {
          throw new NotDeletedException({
            messageParams: { entity: context.entityName, id: String(id) },
            context: errorContext(context),
          });
        }
      } else {
        const existing = await this.byId(id, context, false);
        if (existing === null) throw this.notFound(id, context);
      }
      await this.model.deleteOne({ [this.idField]: { $eq: id } });
    } catch (error) {
      throw this.mapError(error, context, true);
    }
  }

  /**
   * `addressedById` says whether this operation took an id as its subject
   * — and it is the whole difference between a 404 and a 400 for an
   * unparseable `ObjectId`.
   *
   * `GET /books/not-an-objectid` names a document that cannot exist, so it
   * answers 404 (ADR-0018). But `_id` is on core's default filter
   * allowlist, so `GET /books?filter[_id][eq]=not-an-objectid` raises the
   * *same* `CastError` on the *same* path — and answering 404 there would
   * claim the whole collection endpoint is missing. Only the operations
   * that actually address a document by id opt into the 404 reading;
   * everywhere else a bad id value is a bad query value, which is the 400
   * the other two adapters give.
   */
  private mapError(error: unknown, context: KavoContext<Entity>, addressedById = false) {
    return mapDriverError(error, errorContext(context), addressedById ? this.idField : undefined);
  }

  private notFound(id: EntityId, context: KavoContext<Entity>): NotFoundException {
    return new NotFoundException({
      messageParams: { entity: context.entityName, id: String(id) },
      context: errorContext(context),
    });
  }
}

function errorContext<Entity>(context: KavoContext<Entity>) {
  return {
    entityName: context.entityName,
    operation: context.operation,
    correlationId: context.correlationId,
  };
}
