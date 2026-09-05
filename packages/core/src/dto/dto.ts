import type { EntityInput } from "../types/utility.js";
import type { QueryContext } from "../query/query-context.js";
import type { OperationId } from "../operations/operation.js";
import type { FieldPath } from "../types/field-path.js";

/**
 * Marker for anything usable as a DTO: any non-primitive object shape.
 * DTOs in v6 are shapes for typing, serialization, and Swagger docs —
 * there is no validation subsystem attached to them.
 */
export type Dto = object;

/** A registerable DTO class. DTO classes are plain, no-argument shapes. */
export type DtoClass<Shape extends Dto = Dto> = new () => Shape;

/**
 * An inline field-list shorthand for a `dto.<slot>` position (issue #386):
 * `{ fields: [...] }` derives a projection/writable-field list without a
 * hand-written class. `dto-fields-shorthand.ts` synthesizes a real
 * `DtoClass` from it at bootstrap (`resolveDtoSlot`), tagged so downstream
 * consumers (`@kavo/nest`'s Swagger generation) can tell it apart from a
 * hand-registered class.
 *
 * `create`/`update` no longer accept this shorthand directly (issue #388)
 * — their writable-field list is the top-level `EntityConfig.create.fields`
 * / `EntityConfig.update.fields` (`config/entity-config.ts`) instead, so
 * `dto.create`/`dto.update` stay `DtoClass`-only. `patch`/`item`/`list`
 * still accept it here.
 */
export interface FieldsShorthand<Entity> {
  readonly fields: readonly FieldPath<Entity, 1>[];
}

/**
 * `EntityConfig.create`/`.update`'s own config shape (issue #388, extended
 * with `default`). Unlike {@link FieldsShorthand}, `fields` is optional here
 * — a caller may configure only `default` and leave the writable-field list
 * at its entity-derived default, which a bare `{ fields: [...] }` shorthand
 * can't express.
 *
 * `default` fills in a value for any writable field the request body omits
 * — `createOne` only for `create.default`, `updateOne` only (never
 * `patchOne`) for `update.default`: a `PATCH` omitting a field means "leave
 * it unchanged", so filling it in there would silently overwrite a value
 * the caller never touched. A `createOne`/`updateOne` body that *does* send
 * the field always wins outright — `default` never overrides an explicit
 * value, the same one-way relationship `sort.default`/`select.default`/
 * `include.default` already have with their own client-supplied values.
 */
export interface WriteFieldsConfig<Entity> {
  readonly fields?: readonly FieldPath<Entity, 1>[];
  /** Values for fields the request body doesn't set. Validated at bootstrap against the entity's own writable columns. */
  readonly default?: Partial<EntityInput<Entity>>;
}

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
  readonly patch?: DtoClass<PatchDto & Dto> | FieldsShorthand<Entity>;
  readonly query?: DtoClass<QueryDto & Dto>;
  readonly item?: DtoClass<ItemDto & Dto> | FieldsShorthand<Entity>;
  /** Element type inside `ListResultDto.items` — not the envelope. */
  readonly list?: DtoClass<ListDto & Dto> | FieldsShorthand<Entity>;
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
