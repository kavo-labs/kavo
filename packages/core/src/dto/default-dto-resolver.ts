import type { DtoClass, DtoResolver, DtoSlot, OperationDtoMap } from "./dto.js";
import type { OperationId } from "../operations/operation.js";
import { resolveDtoSlot } from "./dto-fields-shorthand.js";

/**
 * Bootstrap-cached DTO resolution. Each slot resolves
 * independently: the explicitly registered class, or `null` meaning "use
 * the entity-derived default" (derivation is metadata-driven and happens
 * in the serializer/deserializer, which can see `EntityMetadata`).
 *
 * Fallback chain baked in at construction:
 * - `patch` falls back to the registered `update` class (its key set is
 *   the derivation source for `Partial<update>`), else `null`.
 * - `list` falls back to the registered `item` class ("same as `item`'s
 *   resolved type"), else `null`.
 *
 * Restore and custom operations reuse `item`/`list`;
 * the `operation` argument exists so a future extension could specialize per
 * operation, but resolution *within this class* stays slot-driven only —
 * the per-operation override tier (issue #131) sits ahead of it, in the
 * registry (`OperationDescriptor.input`/`output`/`query`) and the engine's
 * `descriptor.<field> ?? config.dto.resolve(...)` fallback, so this
 * resolver only ever sees the request once no override applies.
 */
export class DefaultDtoResolver<Entity = unknown> implements DtoResolver<Entity> {
  private readonly slots: Readonly<Record<DtoSlot, DtoClass | null>>;

  constructor(dto: OperationDtoMap<Entity> = {}) {
    const map = dto as Record<Exclude<DtoSlot, "query">, Parameters<typeof resolveDtoSlot>[0]> &
      Record<"query", DtoClass | undefined>;
    const create = resolveDtoSlot(map.create);
    const update = resolveDtoSlot(map.update);
    const item = resolveDtoSlot(map.item);
    this.slots = Object.freeze({
      create,
      update,
      patch: resolveDtoSlot(map.patch) ?? update,
      query: map.query ?? null,
      item,
      list: resolveDtoSlot(map.list) ?? item,
    });
  }

  resolve(slot: DtoSlot, _operation: OperationId): DtoClass | null {
    return this.slots[slot];
  }
}
