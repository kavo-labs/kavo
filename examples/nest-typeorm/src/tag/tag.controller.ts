import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Tag } from "./tag.entity.js";
import { CreateTagDto, UpdateTagDto, TagItemDto, TagListDto } from "./tag.dtos.js";

/**
 * Plain CRUD over `Tag`, the many-to-many side pets associate by id
 * (`include=tags` on `/cats`). A small lookup table, and the example's
 * demonstration of `pagination.strategy: "none"` (issue #225): `GET /tags`
 * always serves every tag, never a `defaultLimit`-sized page, and an
 * explicit `?limit=`/`?offset=` is rejected rather than silently narrowed.
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
export class TagController {}
