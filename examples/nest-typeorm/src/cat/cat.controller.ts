import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Cat } from "./cat.entity.js";
import { CreateCatDto, UpdateCatDto, CatItemDto, CatListDto } from "./cat.dtos.js";

/**
 * CRUD over the concrete `Cat` subtype: one decorator, zero methods.
 * Binding `@Kavo` to the child (never the abstract `Pet` base) lets the
 * child repository auto-write the `species` discriminator on create.
 * Routes: POST /cats, GET /cats, GET/PUT/DELETE /cats/:id (PATCH disabled).
 * `include=owner` embeds the owner; `owner` is also writable by id
 * (`{"owner": 1}` on create — ADR-0014). `include=tags` embeds the cat's
 * tags (a many-to-many, batch-loaded like any other to-many); `tags` is
 * likewise writable by an array of ids.
 */
@Kavo(Cat, {
  dto: {
    create: CreateCatDto,
    update: UpdateCatDto,
    item: CatItemDto,
    list: CatListDto,
  },
  pagination: { defaultLimit: 10, maxLimit: 50 },
  // Explicit include-lists (the plain form, contrast Owner's `{ exclude }`
  // in owner.controller.ts): `indoor`, `livesLeft`, and `createdAt` are
  // still returned in every response (`CatItemDto` includes them), just
  // not queryable — narrower than "every own column" without excluding
  // anything by name.
  allowlists: {
    filterable: ["id", "name", "age", "size"],
    sortable: ["id", "name", "age"],
    selectable: ["id", "name", "age", "size"],
    includable: ["owner", "tags"],
  },
  // The to-one side of the owner edge joins; `tags` is a to-many (many-to-
  // many) and batches, both `auto`'s default — no `relations.edges` tuning
  // needed. `fields[owner]=id,name` / `fields[tags]=id,name` narrow each
  // embedded relation.
  operations: {
    patchOne: false,
  },
})
@Controller("cats")
export class CatController {}
