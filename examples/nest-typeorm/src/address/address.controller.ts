import { Controller, Get, Inject, Param } from "@nestjs/common";
import { Kavo, Override, getKavoServiceToken } from "@kavo/nest";
import type { DefaultKavoService, EntityId, KavoContext, RequestPreconditions, WireQuery } from "@kavo/core";
import { NotFoundException } from "@kavo/core";
import type { DataSource } from "typeorm";
import { Address } from "./address.entity.js";
import { CreateAddressDto, UpdateAddressDto, PatchAddressDto, AddressItemDto, AddressListDto } from "./address.dtos.js";
import { DATA_SOURCE } from "../database.module.js";
import { assertValidPostalCode, clearOwnerAddress, normalizePostalCode } from "./address.runtime.js";

/**
 * `Address` overrides all five singular standard operations, each backed
 * by an `@Override`'d controller method (issue #23) rather than a
 * config-level `operations.<id>.handler` — every method injects the
 * entity's own `DefaultKavoService` (`base`) to delegate to default
 * behavior, and the raw `DataSource` for the one write that reaches across
 * entities. `@Kavo` still generates every route's method, path, status,
 * params, and Swagger metadata from the registry (ADR-0006, ADR-0012);
 * only the function backing each route is this class's own method. Owners
 * still associate an address by id (`{"address": 1}` on `POST /owners` —
 * ADR-0014).
 *
 * `normalizePostalCodeOne` in the config below is a **custom operation**
 * (issue #145): an `operations` key outside the standard eight, with a
 * handler of its own and a route from `meta.routes`. Normalizing a stored
 * postal code is an action with an operation identity — one row in, one
 * row out — so it gets the registry entry, the generated route and Swagger
 * document, the per-operation settings scope, and the app context
 * that come with one.
 *
 * Its handler reaches the database through `context.repository`
 * (ADR-0025), which is what makes it writable *here*: this config object is
 * evaluated when the class is defined (ADR-0012), and the `DataSource` this
 * app uses is built inside `KavoModule.forRootAsync`'s factory, which has
 * not run yet. There is nothing for the handler to close over, and it needs
 * nothing.
 *
 * `createOne`/`updateOne`/`patchOne` below are typed with the concrete,
 * `class-validator`-decorated DTO classes (`address.dtos.ts`) rather than
 * `Partial<Address>` purely for a concrete compile-time type inside each
 * method body — since issue #281, the app's global `ValidationPipe`
 * (`app.module.ts`) validates a registered `dto.create`/`update`/`patch`
 * class on a generated route as well (see `owner.controller.ts`'s
 * validation note), so these overrides exist here for the cross-entity
 * write and the other custom behavior above, not for validation.
 * `postalCode`'s exact-5-digit format stays a procedural check
 * (`assertValidPostalCode`) run after that generic shape validation passes
 * — a business rule with its own normalization step, not a `class-validator`
 * decorator's job.
 *
 * `validatePostalCode` below is the other shape: a fully custom,
 * registry-independent route (issue #26), a plain native Nest method with
 * no `operations` entry at all. Answering `{ valid }` about a row is not an
 * operation on `Address` — it has no operation identity, no entity-shaped
 * response, and nothing to gain from the registry — so it owns its own
 * `@Get`, `@Param` and status entirely.
 */
@Kavo(Address, {
  dto: {
    create: CreateAddressDto,
    update: UpdateAddressDto,
    item: AddressItemDto,
    list: AddressListDto,
  },
  operations: {
    createOne: true,
    findOne: true,
    findMany: true,
    updateOne: true,
    patchOne: true,
    deleteOne: true,
    normalizePostalCodeOne: {
      handler: {
        /**
         * `POST /addresses/:id/normalize-postal-code`. The input is the
         * `{ id, body }` pair the engine assembles for an id-addressed
         * write; this operation reads nothing from the body, since the
         * value it corrects is already stored.
         */
        async execute({ id }: { id: EntityId }, context: KavoContext<Address>) {
          const existing = await context.repository.findOneById(id, null, context);
          if (existing === null) {
            throw new NotFoundException({
              messageParams: { entity: context.entityName, id: String(id) },
              context: {
                entityName: context.entityName,
                operation: context.operation,
                correlationId: context.correlationId,
              },
            });
          }
          const postalCode = normalizePostalCode(existing.postalCode);
          assertValidPostalCode(postalCode);
          // The same context back, so the write joins whatever transaction
          // and soft-delete strategy the request resolved.
          return context.repository.patch(id, { postalCode }, context);
        },
      },
      meta: { routes: { method: "POST", path: ":id/normalize-postal-code" } },
    },
  },
})
@Controller("addresses")
export class AddressController {
  constructor(
    @Inject(getKavoServiceToken(Address)) private readonly base: DefaultKavoService<Address>,
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
  ) {}

