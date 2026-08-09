import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Owner } from "./owner.entity.js";
import { CreateOwnerDto, UpdateOwnerDto, OwnerItemDto, OwnerListDto } from "./owner.dtos.js";

/**
 * CRUD over the relation side. The unique `email` column is what surfaces a
 * database unique-violation as an RFC 9457 409 conflict.
 *
 * Relations: `GET /owners?include=pets` embeds each owner's
 * pets, projected through the Pet entity's own shape.
 *
 * Soft delete: declaring `strategy: "soft"` is what puts
 * `PATCH /owners/:id/restore` on the router — route generation runs before
 * any ORM metadata exists, so the config, not the entity, is what it can
 * read (ADR-0013). `purgeOne` is off by default everywhere; asked for by
 * name it adds `DELETE /owners/:id/purge`. `restoreOne: true` here is
 * explicit rather than relying on the soft-delete auto-enable, because
 * `AppModule` sets a global `defaults.operations.restoreOne: false`
 * (issue #38) — this entity opts back in, which is the whole point of the
 * precedence chain: entity config always wins over the global default.
 *
 * Realtime: every standard write publishes to whatever transports
 * `AppModule.forRoot`'s second argument registers — `main.ts` wires
 * `@kavo/sse`, so `GET /realtime?channel=Owner.<id>` or
 * `?channel=Owner` (every owner, issue #160's collection channel) streams
 * these events over `text/event-stream`.
 */
@Kavo(Owner, {
  dto: {
    create: CreateOwnerDto,
    update: UpdateOwnerDto,
    item: OwnerItemDto,
    list: OwnerListDto,
  },
  realtime: { enabled: true, events: {} },
  softDelete: { strategy: "soft" },
  // `deletedAt` is soft-delete plumbing (`@DeleteDateColumn`), not data a
  // client should ever filter, sort, or select on — `{ exclude }` resolves
  // to every own column except this one, without hand-enumerating the rest.
  allowlists: {
    filterable: { exclude: ["deletedAt"] },
    sortable: { exclude: ["deletedAt"] },
    selectable: { exclude: ["deletedAt"] },
  },
  // `include=pets` — opt-in per relation. Pets are a to-many,
  // so they batch-load: one extra query per page of owners, never a joined
  // row explosion under pagination. `address` is the to-one counterpart —
  // it joins instead.
  relations: { edges: { pets: { includable: true }, address: { includable: true } } },
  operations: {
    purgeOne: true,
    restoreOne: true,
  },
})
@Controller("owners")
export class OwnerController {}
