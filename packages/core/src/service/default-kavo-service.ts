import type { KavoCallOptions } from "./kavo-call-options.js";
import type { KavoRequest } from "../context/kavo-request.js";
import type { KavoService } from "./kavo-service.js";
import type { EntityId } from "../types/entity-id.js";
import type { EntityInput } from "../types/utility.js";
import type { ListResultDto } from "../dto/list-result.js";
import type { OperationId } from "../operations/operation.js";
import type { QueryContext } from "../query/query-context.js";
import type { DtoInputOf, DtoOutputOf, DtoQueryOf } from "../dto/dto.js";
import type {
  CustomOperationBody,
  CustomOperationId,
  CustomOperationRequest,
  CustomOperationResult,
} from "./custom-operation.js";
import { KavoEngine } from "../engine/kavo-engine.js";

/**
 * The programmatic surface bound to one entity's engine — what
 * `createCrud` returns. Methods are sugar over the engine's transport-
 * agnostic `KavoRequest`/`KavoResponse` envelopes; generated NestJS routes
 * delegate to the same engine, so both paths run the identical pipeline.
 *
 * Soft-delete operations (restore, purge) dispatch like everything else;
 * their registry entries are enabled from config, so calling one on an
 * entity that does not declare soft delete raises
 * `OperationDisabledException`.
 */
export class DefaultKavoService<
  Entity extends object,
  Id extends EntityId = EntityId,
  CreateDto = EntityInput<Entity>,
  UpdateDto = EntityInput<Entity>,
  PatchDto = Partial<UpdateDto>,
  QueryDto = QueryContext<Entity>,
  ItemDto = Entity,
  ListDto = ItemDto,
  Ops = unknown,
> implements KavoService<Entity, Id, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto, Ops> {
  constructor(readonly engine: KavoEngine<Entity>) {}

  private request(partial: Partial<KavoRequest<Entity>> & { operation: OperationId }): KavoRequest<Entity> {
    return {
      id: null,
      body: null,
      query: null,
      options: null,
      ...partial,
    } as KavoRequest<Entity>;
  }

  async createOne(
    data: DtoInputOf<Ops, "createOne", CreateDto>,
    options?: KavoCallOptions,
  ): Promise<DtoOutputOf<Ops, "createOne", ItemDto>> {
    const response = await this.engine.execute(
      this.request({
        operation: "createOne",
        body: data as never,
        options: options ?? null,
      }),
    );
    return response.item as DtoOutputOf<Ops, "createOne", ItemDto>;
  }

  async findOne(
    id: Id,
    query?: DtoQueryOf<Ops, "findOne", QueryDto>,
    options?: KavoCallOptions,
  ): Promise<DtoOutputOf<Ops, "findOne", ItemDto>> {
    const response = await this.engine.execute(
      this.request({
        operation: "findOne",
        id,
        query: (query ?? null) as never,
        options: options ?? null,
      }),
    );
    return response.item as DtoOutputOf<Ops, "findOne", ItemDto>;
  }

  async findMany(
    query?: DtoQueryOf<Ops, "findMany", QueryDto>,
    options?: KavoCallOptions,
  ): Promise<ListResultDto<DtoOutputOf<Ops, "findMany", ListDto>>> {
    const response = await this.engine.execute(
      this.request({
        operation: "findMany",
        query: (query ?? null) as never,
        options: options ?? null,
      }),
    );
    return response.list as ListResultDto<DtoOutputOf<Ops, "findMany", ListDto>>;
  }

  async updateOne(
    id: Id,
    data: DtoInputOf<Ops, "updateOne", UpdateDto>,
    options?: KavoCallOptions,
  ): Promise<DtoOutputOf<Ops, "updateOne", ItemDto>> {
    const response = await this.engine.execute(
      this.request({
        operation: "updateOne",
        id,
        body: data as never,
        options: options ?? null,
      }),
    );
    return response.item as DtoOutputOf<Ops, "updateOne", ItemDto>;
  }

  async patchOne(
    id: Id,
    data: DtoInputOf<Ops, "patchOne", PatchDto>,
    options?: KavoCallOptions,
  ): Promise<DtoOutputOf<Ops, "patchOne", ItemDto>> {
    const response = await this.engine.execute(
      this.request({
        operation: "patchOne",
        id,
        body: data as never,
        options: options ?? null,
      }),
    );
    return response.item as DtoOutputOf<Ops, "patchOne", ItemDto>;
  }

  async deleteOne(id: Id, options?: KavoCallOptions): Promise<void> {
    await this.engine.execute(this.request({ operation: "deleteOne", id, options: options ?? null }));
  }

  async restoreOne(id: Id, options?: KavoCallOptions): Promise<DtoOutputOf<Ops, "restoreOne", ItemDto>> {
    const response = await this.engine.execute(this.request({ operation: "restoreOne", id, options: options ?? null }));
    return response.item as DtoOutputOf<Ops, "restoreOne", ItemDto>;
  }

  async purgeOne(id: Id, options?: KavoCallOptions): Promise<void> {
    await this.engine.execute(this.request({ operation: "purgeOne", id, options: options ?? null }));
  }

  /**
   * Custom-operation dispatch (issue #145). The only method that names its
   * operation at the call site, because the application named it.
   *
   * The result comes off whichever envelope half `mapResponse` filled —
   * `list` for a `cardinality: "many"` operation, `item` otherwise, and
   * `null` for a void one. `??` reads the two in that order rather than
   * branching on the descriptor: exactly one is ever non-null, so the
   * fallback is a read of the filled half, not a guess between them.
   */
  async run<Operation extends CustomOperationId<Ops>>(
    operation: Operation,
    request?: CustomOperationRequest<Id, CustomOperationBody<Ops, Operation>, DtoQueryOf<Ops, Operation, QueryDto>>,
    options?: KavoCallOptions,
  ): Promise<CustomOperationResult<Ops, Operation>> {
    const response = await this.engine.execute(
      this.request({
        operation,
        id: (request?.id ?? null) as never,
        body: (request?.body ?? null) as never,
        query: (request?.query ?? null) as never,
        options: options ?? null,
      }),
    );
    return (response.list ?? response.item) as CustomOperationResult<Ops, Operation>;
  }
}
