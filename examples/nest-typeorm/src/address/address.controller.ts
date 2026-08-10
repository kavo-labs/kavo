import { Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { Kavo, Override, getKavoServiceToken } from "@kavo/nest";
import type { DefaultKavoService, EntityId, RequestPreconditions, WireQuery } from "@kavo/core";
import type { DataSource } from "typeorm";
import { Address } from "./address.entity.js";
import { CreateAddressDto, UpdateAddressDto, AddressItemDto, AddressListDto } from "./address.dtos.js";
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
 * `normalizePostalCode` and `validatePostalCode` below are both fully
 * custom, registry-independent routes (issue #26): plain native Nest
 * methods with no `operations` entry at all. Neither action has an
 * operation identity of its own, so neither wants the registry-generated
 * route/Swagger/param machinery `@Override` exists to keep — they own
 * their own `@Post`/`@Get`, `@Param`, and status entirely.
 *
 * The alternative for an action that *does* want an identity is a custom
 * operation — an `operations` key outside the standard eight, carrying its
 * own handler (issue #145). It needs a handler that can reach persistence
 * at *decoration* time (ADR-0012), and this app builds its `DataSource`
 * inside `KavoModule.forRootAsync`'s factory, which has not run yet. Both
 * routes below therefore stay native, and reach data through the
 * constructor-injected `base` service instead.
 */
@Kavo(Address, {
  dto: {
    create: CreateAddressDto,
    update: UpdateAddressDto,
    item: AddressItemDto,
    list: AddressListDto,
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
  async createOne(dto: Partial<Address>): Promise<unknown> {
    const postalCode = normalizePostalCode(dto.postalCode ?? "");
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
  async updateOne(id: EntityId, dto: Partial<Address>, preconditions: RequestPreconditions | null): Promise<unknown> {
    const patch = { ...dto };
    if (patch.postalCode !== undefined) {
      patch.postalCode = normalizePostalCode(patch.postalCode);
      assertValidPostalCode(patch.postalCode);
    }
    return this.base.updateOne(id as never, patch as never, { preconditions: preconditions ?? undefined });
  }

  /** Same validation as `updateOne`, but only when the field is actually present. */
  @Override()
  async patchOne(id: EntityId, dto: Partial<Address>, preconditions: RequestPreconditions | null): Promise<unknown> {
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
   * `POST /addresses/:id/normalize-postal-code` — a fully custom,
   * registry-independent route (issue #26): reuses the same
   * normalization/validation as `createOne`/`updateOne`/`patchOne`, applied
   * to an already-persisted row, with no `operations` entry and none of
   * `@Override`'s generated route/Swagger/param wiring. Nest defaults a
   * plain `@Post` to a 201, matching what the registry would have produced.
   */
  @Post(":id/normalize-postal-code")
  async normalizePostalCodeRoute(@Param("id") id: EntityId): Promise<unknown> {
    const existing = await this.base.findOne(id as never);
    const postalCode = normalizePostalCode(existing.postalCode);
    assertValidPostalCode(postalCode);
    return this.base.updateOne(id as never, { postalCode } as never);
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
