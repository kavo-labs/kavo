import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Photo } from "./photo.entity.js";
import { CreatePhotoDto, UpdatePhotoDto, PhotoItemDto, PhotoListDto } from "./photo.dtos.js";

/**
 * Plain CRUD over `Photo`, the many-to-many side pets associate by id
 * (`include=photos` on `/cats`, and `GET/POST/DELETE/PUT /cats/:id/photos`
 * — `arrayMutation`'s `resource` strategy, ADR-0029's resource amendment).
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
export class PhotoController {}
