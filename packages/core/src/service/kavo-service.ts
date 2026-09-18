import type { EntityId } from "../types/entity-id.js";
import type { EntityInput } from "../types/utility.js";
import type { QueryContext } from "../query/query-context.js";
import type { ListResultDto } from "../dto/list-result.js";
import type { SchemaInputOf, SchemaOutputOf, SchemaQueryOf } from "../schema/entity-schema.js";
import type { KavoCallOptions } from "./kavo-call-options.js";
import type {
  CustomOperationBody,
  CustomOperationId,
  CustomOperationRequest,
  CustomOperationResult,
} from "./custom-operation.js";

/**
 * The primary programmatic surface — what `createCrud(Entity, config)`
 * returns and what generated NestJS routes delegate to.
 *
 * Every generic parameter defaults from `Entity`, so the zero-config path
 * needs no manual arguments (see the generic-parameter table in
 * `docs/internals/architecture/03-core-contracts-and-type-system.md`).
 * Registered DTO classes narrow the corresponding slot.
 *
 * `Ops` is `EntityConfig`'s inferred `operations` literal (issue #131): each
 * method position reads it through `SchemaInputOf`/`SchemaOutputOf`/`SchemaQueryOf`
 * (`entity-schema.ts`), which fall back to the entity-wide generic above when that
 * operation declares no override — so `findOne`'s response can be typed
 * differently from `createOne`'s even though both default to `ItemDto`.
 *
 * Single-item only. The spec makes batch operations optional and says to
 * drop them when a build does not want them; this build does not, so the
 * `*Many` surface is absent rather than present-but-throwing.
 *
 * A **custom** operation (issue #145) has no named method here — Kavo does
 * not know its name — and reaches the same pipeline through `run`.
 */
export interface KavoService<
  Entity,
  Id extends EntityId = EntityId,
  CreateDto = EntityInput<Entity>,
  UpdateDto = EntityInput<Entity>,
  PatchDto = Partial<UpdateDto>,
  QueryDto = QueryContext<Entity>,
  ItemDto = Entity,
  ListDto = ItemDto,
  Ops = unknown,
> {
  createOne(
    data: SchemaInputOf<Ops, "createOne", CreateDto>,
    options?: KavoCallOptions,
  ): Promise<SchemaOutputOf<Ops, "createOne", ItemDto>>;

  findOne(
    id: Id,
    query?: SchemaQueryOf<Ops, "findOne", QueryDto>,
    options?: KavoCallOptions,
  ): Promise<SchemaOutputOf<Ops, "findOne", ItemDto>>;
  findMany(
    query?: SchemaQueryOf<Ops, "findMany", QueryDto>,
    options?: KavoCallOptions,
  ): Promise<ListResultDto<SchemaOutputOf<Ops, "findMany", ListDto>>>;

  updateOne(
    id: Id,
    data: SchemaInputOf<Ops, "updateOne", UpdateDto>,
    options?: KavoCallOptions,
  ): Promise<SchemaOutputOf<Ops, "updateOne", ItemDto>>;

  patchOne(
    id: Id,
    data: SchemaInputOf<Ops, "patchOne", PatchDto>,
    options?: KavoCallOptions,
  ): Promise<SchemaOutputOf<Ops, "patchOne", ItemDto>>;

  /** Hard or soft per the resolved delete strategy. */
  deleteOne(id: Id, options?: KavoCallOptions): Promise<void>;

  /**
   * Un-deletes a soft-deleted row. Reuses the `item` schema slot by default
   * — no dedicated restore shape — but `operations.restoreOne.schema.output`
   * still narrows it independently (issue #131). Enabled when the entity
   * config declares soft delete.
   */
  restoreOne(id: Id, options?: KavoCallOptions): Promise<SchemaOutputOf<Ops, "restoreOne", ItemDto>>;

  /**
   * Permanently removes a soft-deleted row; disabled by default, enabled
   * with `operations: { purgeOne: true }`.
   */
  purgeOne(id: Id, options?: KavoCallOptions): Promise<void>;

  /**
   * Invoke a **custom** operation by id — one declared under
   * `operations.<id>` with a handler of its own (issue #145). The eight
   * methods above are named because Kavo knows their names; a custom
   * operation is named by the application, so this is the one method that
   * takes the id as an argument.
   *
   * Everything else is identical: same engine, same lifecycle, same
   * envelope. `request` carries whichever of `id`/`body`/`query` the
   * operation uses, and the result is typed from the operation's own
   * `schema` override or, failing that, from its registered handler's
   * signature.
   *
   * Calling an id that is not registered raises
   * `OperationNotRegisteredException`; a registered-but-disabled one
   * raises `OperationDisabledException`, exactly as a standard operation
   * does.
   */
  run<Operation extends CustomOperationId<Ops>>(
    operation: Operation,
    request?: CustomOperationRequest<Id, CustomOperationBody<Ops, Operation>, SchemaQueryOf<Ops, Operation, QueryDto>>,
    options?: KavoCallOptions,
  ): Promise<CustomOperationResult<Ops, Operation>>;
}
