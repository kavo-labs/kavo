import type {
  KavoContext,
  EntityId,
  EntityMetadata,
  IncludeTree,
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
import { mapDriverError } from "./error-mapping.js";
import { translateFilter, type FilterTranslatorOptions, type PrismaWhere } from "./filter-translator.js";
import { delegateName, type PrismaClientLike, type PrismaModelDelegate } from "./prisma-client-like.js";

/**
 * `RepositoryAdapter` over a Prisma Client model delegate: CRUD with hard
 * *or* soft delete, restore, purge, filtering, sorting, pagination,
 * optional counting.
 *
 * **No join/batch split.** `@kavo/typeorm` translates `IncludeNode.strategy`
 * because it drives a raw SQL query builder, where a to-many `JOIN`
 * multiplies root rows and a separate batched query is how that's avoided.
 * Prisma's `include` has no such failure mode: it always resolves relations
 * as its own internally-batched queries, to-one or to-many alike, never a
 * row-multiplying join — so a to-many include never disturbs root
 * pagination regardless of which strategy core resolved. This adapter
 * therefore ignores the `join`/`batch` distinction and maps those nodes the
 * same way; there is nothing for it to control here. The one strategy it
 * does honor is `key` (issue #364): a `select` of the target's primary key
 * alone, so the edge materializes as `{ <pk>: value }` / `null`.
 */
export class PrismaRepositoryAdapter<Entity extends object> implements RepositoryAdapter<Entity> {
  private readonly delegate: PrismaModelDelegate;
  private readonly idField: string;
  private readonly filterOptions: FilterTranslatorOptions;

  constructor(
    private readonly prismaClient: PrismaClientLike,
    private readonly metadata: EntityMetadata<Entity>,
    // `model` is not the caller's to supply — it is the entity this adapter
    // already describes, and a mismatched one would nest relation paths
    // against the wrong model's edges.
    filterOptions: Omit<FilterTranslatorOptions, "model">,
  ) {
    this.filterOptions = { ...filterOptions, model: metadata.name };
    const name = delegateName(metadata.name);
    const delegate = prismaClient[name];
    if (delegate === undefined) {
      throw new ConfigurationException(
        metadata.name,
        "entity",
        `Prisma Client has no '${name}' delegate for model '${metadata.name}'`,
      );
    }
    this.delegate = delegate;
    this.idField = metadata.idField;
  }

  // ── Reads ────────────────────────────────────────────────────────────

  async findOneById(
    id: EntityId,
    query: NormalizedQueryContext<Entity> | null,
    context: KavoContext<Entity>,
  ): Promise<Entity | null> {
    try {
      const where = this.scopeToLive(
        { [this.idField]: id },
        context,
        query?.withDeleted ?? false,
        query?.onlyDeleted ?? false,
      );
      const include = this.buildInclude(query?.include ?? {});
      const row = await this.delegate.findFirst({ where, ...(include && { include }) });
      return (row as Entity | null) ?? null;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async findOne(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<Entity | null> {
    try {
      const row = await this.delegate.findFirst(this.buildFindArgs(query, context));
      return (row as Entity | null) ?? null;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async findMany(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<readonly Entity[]> {
    try {
      // `readFilter` folds in the keyset predicate under cursor pagination
      // (a no-op otherwise), and a cursor page has no `offset` to skip by —
      // the keyset predicate *is* the skip. Prisma's own `cursor`/`skip: 1`
      // option is deliberately not used: it takes a unique *id* and cannot
      // express a multi-column keyset with mixed directions.
      const { pagination } = query;
      const rows = await this.delegate.findMany({
        ...this.buildFindArgs(query, context, readFilter(query)),
        skip: hasKeyset(pagination) ? 0 : pagination.offset,
        take: pagination.limit,
      });
      return rows as Entity[];
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async count(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<number> {
    try {
      // A dedicated count — never fetch-then-length: the engine only calls
      // this when `query.count` is true, so `total: null` costs zero queries.
      const where = this.scopeToLive(
        translateFilter(query.filter, this.filterOptions),
        context,
        query.withDeleted,
        query.onlyDeleted,
      );
      return await this.delegate.count({ ...(where && { where }) });
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  private buildFindArgs(
    query: NormalizedQueryContext<Entity>,
    context: KavoContext<Entity>,
    filter: Filter<Entity> = query.filter,
  ): Record<string, unknown> {
    const where = this.scopeToLive(
      translateFilter(filter, this.filterOptions),
      context,
      query.withDeleted,
      query.onlyDeleted,
    );
    const orderBy = query.sort.map((sort) => nestOrderBy(sort.field as string, sort.direction));
    const include = this.buildInclude(query.include);
    return {
      ...(where && { where }),
      ...(orderBy.length > 0 && { orderBy }),
      ...(include && { include }),
    };
  }

  // ── Relation includes ───────────────────────────────────────────────

  /**
   * Translate a validated `IncludeTree` into Prisma's nested `include`
   * clause. Soft-deleted related rows are excluded the same way for a
   * to-one or to-many edge — Prisma accepts a `where` on either — mirroring
   * `@kavo/typeorm`'s exclusion of soft-deleted rows from every include.
   * A root `withDeleted` is the root's own opt-in only; it never widens an
   * included relation (same rule as `@kavo/typeorm`).
   */
  private buildInclude(tree: IncludeTree): Record<string, unknown> | undefined {
    const entries = Object.values(tree);
    if (entries.length === 0) {
      return undefined;
    }
    const include: Record<string, unknown> = {};
    for (const node of entries) {
      if (node.strategy === "key") {
        // `strategy: "key"` (issue #364): the parent's local FK id alone.
        // Prisma returns `{ <pk>: value }` or `null` natively — no join,
        // no soft-delete filter (the FK is the literal reference on the
        // parent row, whatever the target's delete state).
        include[node.relation.name] = { select: { [node.keyField!]: true } };
        continue;
      }
      const where = node.softDelete.strategy === "soft" ? { [node.softDelete.field]: null } : undefined;
      const children = this.buildInclude(node.children);
      if (where === undefined && children === undefined) {
        include[node.relation.name] = true;
      } else {
        include[node.relation.name] = { ...(where && { where }), ...(children && { include: children }) };
      }
    }
    return include;
  }

  // ── Soft delete ──────────────────────────────────────────────────────

  private scopeToLive(
    where: PrismaWhere | undefined,
    context: KavoContext<Entity>,
    withDeleted: boolean,
    onlyDeleted = false,
  ): PrismaWhere | undefined {
    const softDelete = context.config.softDelete;
    if (softDelete.strategy !== "soft") {
      return where;
    }
    if (onlyDeleted) {
      const deleted = { [softDelete.field]: { not: null } };
      return where === undefined ? deleted : { AND: [where, deleted] };
    }
    if (withDeleted) {
      return where;
    }
    const live = { [softDelete.field]: null };
    if (where === undefined) {
      return live;
    }
    return { AND: [where, live] };
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
    const where = this.scopeToLive({ [this.idField]: id }, context, withDeleted);
    return (await this.delegate.findFirst({ where })) as Record<string, unknown> | null;
  }

  // ── Writes ───────────────────────────────────────────────────────────

  async create(data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    try {
      return (await this.delegate.create({ data })) as Entity;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async update(id: EntityId, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    return this.writeExisting(id, data, context);
  }

  async patch(id: EntityId, data: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    this.requirePatchChanges(id, data, context);
    return this.writeExisting(id, data, context);
  }

  /**
   * `patch` (unlike `update`) rejects a body that carries no field changes
   * — checked against the same immutable-key strip `writeExisting` applies,
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
   * update and patch share one primitive: the *shape* of `data` differs
   * (full body vs. sparse) because the DTO layer differs, not the
   * persistence mechanics. A soft-deleted row is invisible to writes,
   * exactly as it is to reads — reviving one is `restore`'s job, so
   * existence is checked against the live scope before the write.
   */
  private async writeExisting(id: EntityId, rawData: Partial<Entity>, context: KavoContext<Entity>): Promise<Entity> {
    try {
      const existing = await this.byId(id, context, false);
      if (existing === null) {
        throw this.notFound(id, context);
      }
      // Defence in depth, mirroring the deserializer's own exclusion: even
      // an explicit write DTO that legitimately names the id (to assign a
      // natural key on `create`) must not be allowed to reassign an
      // *existing* row's identity, and the soft-delete marker is
      // `deleteOne`/`restoreOne`'s state machine to change, not an
      // ordinary column an update/patch body happens to include.
      const softDeleteField = context.config.softDelete.field;
      const data = { ...(rawData as Record<string, unknown>) };
      delete data[this.idField];
      if (softDeleteField !== null) {
        delete data[softDeleteField];
      }
      return (await this.delegate.update({ where: { [this.idField]: id }, data })) as Entity;
    } catch (error) {
      throw mapDriverError(error, errorContext(context));
    }
  }

  async delete(id: EntityId, context: KavoContext<Entity>): Promise<void> {
    const softDelete = context.config.softDelete;
    try {
      if (softDelete.strategy === "hard") {
        const existing = await this.byId(id, context, false);
        if (existing === null) {
          throw this.notFound(id, context);
        }
        await this.delegate.delete({ where: { [this.idField]: id } });
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
      await this.delegate.update({ where: { [this.idField]: id }, data: { [field]: new Date() } });
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
      return (await this.delegate.update({ where: { [this.idField]: id }, data: { [field]: null } })) as Entity;
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
      } else {
        const existing = await this.byId(id, context, false);
        if (existing === null) {
          throw this.notFound(id, context);
        }
      }
      await this.delegate.delete({ where: { [this.idField]: id } });
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

function nestOrderBy(field: string, direction: "asc" | "desc"): Record<string, unknown> {
  const segments = field.split(".");
  return segments.reduceRight<Record<string, unknown>>(
    (inner, segment, index) => ({ [segment]: index === segments.length - 1 ? direction : inner }),
    {},
  );
}

function errorContext<Entity>(context: KavoContext<Entity>) {
  return {
    entityName: context.entityName,
    operation: context.operation,
    correlationId: context.correlationId,
  };
}
