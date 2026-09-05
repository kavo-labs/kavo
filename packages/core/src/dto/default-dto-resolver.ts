import type { DtoClass, DtoResolver, DtoSlot, FieldsShorthand, OperationDtoMap } from "./dto.js";
import type { OperationId } from "../operations/operation.js";
import { dtoClassFromFields, resolveDtoSlot } from "./dto-fields-shorthand.js";

/**
 * The top-level `create`/`update` writable-field shorthand (issue #388,
 * `config/entity-config.ts`'s `EntityConfig.create`/`.update`) — passed in
 * alongside `dto` since `dto.create`/`dto.update` no longer carry it
 * themselves.
 */
export interface WritableFieldsConfig<Entity> {
  readonly create?: FieldsShorthand<Entity>;
  readonly update?: FieldsShorthand<Entity>;
}

/**
 * Bootstrap-cached DTO resolution. Each slot resolves
 * independently: the explicitly registered class, or `null` meaning "use
 * the entity-derived default" (derivation is metadata-driven and happens
 * in the serializer/deserializer, which can see `EntityMetadata`).
 *
 * Fallback chain baked in at construction:
 * - `create`/`update` fall back to the top-level `create.fields`/
 *   `update.fields` shorthand (issue #388) when no class is registered,
 *   synthesized into a `DtoClass` the same way `dto.patch`/`item`/`list`'s
 *   own `{ fields }` shorthand is (`dto-fields-shorthand.ts`).
 * - `patch` falls back to the resolved `update` class (its key set is
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

  constructor(dto: OperationDtoMap<Entity> = {}, writable: WritableFieldsConfig<Entity> = {}) {
    const map = dto as Record<Exclude<DtoSlot, "create" | "update" | "query">, Parameters<typeof resolveDtoSlot>[0]> &
      Record<"create" | "update", DtoClass | undefined> &
      Record<"query", DtoClass | undefined>;
    const create =
      map.create ?? (writable.create ? dtoClassFromFields(writable.create.fields as readonly string[]) : null);
    const update =
      map.update ?? (writable.update ? dtoClassFromFields(writable.update.fields as readonly string[]) : null);
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