  /** Normalizes `postalCode` before persisting. */
  @Override()
  async createOne(dto: CreateAddressDto): Promise<unknown> {
    const postalCode = normalizePostalCode(dto.postalCode);
    assertValidPostalCode(postalCode);
    return this.base.createOne({ ...dto, postalCode } as never);
  }

  /**
   * PUT sends the whole shape, so `postalCode` is always validated.
   *
   * The trailing `preconditions` parameter is the `If-Match` /
   * `If-None-Match` tokens `@Kavo` wires into every routed method,
   * override included (ADR-0020 §7). Forwarding it is not optional
   * bookkeeping: the precondition is evaluated *inside* the engine, so a
   * method that drops it accepts an `If-Match` header and writes anyway.
   */
  @Override()
  async updateOne(id: EntityId, dto: UpdateAddressDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    const patch = { ...dto };
    patch.postalCode = normalizePostalCode(patch.postalCode);
    assertValidPostalCode(patch.postalCode);
    return this.base.updateOne(id as never, patch as never, { preconditions: preconditions ?? undefined });
  }

  /** Same validation as `updateOne`, but only when the field is actually present. */
  @Override()
  async patchOne(id: EntityId, dto: PatchAddressDto, preconditions: RequestPreconditions | null): Promise<unknown> {
    const patch = { ...dto };
    if (patch.postalCode !== undefined) {
      patch.postalCode = normalizePostalCode(patch.postalCode);
      assertValidPostalCode(patch.postalCode);
    }
    return this.base.patchOne(id as never, patch as never, { preconditions: preconditions ?? undefined });
  }

  /**
   * `Owner` owns the join column (`owner.entity.ts`), so the owner
   * referencing this row is detached before the address is removed.
   * `preconditions` is forwarded so a stale `If-Match` still refuses the
   * delete — see `updateOne` above for why an override has to do that
   * itself.
   */
  @Override()
  async deleteOne(id: EntityId, preconditions: RequestPreconditions | null): Promise<void> {
    await clearOwnerAddress(this.dataSource, Number(id));
    await this.base.deleteOne(id as never, { preconditions: preconditions ?? undefined });
  }

  /**
   * Augments the response with a derived, unpersisted field. `query`
   * arrives already wired — `@Kavo` applies the same `WireQuery`-producing
   * pipe to an `@Override`'d read method's `query` param as it does to a
   * generated route's.
   */
  @Override()
  async findOne(id: EntityId, query: WireQuery): Promise<unknown> {
    const address = await this.base.findOne(id as never, query as never);
    return { ...address, formattedAddress: `${address.street}, ${address.city} ${address.postalCode}` };
  }

  /**
   * `GET /addresses/:id/validate-postal-code` — a fully custom,
   * registry-independent route (issue #26): a plain native `@Get` with its
   * own `@Param`, no `operations` entry. `@Kavo` never inspects this
   * method — route generation only checks method names against registry
   * operation ids (manual-method-wins) or `@Override` metadata, and
   * `validatePostalCode` matches neither. It needs nothing from Kavo beyond
   * the constructor-injected `base` service, the same `getKavoServiceToken`
   * DI every `@Override`'d method above already uses.
   */
  @Get(":id/validate-postal-code")
  async validatePostalCode(@Param("id") id: EntityId): Promise<{ valid: boolean }> {
    const existing = await this.base.findOne(id as never);
    try {
      assertValidPostalCode(existing.postalCode);
      return { valid: true };
    } catch {
      return { valid: false };
    }
  }
}
