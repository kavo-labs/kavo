import { IsInt, IsNotEmpty, IsOptional, IsPositive, IsString } from "class-validator";

/**
 * DTO slots for the PetTag route. `petId`/`tagId` are the composite key
 * (ADR-0039) — creatable (the client supplies the natural key on
 * `createOne`) but not part of `Update`/`PatchPetTagDto`, since they are
 * immutable after creation and the composite route id already addresses
 * the row. `note`'s trim-then-validate step lives in `pet-tag.runtime.ts`,
 * the same two-step shape `address.dtos.ts` uses for `postalCode`.
 */

/** `create` slot — request body for POST /pet-tags. */
export class CreatePetTagDto {
  @IsInt()
  @IsPositive()
  petId = 0;

  @IsInt()
  @IsPositive()
  tagId = 0;

  @IsString()
  @IsNotEmpty()
  note = "";
}

/** `update` slot — request body for PUT /pet-tags/:id (patch derives from it). */
export class UpdatePetTagDto {
  @IsString()
  @IsNotEmpty()
  note = "";
}

/**
 * `PATCH /pet-tags/:id`'s own validated shape. See `PatchOwnerDto`
 * (`owner.dtos.ts`) for why this exists as its own class.
 */
export class PatchPetTagDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  note?: string;
}

/** `item` slot — the detail projection. */
export class PetTagItemDto {
  petId = 0;
  tagId = 0;
  note = "";
}

/** `list` slot — same shape as `item`; a pet-tag has nothing left to trim. */
export class PetTagListDto {
  petId = 0;
  tagId = 0;
  note = "";
}
