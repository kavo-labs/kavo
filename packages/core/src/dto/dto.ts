import type { EntityInput } from "../types/utility.js";
import type { QueryContext } from "../query/query-context.js";
import type { OperationId } from "../operations/operation.js";

/**
 * Marker for anything usable as a DTO: any non-primitive object shape.
 * DTOs in v6 are shapes for typing, serialization, and Swagger docs —
 * there is no validation subsystem attached to them.
 */
export type Dto = object;

/** A registerable DTO class. DTO classes are plain, no-argument shapes. */
export type DtoClass<Shape extends Dto = Dto> = new () => Shape;

/** The six DTO positions, one per REST verb/context. */
export type DtoSlot = "create" | "update" | "patch" | "query" | "item" | "list";

/**
 * Per-entity DTO registration — the `dto` key of `createCrud`'s config.
 * Every slot is independently optional; an omitted slot falls back to its
 * entity-derived default (derivation rules below):
 *
 * | Slot     | Default when omitted                              |
 * | -------- | ------------------------------------------------- |
 * | `create` | Entity, minus generated/relation fields           |
 * | `update` | Same default as `create`                          |
 * | `patch`  | `Partial<update>` if set, else `Partial<Entity>`  |
 * | `query`  | Generic `QueryContext<Entity>`                   |
 * | `item`   | Entity, subject to field selection                |
 * | `list`   | Same as `item`'s resolved type                    |
 *
 * `item` and `list` are split because a list view often wants a leaner
 * projection than a detail view.
 */
export interface OperationDtoMap<
  Entity,
  CreateDto = EntityInput<Entity>,
  UpdateDto = EntityInput<Entity>,
  PatchDto = Partial<UpdateDto>,
  QueryDto = QueryContext<Entity>,
  ItemDto = Entity,
  ListDto = ItemDto,
> {
  readonly create?: DtoClass<CreateDto & Dto>;
  readonly update?: DtoClass<UpdateDto & Dto>;
  readonly patch?: DtoClass<PatchDto & Dto>;
  readonly query?: DtoClass<QueryDto & Dto>;
  readonly item?: DtoClass<ItemDto & Dto>;
  /** Element type inside `ListResultDto.items` — not the envelope. */
  readonly list?: DtoClass<ListDto & Dto>;
}

/**
 * Resolves the effective DTO for a slot on a given operation: the
 * explicitly registered class, or `null` meaning "use the entity-derived
 * default". Resolution is computed once per entity at bootstrap and cached
 * on the resolved config — never per request. Restore and custom
 * operations reuse `item`/`list`; there are no additional slots.
 */
export interface DtoResolver<_Entity = unknown> {
  resolve(slot: DtoSlot, operation: OperationId): DtoClass | null;
}

/**
 * Per-operation DTO override (issue #131) — the middle tier of the
 * fallback chain `operations.<id>.dto.<field>` → root `dto.<slot>` →
 * entity-derived default. Only the fields meaningful to a given operation
 * are reachable at the type level: `StandardOperationsConfig`
 * (`config/entity-config.ts`) `Pick`s the applicable subset per operation
 * id, so e.g. `deleteOne` cannot even be typed with a `dto` key. The same
 * mismatch is also checked at bootstrap (`createOperationRegistry`), for
 * configs built from an erased or cast type where the type system cannot
 * help.
 */
export interface OperationDtoOverride<
  InputDto extends Dto = Dto,
  OutputDto extends Dto = Dto,
  QueryDto extends Dto = Dto,
> {
  readonly input?: DtoClass<InputDto>;
  readonly output?: DtoClass<OutputDto>;
  readonly query?: DtoClass<QueryDto>;
}

/**
 * The operation entry shape `Ops[Id]` resolves to, or `undefined` when `Id`
 * was never declared. Exported for `service/custom-operation.ts`, which
 * reads the same `Ops` literal for a custom operation's handler signature;
 * not a barrel export (ADR-0010) — it is an implementation detail of how
 * the three `Dto*Of` helpers below are written.
 */
export type OperationEntryOf<Ops, Id extends string> = Id extends keyof Ops ? Ops[Id] : undefined;

/**
 * Extracts the shape a per-operation `dto.<field>` override narrows to,
 * falling back to `Fallback` (the entity's root-slot-derived type) when
 * the operation entry declares no override for that field — including
 * when it is the boolean enable/disable shorthand, which has no `dto` key
 * to match at all.
 */
export type DtoInputOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly dto: { readonly input: DtoClass<infer Shape> } } ? Shape : Fallback;

export type DtoOutputOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly dto: { readonly output: DtoClass<infer Shape> } } ? Shape : Fallback;

export type DtoQueryOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly dto: { readonly query: DtoClass<infer Shape> } } ? Shape : Fallback;
