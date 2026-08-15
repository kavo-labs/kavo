import { enumProp } from "@kavo/nest";
import { PetSizeEnum } from "../pet/pet.entity.js";
import { TagItemDto } from "../tag/tag.dtos.js";
import { PhotoItemDto } from "../photo/photo.dtos.js";

/**
 * DTO slots for the Cat route. Fields are initialized so the
 * classes carry their shape at runtime — that is what lets the default
 * serializer project responses (and Swagger document them) with no
 * decorator machinery. The `species` discriminator is deliberately absent
 * from every slot: it is never client-writable and never echoed.
 */

/** `create` slot — request body for POST /cats. */
export class CreateCatDto {
  name = "";
  age = 0;
  size = enumProp(Object.values(PetSizeEnum), { example: PetSizeEnum.Medium });
  indoor = false;
  livesLeft = 9;
  // Association by id (ADR-0014): send the owner's id, or an
  // `{ id }` reference. Deep nested writes are deliberately out of scope.
  owner: number | null = null;
  // Same mechanism, over a to-many edge: an array of tag ids (or `{ id }`
  // refs) replaces the full set of associated tags.
  tags: number[] = [];
  // Same mechanism again, over `photos` — independently write-opted under
  // the `resource` strategy rather than `tags`'s `replace` (issue #223).
  photos: number[] = [];
}

/** `update` slot — request body for PUT /cats/:id (patch derives from it). */
export class UpdateCatDto {
  name = "";
  age = 0;
  size = enumProp(Object.values(PetSizeEnum), { example: PetSizeEnum.Medium });
  indoor = false;
  livesLeft = 0;
  owner: number | null = null;
  tags: number[] = [];
  photos: number[] = [];
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
  photos: PhotoItemDto[] = [];
}

/** `list` slot — a leaner projection for list responses. */
export class CatListDto {
  id = 0;
  name = "";
  indoor = false;
}
