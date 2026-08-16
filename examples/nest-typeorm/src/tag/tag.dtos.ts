import { IsNotEmpty, IsOptional, IsString } from "class-validator";

/**
 * DTO slots for the Tag route. See `cat.dtos.ts` for the rationale behind
 * plain initialized-field classes. `Create`/`Update`/`PatchTagDto` carry
 * `class-validator` decorators — see `tag.controller.ts`'s `@Override()`'d
 * write methods for how they get validated.
 */

/** `create` slot — request body for POST /tags. */
export class CreateTagDto {
  @IsString()
  @IsNotEmpty()
  name = "";
}

/** `update` slot — request body for PUT /tags/:id (patch derives from it). */
export class UpdateTagDto {
  @IsString()
  @IsNotEmpty()
  name = "";
}

/**
 * `PATCH /tags/:id`'s own validated shape. See `PatchOwnerDto`
 * (`owner.dtos.ts`) for why this exists as its own class.
 */
export class PatchTagDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;
}

/** `item` slot — the detail projection. */
export class TagItemDto {
  id = 0;
  name = "";
}

/** `list` slot — same shape as `item`; a tag has nothing left to trim. */
export class TagListDto {
  id = 0;
  name = "";
}
