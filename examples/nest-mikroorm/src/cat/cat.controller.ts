import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Cat } from "./cat.entity.js";
import { CreateCatDto, UpdateCatDto, CatItemDto, CatListDto } from "./cat.dtos.js";

/**
 * CRUD over the concrete `Cat` subtype: one decorator, zero methods.
 * Binding `@Kavo` to the child (never the abstract `Pet` base) is what lets
 * MikroORM write the `species` discriminator from the subtype on insert.
 * Routes: POST /cats, GET /cats, GET/PUT/DELETE /cats/:id (PATCH disabled).
 *
 * `include=owner` embeds the owner; `owner` is also writable by id
 * (`{"owner": 1}` on create — ADR-0014). `include=tags` embeds the cat's
 * tags across the many-to-many pivot; `tags` is likewise writable by an
 * array of ids.
 */
@Kavo(Cat, {
  dto: {
    create: CreateCatDto,
    update: UpdateCatDto,
    item: CatItemDto,
    list: CatListDto,
  },
  pagination: { defaultLimit: 10, maxLimit: 50 },
  // Explicit include-lists (the plain form, contrast Owner's `{ exclude }`):
  // `indoor`, `livesLeft`, and `createdAt` are still returned in every
  // response (`CatItemDto` includes them), just not queryable — narrower
  // than "every own column" without excluding anything by name.
  allowed: {
    filterable: ["id", "name", "age", "size", "owner.name"],
    sortable: ["id", "name", "age", "owner.name"],
    selectable: ["id", "name", "age", "size"],
    includable: ["owner", "tags"],
  },
  operations: {
    createOne: true,
    findOne: true,
    findMany: true,
    updateOne: true,
    deleteOne: true,
    // patchOne is deliberately not named here, so it stays off.
  },
})
@Controller("cats")
export class CatController {}
