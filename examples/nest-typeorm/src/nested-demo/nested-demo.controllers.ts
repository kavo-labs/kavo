import { Controller } from "@nestjs/common";
import { Kavo } from "@kavo/nest";
import { Landmark, Region, Zone } from "./nested-demo.entities.js";

/**
 * See `nested-demo.entities.ts`. Each controller opts its outgoing
 * relation(s) into `include=` and nothing else — no `dto` block, no
 * `selectable` ceiling — so the synthesized `<Entity>Item` schema composes
 * the next hop by `$ref` (issue #356).
 */

@Kavo(Region, { allowlists: { includable: ["zones"] } })
@Controller("regions")
export class RegionController {}

@Kavo(Zone, { allowlists: { includable: ["region", "landmarks"] } })
@Controller("zones")
export class ZoneController {}

@Kavo(Landmark, { allowlists: { includable: ["zone"] } })
@Controller("landmarks")
export class LandmarkController {}
