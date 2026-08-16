import { enumProp } from "@kavo/nest";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Min,
  ValidateIf,
} from "class-validator";
import { PetSizeEnum } from "../pet/pet.entity.js";
import { TagItemDto } from "../tag/tag.dtos.js";
import { PhotoItemDto } from "../photo/photo.dtos.js";

/**
 * DTO slots for the Cat route. Fields are initialized so the
 * classes carry their shape at runtime — that is what lets the default
 * serializer project responses (and Swagger document them) with no
 * decorator machinery. The `species` discriminator is deliberately absent
 * from every slot: it is never client-writable and never echoed.
 *
 * `Create`/`UpdateCatDto` additionally carry `class-validator` decorators —
 * see `cat.controller.ts`'s `@Override()`'d write methods for how they get
 * validated. There is no `PatchCatDto`: `patchOne` is disabled on this
 * entity (`cat.controller.ts`'s `operations.patchOne: false`).
 *
 * `size`'s own default is `enumProp(...)`'s schema-hint marker object
 * (`@kavo/nest`'s `schema-hints.ts`), not a real `PetSizeEnum` value — it
 * exists only so `@kavo/nest`'s Swagger layer can document the enum's
 * allowed values off a field's plain initializer. `class-transformer`
 * carries that same marker onto the instance whenever the client omits
 * `size` (a missing key falls back to the class's own initializer, not
 * `undefined`), so a plain `@IsOptional()` — which only skips `undefined`/
 * `null` — would never see "omitted" and would run `@IsEnum` against the
 * marker instead. `@ValidateIf` compares by reference against that same
 * marker object instead, which is what actually detects "the client never
 * sent this field" — and for the same reason, `cat.controller.ts`'s
 * `createOne`/`updateOne` overrides strip the field entirely when it's
 * still this sentinel before delegating, so the marker object itself never
 * reaches the deserializer as a bogus `size` value.
 */
export const CREATE_SIZE_DEFAULT = enumProp(Object.values(PetSizeEnum), { example: PetSizeEnum.Medium });
export const UPDATE_SIZE_DEFAULT = enumProp(Object.values(PetSizeEnum), { example: PetSizeEnum.Medium });

/** `create` slot — request body for POST /cats. */
export class CreateCatDto {
  @IsString()
  @IsNotEmpty()
  name = "";

  @IsInt()
  @Min(0)
  age = 0;

  // Optional: several routes rely on the column's own DB default
  // (`PetSizeEnum.Medium`) rather than sending a size explicitly. See this
  // file's own top-of-file comment for why `@ValidateIf` rather than
  // `@IsOptional` is what actually detects "omitted" here.
  @ValidateIf((dto: CreateCatDto) => dto.size !== CREATE_SIZE_DEFAULT)
  @IsEnum(PetSizeEnum)
  size = CREATE_SIZE_DEFAULT;

  @IsBoolean()
  indoor = false;

  @IsInt()
  @Min(0)
  livesLeft = 9;

  // Association by id (ADR-0014): send the owner's id, or an
  // `{ id }` reference. Deep nested writes are deliberately out of scope.
  @IsOptional()
  @IsInt()
  @IsPositive()
  owner: number | null = null;

  // Same mechanism, over a to-many edge: an array of tag ids (or `{ id }`
  // refs) replaces the full set of associated tags.
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  tags: number[] = [];

  // Same mechanism again, over `photos` — independently write-opted under
  // the `resource` strategy rather than `tags`'s `replace` (issue #223).
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  photos: number[] = [];
}

/** `update` slot — request body for PUT /cats/:id (patch derives from it). */
export class UpdateCatDto {
  @IsString()
  @IsNotEmpty()
  name = "";

  @IsInt()
  @Min(0)
  age = 0;

  @ValidateIf((dto: UpdateCatDto) => dto.size !== UPDATE_SIZE_DEFAULT)
  @IsEnum(PetSizeEnum)
  size = UPDATE_SIZE_DEFAULT;

  @IsBoolean()
  indoor = false;

  @IsInt()
  @Min(0)
  livesLeft = 0;

  @IsOptional()
  @IsInt()
  @IsPositive()
  owner: number | null = null;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  tags: number[] = [];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
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
