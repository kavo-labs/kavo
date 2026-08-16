import { Controller, Inject } from "@nestjs/common";
import { Kavo, Override, getKavoServiceToken } from "@kavo/nest";
import type { DefaultKavoService, EntityId, RequestPreconditions } from "@kavo/core";
import { Photo } from "./photo.entity.js";
import { CreatePhotoDto, UpdatePhotoDto, PatchPhotoDto, PhotoItemDto, PhotoListDto } from "./photo.dtos.js";

/**
 * Plain CRUD over `Photo`, the many-to-many side pets associate by id
 * (`include=photos` on `/cats`, and `GET/POST/DELETE/PUT /cats/:id/photos`
 * — `arrayMutation`'s `resource` strategy, ADR-0029's resource amendment).
 *
 * Validation: `createOne`/`updateOne`/`patchOne` are `@Override()`'d purely
 * to give their body parameter a concrete, `class-validator`-decorated
 * type — see `owner.controller.ts`'s own validation note for why.
 */
@Kavo(Photo, {
  dto: {
    create: CreatePhotoDto,
    update: UpdatePhotoDto,
    item: PhotoItemDto,
    list: PhotoListDto,
  },
})
@Controller("photos")
export class PhotoController {
  constructor(@Inject(getKavoServiceToken(Photo)) private readonly base: DefaultKavoService<Photo>) {}

  @Override()
  async createOne(dto: CreatePhotoDto): Promise<unknown> {
    return this.base.createOne(dto as never);
  }

  @Override()
  async updateOne(id: EntityId, dto: UpdatePhotoDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    return this.base.updateOne(id as never, dto as never, { preconditions: preconditions ?? undefined });
  }

  @Override()
  async patchOne(id: EntityId, dto: PatchPhotoDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    return this.base.patchOne(id as never, dto as never, { preconditions: preconditions ?? undefined });
  }
}
