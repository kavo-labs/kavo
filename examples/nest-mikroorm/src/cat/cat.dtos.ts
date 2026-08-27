import { enumProp } from "@kavo/nest";
import { PetSizeEnum } from "../pet/pet.entity.js";
import { TagItemDto } from "../tag/tag.dtos.js";

/**
 * DTO slots for the Cat route. Fields are initialized so the classes carry
 * their shape at runtime — that is what lets the default serializer project
 * responses (and Swagger document them) with no decorator machinery.
 *
 * The `species` discriminator is absent from every slot, as in the TypeORM
 * example — and here it would be absent regardless: MikroORM keeps it as
 * write-only bookkeeping that never hydrates onto an entity, and the adapter
 * reports it generated so no client payload can reach it either.
 */

/** `create` slot — request body for POST /cats. */
export class CreateCatDto {
  name = "";
  age = 0;
  size = enumProp(Object.values(PetSizeEnum), { example: PetSizeEnum.Medium });
  indoor = false;
  livesLeft = 9;
  // Association by id (ADR-0014): send an `{ id }` reference — a bare
  // scalar is rejected (issue #291). Deep nested writes are deliberately
  // out of scope.
  owner: { id: number } | null = null;
  // Same mechanism over a to-many edge: an array of `{ id }` refs replaces
  // the full set of associated tags.
  tags: { id: number }[] = [];
}

/** `update` slot — request body for PUT /cats/:id (patch derives from it). */
export class UpdateCatDto {
  name = "";
  age = 0;
  size = enumProp(Object.values(PetSizeEnum), { example: PetSizeEnum.Medium });
  indoor = false;
  livesLeft = 0;
  owner: { id: number } | null = null;
  tags: { id: number }[] = [];
}

/** `item` slot — the detail projection. */
export class CatItemDto {
  id = 0;
  name = "";
  age = 0;
  size = enumProp(Object.values(PetSizeEnum), { example: PetSizeEnum.Medium });
  indoor = false;
  livesLeft = 0;
  createdAt: Date = new Date(0);
  // Documented as an array of tags; the shape is documentation, the include
  // decides the load — absent from a plain GET.
  tags: TagItemDto[] = [];
}

/** `list` slot — a leaner projection for list responses. */
export class CatListDto {
  id = 0;
  name = "";
  indoor = false;
}
