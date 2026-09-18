import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Tag } from "./tag.entity.js";
import { CreateTagDto, UpdateTagDto, TagItemDto, TagListDto } from "./tag.dtos.js";

/**
 * Plain CRUD over `Tag`, the many-to-many side pets associate by id
 * (`include=tags` on `/cats`).
 */
@Kavo(Tag, {
  schema: { input: { create: CreateTagDto, update: UpdateTagDto }, output: { item: TagItemDto, list: TagListDto } },
})
@Controller("tags")
export class TagController {}
