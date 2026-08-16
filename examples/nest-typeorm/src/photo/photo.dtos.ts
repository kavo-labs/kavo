import { IsNotEmpty, IsOptional, IsString } from "class-validator";

/**
 * DTO slots for the Photo route. See `cat.dtos.ts` for the rationale behind
 * plain initialized-field classes. `Create`/`Update`/`PatchPhotoDto` carry
 * `class-validator` decorators — see `photo.controller.ts`'s `@Override()`'d
 * write methods for how they get validated. `url` is a non-empty string
 * rather than `@IsUrl()`: this reference app stores whatever string a
 * caller sends (e.g. relative paths), not only absolute URLs.
 */

/** `create` slot — request body for POST /photos. */
export class CreatePhotoDto {
  @IsString()
  @IsNotEmpty()
  url = "";
}

/** `update` slot — request body for PUT /photos/:id (patch derives from it). */
export class UpdatePhotoDto {
  @IsString()
  @IsNotEmpty()
  url = "";
}

/**
 * `PATCH /photos/:id`'s own validated shape. See `PatchOwnerDto`
 * (`owner.dtos.ts`) for why this exists as its own class.
 */
export class PatchPhotoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  url?: string;
}

/** `item` slot — the detail projection. */
export class PhotoItemDto {
  id = 0;
  url = "";
}

/** `list` slot — same shape as `item`; a photo has nothing left to trim. */
export class PhotoListDto {
  id = 0;
  url = "";
}
