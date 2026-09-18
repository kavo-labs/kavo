import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Address } from "./address.entity.js";
import { CreateAddressDto, UpdateAddressDto, AddressItemDto, AddressListDto } from "./address.dtos.js";

/**
 * Plain CRUD over the inverse side of the one-to-one. `Owner` owns the join
 * column, so an address is associated by writing `{"address": 1}` on an
 * owner (ADR-0014), never the other way round.
 *
 * Kept deliberately plain here: `nest-typeorm`'s `AddressController` is the
 * reference for `@Override` and fully custom routes, and that machinery is
 * `@kavo/nest`'s rather than any adapter's — repeating it would add bulk
 * without exercising anything MikroORM-specific.
 */
@Kavo(Address, {
  schema: {
    input: { create: CreateAddressDto, update: UpdateAddressDto },
    output: { item: AddressItemDto, list: AddressListDto },
  },
})
@Controller("addresses")
export class AddressController {}
