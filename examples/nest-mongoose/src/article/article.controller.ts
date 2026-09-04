import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Article } from "./article.model.js";
import { CreateArticleDto, UpdateArticleDto, ArticleItemDto, ArticleListDto } from "./article.dtos.js";

/**
 * CRUD over a Mongoose model: one decorator, zero methods — identical in
 * shape to `CatController`, which is the point. The entity handed to
 * `@Kavo` is the Mongoose model itself (ADR-0018), not a mirror class.
 *
 * Routes: POST /articles, GET /articles, GET/PUT/PATCH/DELETE
 * /articles/:id, plus PATCH /articles/:id/restore and DELETE
 * /articles/:id/purge — the two soft-delete routes appear because
 * `softDelete.field` is *declared* here (ADR-0013: route generation runs at
 * decoration time, where no ORM metadata exists, so config alone decides).
 *
 * `?include=author` embeds the author via `populate`; `author` is also
 * filterable, because a Mongoose `ref` path is the foreign key as well as
 * the relation. Filtering across it (`author.name`) is deliberately
 * refused rather than silently matching nothing — see doc 15 §2.
 */
@Kavo(Article, {
  dto: {
    create: CreateArticleDto,
    update: UpdateArticleDto,
    item: ArticleItemDto,
    list: ArticleListDto,
  },
  softDelete: { field: "deletedAt" },
  operations: {
    createOne: true,
    findOne: true,
    findMany: true,
    updateOne: true,
    patchOne: true,
    deleteOne: true,
    restoreOne: true,
    purgeOne: true,
  },
  pagination: { defaultLimit: 10, maxLimit: 50 },
  allowed: {
    filterable: ["_id", "title", "status", "tags", "author"],
    sortable: ["_id", "title", "createdAt"],
    selectable: ["_id", "title", "status", "tags", "body", "createdAt"],
    includable: ["author"],
  },
})
@Controller("articles")
export class ArticleController {}
