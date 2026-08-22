import { Controller, Inject } from "@nestjs/common";
import { Kavo, Override, getKavoServiceToken } from "@kavo/nest";
import type { DefaultKavoService, EntityId, RequestPreconditions } from "@kavo/core";
import { PetTag } from "./pet-tag.entity.js";
import { CreatePetTagDto, UpdatePetTagDto, PatchPetTagDto, PetTagItemDto, PetTagListDto } from "./pet-tag.dtos.js";
import { assertValidNote, normalizeNote } from "./pet-tag.runtime.js";

/**
 * Plain CRUD over a composite-key entity (ADR-0039, issue #267):
 * `petId`/`tagId` are the whole primary key, so every route this generates
 * addresses a row by `GET/PUT/PATCH/DELETE /pet-tags/:petId~:tagId` — one
 * path segment joining both columns with `~` — instead of a single numeric
 * `:id`. `createOne` accepts `petId`/`tagId` (a natural key the client
 * supplies); `updateOne`/`patchOne` don't, since the composite route id
 * already addresses the row and the key is immutable afterward (ADR-0039's
 * default — nothing here overrides `creatable`/`updatable` for it).
 *
 * Validation: `createOne`/`updateOne`/`patchOne` are `@Override()`'d purely
 * to give their body parameter a concrete, `class-validator`-decorated
 * type — see `owner.controller.ts`'s own validation note for why. `note`'s
 * trim-then-validate step is the same two-step shape `AddressController`
 * uses for `postalCode`.
 */
@Kavo(PetTag, {
  dto: {
    create: CreatePetTagDto,
    update: UpdatePetTagDto,
    item: PetTagItemDto,
    list: PetTagListDto,
  },
})
@Controller("pet-tags")
export class PetTagController {
  constructor(@Inject(getKavoServiceToken(PetTag)) private readonly base: DefaultKavoService<PetTag>) {}

  @Override()
  async createOne(dto: CreatePetTagDto): Promise<unknown> {
    const note = normalizeNote(dto.note);
    assertValidNote(note);
    return this.base.createOne({ ...dto, note } as never);
  }

  @Override()
  async updateOne(id: EntityId, dto: UpdatePetTagDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    const note = normalizeNote(dto.note);
    assertValidNote(note);
    return this.base.updateOne(id as never, { note } as never, { preconditions: preconditions ?? undefined });
  }

  @Override()
  async patchOne(id: EntityId, dto: PatchPetTagDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    const patch = { ...dto };
    if (patch.note !== undefined) {
      patch.note = normalizeNote(patch.note);
      assertValidNote(patch.note);
    }
    return this.base.patchOne(id as never, patch as never, { preconditions: preconditions ?? undefined });
  }
}
