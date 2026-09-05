import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Landmark, Region, Zone } from "./nested-demo.entities.js";

/**
 * See `nested-demo.entities.ts`. Each controller opts its outgoing
 * relation(s) into `include=` and nothing else — no `dto` block — so the
 * synthesized `<Entity>Item` schema composes the next hop by `$ref`
 * (issue #356).
 */

@Kavo(Region, { include: { fields: ["zones"] } })
@Controller("regions")
export class RegionController {}

@Kavo(Zone, { include: { fields: ["region", "landmarks"] } })
@Controller("zones")
export class ZoneController {}

@Kavo(Landmark, { include: { fields: ["zone"] } })
@Controller("landmarks")
export class LandmarkController {}
