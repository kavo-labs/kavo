import { Controller, Inject } from "@nestjs/common";
import { Kavo, Override, getKavoServiceToken } from "@kavo/nest";
import type { DefaultKavoService, EntityId, RequestPreconditions } from "@kavo/core";
import { Cat } from "./cat.entity.js";
import {
  CREATE_SIZE_DEFAULT,
  CreateCatDto,
  UPDATE_SIZE_DEFAULT,
  UpdateCatDto,
  CatItemDto,
  CatListDto,
} from "./cat.dtos.js";

/**
 * CRUD over the concrete `Cat` subtype: one decorator, zero methods.
 * Binding `@Kavo` to the child (never the abstract `Pet` base) lets the
 * child repository auto-write the `species` discriminator on create.
 * Routes: POST /cats, GET /cats, GET/PUT/DELETE /cats/:id (PATCH disabled),
 * PUT /cats/:id/tags, GET/POST/DELETE/PUT /cats/:id/photos. `include=owner`
 * embeds the owner; `owner` is also writable by id (`{"owner": 1}` on
 * create — ADR-0014). `include=tags`/`include=photos` embed the cat's tags
 * and photos (both many-to-many, batch-loaded like any other to-many);
 * both relations are likewise writable by an array of ids on create/update,
 * and — since both opt into `write` — independently through their own
 * array-mutation routes, each under its **own** strategy (ADR-0029's
 * per-relation amendment, issue #223): `tags` stays `replace` — a single
 * whole-array `PUT /cats/:id/tags`, without touching the rest of the cat —
 * while `photos` opts into `resource` instead, trading that one route for
 * four narrower ones (`list`/`add`/`remove`/`replace`, see below). Two
 * different write strategies, live on the same entity.
 *
 * `GET /cats?search[query]=whiskers` free-text searches `name` (the one
 * field named in `allowlists.searchable`) — `search[mode]=words` and
 * `search[fields]` are also available, narrowed to that same allowlist.
 *
 * Validation: `createOne`/`updateOne` are `@Override()`'d purely to give
 * their body parameter a concrete, `class-validator`-decorated type — see
 * `owner.controller.ts`'s own validation note for why. No `patchOne`
 * override: `operations` below is an exclusive whitelist and `patchOne`
 * is deliberately not named in it, so it's off and there is no route to
 * give a body type to. Each override also strips
 * `size` back off the DTO when it's still `cat.dtos.ts`'s own sentinel
 * default — that marker object only exists for Swagger's benefit
 * (`cat.dtos.ts`'s own comment) and is never a real `PetSizeEnum` value the
 * engine should try to persist.
 */
@Kavo(Cat, {
  dto: {
    create: CreateCatDto,
    update: UpdateCatDto,
    item: CatItemDto,
    list: CatListDto,
  },
  // No built-in default (issue #221 amends ADR-0029) — `tags.write` below
  // demands an explicit strategy. This is the entity's own default, which
  // `tags` inherits via `write: true`; `photos` below pins its own
  // strategy instead, overriding it (issue #223).
  arrayMutation: { strategy: "replace" },
  pagination: { defaultLimit: 10, maxLimit: 50 },
  query: { search: { enabled: true } },
  // Explicit include-lists (the plain form, contrast Owner's `{ exclude }`
  // in owner.controller.ts): `indoor`, `livesLeft`, and `createdAt` are
  // still returned in every response (`CatItemDto` includes them), just
  // not queryable — narrower than "every own column" without excluding
  // anything by name.
  allowlists: {
    filterable: ["id", "name", "age", "size"],
    sortable: ["id", "name", "age"],
    selectable: ["id", "name", "age", "size"],
    includable: ["owner", "tags", "photos"],
    // Search is opt-in per entity (`query.search.enabled` above).
    // `name` is Cat's only own string-kind column, so this is the same set
    // the zero-config default would resolve to — named explicitly here for
    // the reference app to point at.
    searchable: ["name"],
  },
  // The to-one side of the owner edge joins; `tags`/`photos` are to-many
  // (many-to-many) and batch, both `auto`'s default — no loading tuning
  // needed. `fields[owner]=id,name` / `fields[tags]=id,name` /
  // `fields[photos]=id,url` narrow each embedded relation. `tags.write`
  // opts that edge into array-mutation writes, inheriting the entity's own
  // `arrayMutation.strategy: "replace"` declared above: `PUT /cats/:id/tags`
  // replaces the full tag set in one call, without sending the rest of the
  // cat's body. `photos.write` opts the second edge in too, but pins its
  // own `resource` strategy (issue #223) instead of inheriting `replace` —
  // `GET/POST/DELETE/PUT /cats/:id/photos` give it the narrower
  // list/add/remove/replace surface instead of one whole-array `PUT`.
  relations: {
    edges: { tags: { write: true }, photos: { write: { strategy: "resource" } } },
  },
  operations: {
    createOne: {},
    findOne: {},
    findMany: {},
    updateOne: {},
    deleteOne: {},
    // patchOne is deliberately not named here, so it stays off.
  },
})
@Controller("cats")
export class CatController {
  constructor(@Inject(getKavoServiceToken(Cat)) private readonly base: DefaultKavoService<Cat>) {}

  @Override()
  async createOne(dto: CreateCatDto): Promise<unknown> {
    const { size, ...rest } = dto;
    const payload = size === CREATE_SIZE_DEFAULT ? rest : { ...rest, size };
    return this.base.createOne(payload as never);
  }

  @Override()
  async updateOne(id: EntityId, dto: UpdateCatDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    const { size, ...rest } = dto;
    const payload = size === UPDATE_SIZE_DEFAULT ? rest : { ...rest, size };
    return this.base.updateOne(id as never, payload as never, { preconditions: preconditions ?? undefined });
  }
}
