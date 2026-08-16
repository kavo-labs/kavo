import { enumProp, oneOfArray } from "@kavo/nest";
import { IsEmail, IsInt, IsISO8601, IsNotEmpty, IsOptional, IsPositive, IsString } from "class-validator";
import { CatItemDto } from "../cat/cat.dtos.js";
import { AddressItemDto } from "../address/address.dtos.js";
import { PetSizeEnum } from "../pet/pet.entity.js";

/**
 * DTO slots for the Owner route. See `cat.dtos.ts` for the
 * rationale behind plain initialized-field classes.
 *
 * `Create`/`Update`/`PatchOwnerDto` additionally carry `class-validator`
 * decorators — see `owner.controller.ts`'s `@Override()`'d write methods for
 * why a decorated class here is not enough on its own to get validated.
 */

/**
 * Used only for `OwnerItemDto.pets`'s polymorphic union below — `DogController`
 * registers no `dto` block of its own (every `/dogs` slot resolves
 * entity-derived), so this is the one place `Dog`'s item shape needs a
 * concrete DTO class.
 */
export class DogItemDto {
  id = 0;
  name = "";
  age = 0;
  size = enumProp(Object.values(PetSizeEnum), { example: PetSizeEnum.Medium });
  breed = "";
  goodBoy = false;
  attributes: Record<string, unknown> | null = null;
  createdAt: Date = new Date(0);
}

/** `create` slot — request body for POST /owners. */
export class CreateOwnerDto {
  @IsString()
  @IsNotEmpty()
  name = "";

  @IsEmail()
  email = "";

  @IsOptional()
  @IsISO8601()
  startedAt: Date | null = null;

  // Association by id (ADR-0014): send the address's id, or an `{ id }`
  // reference. Deep nested writes are deliberately out of scope.
  @IsOptional()
  @IsInt()
  @IsPositive()
  address: number | null = null;
}

/** `update` slot — request body for PUT /owners/:id (patch derives from it). */
export class UpdateOwnerDto {
  @IsString()
  @IsNotEmpty()
  name = "";

  @IsEmail()
  email = "";

  @IsOptional()
  @IsISO8601()
  startedAt: Date | null = null;

  @IsOptional()
  @IsInt()
  @IsPositive()
  address: number | null = null;
}

/**
 * `PATCH /owners/:id`'s own validated shape — every field optional, unlike
 * `UpdateOwnerDto`'s full-replace requirement. Not a registered `dto.patch`
 * slot (Kavo's own default, `Partial<update>`, already types that); this
 * class exists solely for `OwnerController.patchOne`'s `@Override()` to
 * declare a concrete, `class-validator`-decorated body type.
 */
export class PatchOwnerDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsISO8601()
  startedAt?: Date | null;

  @IsOptional()
  @IsInt()
  @IsPositive()
  address?: number | null;
}

/** `item` slot — the detail projection. */
export class OwnerItemDto {
  id = 0;
  name = "";
  email = "";
  startedAt: Date | null = null;
  createdAt: Date = new Date(0);
  // Documented as a `oneOf` array of pet subtypes. The declaration is the
  // shape, not the load: the field appears only when asked for with
  // `?include=pets`, so a plain GET does not pay for the relation.
  pets = oneOfArray<CatItemDto | DogItemDto>([CatItemDto, DogItemDto]);
  // Documented the same way: shape only, present in the response solely
  // when `?include=address` asks for it.
  address: AddressItemDto | null = null;
}

/** `list` slot — a leaner projection for list responses. */
export class OwnerListDto {
  id = 0;
  name = "";
  email = "";
}
