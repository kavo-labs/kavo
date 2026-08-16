import { IsNotEmpty, IsOptional, IsString } from "class-validator";

/**
 * DTO slots for the Address route. Plain initialized-field classes, same
 * rationale as every other entity's DTOs (see cat.dtos.ts).
 *
 * `Create`/`Update`/`PatchAddressDto` carry `class-validator` decorators for
 * shape (non-empty strings); `postalCode`'s specific 5-digit format is a
 * business rule with its own normalization step, so it stays in
 * `address.runtime.ts`'s `assertValidPostalCode`, run from
 * `AddressController`'s write overrides after the generic shape check here
 * passes.
 */

/** `create` slot — request body for POST /addresses. */
export class CreateAddressDto {
  @IsString()
  @IsNotEmpty()
  street = "";

  @IsString()
  @IsNotEmpty()
  city = "";

  @IsString()
  @IsNotEmpty()
  postalCode = "";
}

/** `update` slot — request body for PUT /addresses/:id (patch derives from it). */
export class UpdateAddressDto {
  @IsString()
  @IsNotEmpty()
  street = "";

  @IsString()
  @IsNotEmpty()
  city = "";

  @IsString()
  @IsNotEmpty()
  postalCode = "";
}

/**
 * `PATCH /addresses/:id`'s own validated shape — every field optional. See
 * `PatchOwnerDto` (`owner.dtos.ts`) for why this exists as its own class
 * rather than relying on Kavo's `Partial<update>` default.
 */
export class PatchAddressDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  street?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  city?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  postalCode?: string;
}

/** `item` slot — the detail projection. */
export class AddressItemDto {
  id = 0;
  street = "";
  city = "";
  postalCode = "";
  /** Derived by the `findOne` override — never a persisted column. */
  formattedAddress = "";
}

/** `list` slot — a leaner projection for list responses. */
export class AddressListDto {
  id = 0;
  street = "";
  city = "";
}
