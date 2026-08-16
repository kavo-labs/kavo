import { Controller, Inject } from "@nestjs/common";
import { Kavo, Override, getKavoServiceToken } from "@kavo/nest";
import type { DefaultKavoService, EntityId, RequestPreconditions } from "@kavo/core";
import { Tag } from "./tag.entity.js";
import { CreateTagDto, UpdateTagDto, PatchTagDto, TagItemDto, TagListDto } from "./tag.dtos.js";

/**
 * Plain CRUD over `Tag`, the many-to-many side pets associate by id
 * (`include=tags` on `/cats`). A small lookup table, and the example's
 * demonstration of `pagination.strategy: "none"` (issue #225): `GET /tags`
 * always serves every tag, never a `defaultLimit`-sized page, and an
 * explicit `?limit=`/`?offset=` is rejected rather than silently narrowed.
 *
 * Validation: `createOne`/`updateOne`/`patchOne` are `@Override()`'d purely
 * to give their body parameter a concrete, `class-validator`-decorated
 * type — see `owner.controller.ts`'s own validation note for why.
 */
@Kavo(Tag, {
  dto: {
    create: CreateTagDto,
    update: UpdateTagDto,
    item: TagItemDto,
    list: TagListDto,
  },
  pagination: { strategy: "none" },
})
@Controller("tags")
export class TagController {
  constructor(@Inject(getKavoServiceToken(Tag)) private readonly base: DefaultKavoService<Tag>) {}

  @Override()
  async createOne(dto: CreateTagDto): Promise<unknown> {
    return this.base.createOne(dto as never);
  }

  @Override()
  async updateOne(id: EntityId, dto: UpdateTagDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    return this.base.updateOne(id as never, dto as never, { preconditions: preconditions ?? undefined });
  }

  @Override()
  async patchOne(id: EntityId, dto: PatchTagDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    return this.base.patchOne(id as never, dto as never, { preconditions: preconditions ?? undefined });
  }
}
