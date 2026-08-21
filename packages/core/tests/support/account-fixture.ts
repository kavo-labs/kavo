import type { KavoContext, EntityId, EntityMetadata, NormalizedQueryContext, RepositoryAdapter } from "@kavo/core";
import { AlreadyDeletedException, NotDeletedException, NotFoundException, hasKeyset } from "@kavo/core";

/**
 * Soft-deletable test entity: a `deletedAt` marker column, plus
 * `softDeleteField` on the metadata — the seam a real ORM fills from its
 * own declaration (`@DeleteDateColumn` in `@kavo/typeorm`).
 */
export class Account {
  id = 0;
  name = "";
  deletedAt: Date | null = null;
}

export const accountMetadata: EntityMetadata<Account> = {
  entity: Account,
  name: "Account",
  idField: "id",
  fields: [
    { name: "id", kind: "number", nullable: false, generated: true },
    { name: "name", kind: "string", nullable: false, generated: false },
    { name: "deletedAt", kind: "date", nullable: true, generated: true },
  ],
  relations: [],
  softDeleteField: "deletedAt",
};

/** The same metadata with the ORM declaration removed. */
export const accountMetadataWithoutMarker: EntityMetadata<Account> = {
  ...accountMetadata,
  fields: accountMetadata.fields.filter((field) => field.name !== "deletedAt"),
  softDeleteField: null,
};

/**
 * The same metadata, but as `@kavo/prisma`/`@kavo/mongoose`/`@kavo/mikroorm`
 * always report it: no `@DeleteDateColumn` equivalent exists, so the marker
 * is an ordinary `generated: false` column and `softDeleteField` is `null` —
 * only the entity-scope `softDelete.field` name resolves it.
 */
export const accountMetadataWithWritableMarker: EntityMetadata<Account> = {
  ...accountMetadata,
  fields: accountMetadata.fields.map((field) => (field.name === "deletedAt" ? { ...field, generated: false } : field)),
  softDeleteField: null,
};

/** The same metadata, but with an app-assigned (non-generated) primary key. */
export const accountMetadataWithNaturalKey: EntityMetadata<Account> = {
  ...accountMetadata,
  fields: accountMetadata.fields.map((field) => (field.name === "id" ? { ...field, generated: false } : field)),
};

/**
 * A second candidate marker column (`archivedAt`), alongside the usual
 * `deletedAt` — both ordinary `generated: false` columns, `softDeleteField`
 * unset. Exists to prove `softDelete.field` is excluded at the scope it is
 * actually *resolved* at (entity, operation, or per-call — ADR-0013), not a
 * value fixed once when the deserializer was built: an entity-scope default
 * of `deletedAt` with a per-operation override renaming the marker to
 * `archivedAt` must still exclude `archivedAt`, not the stale entity-scope
 * name.
 */
export const accountMetadataWithTwoMarkerCandidates: EntityMetadata<Account> = {
  ...accountMetadataWithWritableMarker,
  fields: [
    ...accountMetadataWithWritableMarker.fields,
    { name: "archivedAt", kind: "date", nullable: true, generated: false },
  ],
};

/**
 * In-memory adapter that honors the resolved strategy the same way a real
 * one does: it reads `context.config.softDelete` rather than deciding for
 * itself, so these tests exercise the engine's resolution, not a mock's
 * opinion.
 */
export class InMemoryAccountAdapter implements RepositoryAdapter<Account> {
  rows: Account[] = [];
  private nextId = 1;

  async findOneById(
    id: EntityId,
    query: NormalizedQueryContext<Account> | null,
    context: KavoContext<Account>,
  ): Promise<Account | null> {
    const row = this.rows.find((candidate) => candidate.id === Number(id)) ?? null;
    if (row === null) return null;
    return this.visible(row, context, query?.withDeleted ?? false, query?.onlyDeleted ?? false) ? row : null;
  }

  async findOne(query: NormalizedQueryContext<Account>, context: KavoContext<Account>): Promise<Account | null> {
    return (await this.findMany(query, context))[0] ?? null;
  }

  async findMany(query: NormalizedQueryContext<Account>, context: KavoContext<Account>): Promise<readonly Account[]> {
    const visible = this.rows.filter((row) => this.visible(row, context, query.withDeleted, query.onlyDeleted));
    const { limit } = query.pagination;
    // Offset-only fixture: narrow rather than assume (ADR-0021, ADR-0022).
    const offset = hasKeyset(query.pagination) ? 0 : query.pagination.offset;
    return visible.slice(offset, offset + limit);
  }

  async count(query: NormalizedQueryContext<Account>, context: KavoContext<Account>): Promise<number> {
    return this.rows.filter((row) => this.visible(row, context, query.withDeleted, query.onlyDeleted)).length;
  }

  async create(data: Partial<Account>): Promise<Account> {
    const row = { ...new Account(), ...data, id: this.nextId++ };
    this.rows.push(row);
    return row;
  }

  async update(id: EntityId, data: Partial<Account>, context: KavoContext<Account>): Promise<Account> {
    const row = await this.requireLive(id, context);
    Object.assign(row, data);
    return row;
  }

  async patch(id: EntityId, data: Partial<Account>, context: KavoContext<Account>): Promise<Account> {
    return this.update(id, data, context);
  }

  async delete(id: EntityId, context: KavoContext<Account>): Promise<void> {
    const softDelete = context.config.softDelete;
    const row = this.require(id, context);
    if (softDelete.strategy === "hard") {
      this.rows = this.rows.filter((candidate) => candidate.id !== Number(id));
      return;
    }
    if (row.deletedAt !== null) {
      throw new AlreadyDeletedException({
        messageParams: { entity: "Account", id: String(id) },
      });
    }
    row.deletedAt = new Date();
  }

  async restore(id: EntityId, context: KavoContext<Account>): Promise<Account> {
    const row = this.require(id, context);
    if (row.deletedAt === null) {
      throw new NotDeletedException({
        messageParams: { entity: "Account", id: String(id) },
      });
    }
    row.deletedAt = null;
    return row;
  }

  async purge(id: EntityId, context: KavoContext<Account>): Promise<void> {
    const row = this.require(id, context);
    if (context.config.softDelete.strategy === "soft" && row.deletedAt === null) {
      throw new NotDeletedException({
        messageParams: { entity: "Account", id: String(id) },
      });
    }
    this.rows = this.rows.filter((candidate) => candidate.id !== Number(id));
  }

  private visible(row: Account, context: KavoContext<Account>, withDeleted: boolean, onlyDeleted = false): boolean {
    if (context.config.softDelete.strategy !== "soft") return true;
    if (onlyDeleted) return row.deletedAt !== null;
    return withDeleted || row.deletedAt === null;
  }

  private require(id: EntityId, context: KavoContext<Account>): Account {
    const row = this.rows.find((candidate) => candidate.id === Number(id));
    if (row === undefined) {
      throw new NotFoundException({
        messageParams: { entity: context.entityName, id: String(id) },
      });
    }
    return row;
  }

  private async requireLive(id: EntityId, context: KavoContext<Account>): Promise<Account> {
    const row = this.require(id, context);
    if (!this.visible(row, context, false)) {
      throw new NotFoundException({
        messageParams: { entity: context.entityName, id: String(id) },
      });
    }
    return row;
  }
}
