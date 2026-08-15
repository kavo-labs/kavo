import { enumProp, oneOfArray } from "@kavo/nest";
import { CatItemDto } from "../cat/cat.dtos.js";
import { AddressItemDto } from "../address/address.dtos.js";
import { PetSizeEnum } from "../pet/pet.entity.js";

/**
 * DTO slots for the Owner route. See `cat.dtos.ts` for the
 * rationale behind plain initialized-field classes.
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
  name = "";
  email = "";
  startedAt: Date | null = null;
  // Association by id (ADR-0014): send the address's id, or an `{ id }`
  // reference. Deep nested writes are deliberately out of scope.
  address: number | null = null;
}

/** `update` slot — request body for PUT /owners/:id (patch derives from it). */
export class UpdateOwnerDto {
  name = "";
  email = "";
  startedAt: Date | null = null;
  address: number | null = null;
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
