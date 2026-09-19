import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Dog } from "./dog.entity.js";

/**
 * CRUD over the concrete `Dog` subtype. Uses the root default pagination
 * (defaultLimit 20, maxLimit 100) — no entity-scope override. No `dto`
 * block: every slot falls back to the entity-derived default
 * (`DefaultSchemaResolver`), so requests and responses are shaped straight from
 * `Dog`'s own MikroORM metadata rather than a hand-written DTO.
 *
 * That makes this route the one place the derived defaults are visible end
 * to end — and the one place worth checking that the `species` discriminator
 * is not among them: MikroORM never hydrates it, and the adapter reports it
 * generated, so a client can neither read it back nor write it.
 */
@Kavo(Dog)
@Controller("dogs")
export class DogController {}
