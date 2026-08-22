import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString } from "class-validator";

/**
 * DTO slots for the OwnerSetting route. `owner_id` never appears on any of
 * these: it is the entity's sole primary column, so — like every other
 * entity's single `idField` — it is excluded from the writable projection
 * by default. The row's owner is instead set the same way any relation is
 * (ADR-0014): `owner` on `create` takes the owner's id, and the adapter
 * writes it through the `@JoinColumn` this entity's `owner` relation
 * declares, which happens to be `owner_id` itself. `owner` is deliberately
 * absent from `Update`/`PatchOwnerSettingDto` — which owner a settings row
 * belongs to isn't something a client repoints after creation.
 */

/** `create` slot — request body for POST /owner-settings. */
export class CreateOwnerSettingDto {
  @IsInt()
  @IsPositive()
  owner = 0;

  @IsString()
  @IsNotEmpty()
  theme = "";

  @IsBoolean()
  emailNotifications = true;
}

/** `update` slot — request body for PUT /owner-settings/:id (patch derives from it). */
export class UpdateOwnerSettingDto {
  @IsString()
  @IsNotEmpty()
  theme = "";

  @IsBoolean()
  emailNotifications = true;
}

/**
 * `PATCH /owner-settings/:id`'s own validated shape. See `PatchOwnerDto`
 * (`owner.dtos.ts`) for why this exists as its own class.
 */
export class PatchOwnerSettingDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  theme?: string;

  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;
}

/** `item` slot — the detail projection. */
export class OwnerSettingItemDto {
  owner_id = 0;
  theme = "";
  emailNotifications = true;
}

/** `list` slot — same shape as `item`; an owner-setting has nothing left to trim. */
export class OwnerSettingListDto {
  owner_id = 0;
  theme = "";
  emailNotifications = true;
}
