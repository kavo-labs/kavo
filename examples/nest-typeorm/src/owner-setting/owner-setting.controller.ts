import { Controller, Inject } from "@nestjs/common";
import { Kavo, Override, getKavoServiceToken } from "@kavo/nest";
import type { DefaultKavoService, EntityId, RequestPreconditions } from "@kavo/core";
import { OwnerSetting } from "./owner-setting.entity.js";
import {
  CreateOwnerSettingDto,
  UpdateOwnerSettingDto,
  PatchOwnerSettingDto,
  OwnerSettingItemDto,
  OwnerSettingListDto,
} from "./owner-setting.dtos.js";

/**
 * Plain CRUD over the shared-primary-key one-to-one (issue #267):
 * `GET/PUT/PATCH/DELETE /owner-settings/:id` addresses a row by the same
 * id its owning `Owner` uses, since `owner_id` is both this entity's sole
 * primary column and the `@JoinColumn` of its `owner` relation. `createOne`
 * accepts `owner` (association-by-id, ADR-0014), which the adapter writes
 * through that same join column — there is no separate `owner_id` field on
 * any DTO here.
 *
 * Validation: `createOne`/`updateOne`/`patchOne` are `@Override()`'d purely
 * to give their body parameter a concrete, `class-validator`-decorated
 * type — see `owner.controller.ts`'s own validation note for why.
 */
@Kavo(OwnerSetting, {
  dto: {
    create: CreateOwnerSettingDto,
    update: UpdateOwnerSettingDto,
    item: OwnerSettingItemDto,
    list: OwnerSettingListDto,
  },
})
@Controller("owner-settings")
export class OwnerSettingController {
  constructor(@Inject(getKavoServiceToken(OwnerSetting)) private readonly base: DefaultKavoService<OwnerSetting>) {}

  @Override()
  async createOne(dto: CreateOwnerSettingDto): Promise<unknown> {
    return this.base.createOne(dto as never);
  }

  @Override()
  async updateOne(
    id: EntityId,
    dto: UpdateOwnerSettingDto,
    preconditions: RequestPreconditions | null,
  ): Promise<unknown> {
    return this.base.updateOne(id as never, dto as never, { preconditions: preconditions ?? undefined });
  }

  @Override()
  async patchOne(
    id: EntityId,
    dto: PatchOwnerSettingDto,
    preconditions: RequestPreconditions | null,
  ): Promise<unknown> {
    return this.base.patchOne(id as never, dto as never, { preconditions: preconditions ?? undefined });
  }
}
