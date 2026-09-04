import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Owner } from "./owner.entity.js";
import { CreateOwnerDto, UpdateOwnerDto, OwnerItemDto, OwnerListDto } from "./owner.dtos.js";

/**
 * CRUD over the relation side. The unique `email` column is what surfaces a
 * database unique-violation as an RFC 9457 409 conflict.
 *
 * Soft delete: `softDelete.field` names an ordinary nullable column, because
 * nothing in a MikroORM entity can declare a delete marker (doc 17 §5) —
 * this is the one config line that turns `deletedAt` into the marker *and*
 * puts `PATCH /owners/:id/restore` on the router (ADR-0013: route generation
 * runs before any ORM metadata exists, so config is what it can read).
 * Naming `restoreOne` below is required regardless of the soft-delete
 * auto-enable, because `operations` is an exclusive whitelist here (issue
 * #257) — and it also opts back in from `AppModule`'s global
 * `defaults.operations.restoreOne: false`, since entity config wins over
 * the global default.
 *
 * `deletedAt` is excluded from every allowlist *and* absent from all four
 * DTO slots. Both matter: the allowlists keep it un-queryable, and the write
 * slots keep it un-writable — which the adapter cannot do for us here,
 * since an undeclared marker is an ordinary column that a plain `PATCH`
 * could otherwise stamp behind `deleteOne`'s back (doc 17 §7). With
 * `purgeOne` enabled, that would be a permanent delete.
 */
@Kavo(Owner, {
  dto: {
    create: CreateOwnerDto,
    update: UpdateOwnerDto,
    item: OwnerItemDto,
    list: OwnerListDto,
  },
  softDelete: { field: "deletedAt" },
  allowed: {
    filterable: { exclude: ["deletedAt"] },
    sortable: { exclude: ["deletedAt"] },
    selectable: { exclude: ["deletedAt"] },
    // `include=pets` — opt-in per relation, and a to-many. `address` is the
    // to-one counterpart. Neither disturbs root pagination: MikroORM
    // resolves `populate` with its own queries either way (doc 17 §3).
    includable: ["pets", "address"],
  },
  operations: {
    createOne: true,
    findOne: true,
    findMany: true,
    updateOne: true,
    patchOne: true,
    deleteOne: true,
    purgeOne: true,
    restoreOne: true,
  },
})
@Controller("owners")
export class OwnerController {}
