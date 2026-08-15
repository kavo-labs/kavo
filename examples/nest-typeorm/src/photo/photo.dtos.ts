/**
 * DTO slots for the Photo route. See `cat.dtos.ts` for the rationale behind
 * plain initialized-field classes.
 */

/** `create` slot — request body for POST /photos. */
export class CreatePhotoDto {
  url = "";
}

/** `update` slot — request body for PUT /photos/:id (patch derives from it). */
export class UpdatePhotoDto {
  url = "";
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
