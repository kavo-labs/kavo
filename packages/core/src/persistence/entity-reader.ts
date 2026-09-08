import type { EntityId } from "../types/entity-id.js";
import type { KavoContext } from "../context/kavo-context.js";
import type { NormalizedQueryContext } from "../query/query-context.js";

/**
 * The read half of a repository adapter. Adapters receive only validated,
 * normalized queries — allowlists and limits were enforced upstream,
 * so a reader translates, it never re-validates.
 *
 * Soft-delete exclusion and include loading are the
 * reader's concern, driven by `query.withDeleted` / `query.include`:
 * soft-deleted rows are excluded from every read unless `withDeleted` is
 * set, and `findOneById` follows the same rule even though it filters by
 * id alone.
 */
export interface EntityReader<Entity = unknown, Id extends EntityId = EntityId> {
  /**
   * `null` when nothing matches — "missing vs. error" is the engine's call.
   *
   * `identifierField`, when passed (ADR-0052), names the scalar column
   * `id` is matched against instead of the entity's primary key — the
   * `identifier` settings key's resolved value. Omitted (the default, and
   * every pre-existing call site) means lookup by the ORM primary key —
   * an adapter reads `identifierField ?? this.idField` (its own stored
   * primary-key column name). An adapter that never supports a non-default
   * value declares so via `RepositoryAdapter.supportsIdentifierField`,
   * checked once at `createCrud` bootstrap — this parameter only ever
   * carries a non-default value for an adapter that opted in.
   */
  findOneById(
    id: Id,
    query: NormalizedQueryContext<Entity> | null,
    context: KavoContext<Entity>,
    identifierField?: string,
  ): Promise<Entity | null>;
  /** First match of the query, or `null`. */
  findOne(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<Entity | null>;
  findMany(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<readonly Entity[]>;
  /**
   * Count of all rows matching the query's filter, ignoring pagination.
   * Only called when `query.count` is `true`.
   */
  count(query: NormalizedQueryContext<Entity>, context: KavoContext<Entity>): Promise<number>;
}
