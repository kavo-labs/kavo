import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Dog } from "./dog.entity.js";

/**
 * CRUD over the concrete `Dog` subtype. Uses the root default pagination
 * (defaultLimit 20, maxLimit 100) — no entity-scope override. No `schema` block:
 * every slot falls back to the entity-derived default (`DefaultSchemaResolver`),
 * so requests/responses are shaped straight from `Dog`'s own TypeORM columns
 * rather than a hand-written DTO. `owner.dtos.ts` still declares its own
 * `DogItemDto` for the polymorphic `pets` union — that usage is independent
 * of this route's own config.
 */
@Kavo(Dog)
@Controller("dogs")
export class DogController {}
