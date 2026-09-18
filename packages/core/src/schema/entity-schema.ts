import type { KavoSchema } from "./kavo-schema.js";
import type { SchemaClass, SchemaLike } from "./schema-class.js";
import { isSchemaClass } from "./schema-class.js";
import { isFieldsShorthand, resolveSchemaClassSlot } from "./schema-fields-shorthand.js";
import type { OperationEntryOf } from "../operations/operation-entry.js";
import type { OperationId } from "../operations/operation.js";
import type { EntityInput } from "../types/utility.js";
import type { QueryContext } from "../query/query-context.js";
import type { FieldsShorthand, WriteFieldsConfig } from "../config/write-fields.js";
import { schemaClassFromFields } from "./schema-fields-shorthand.js";

/**
 * The slot-position union `KavoSchema<T> | SchemaClass<T>` for an
 * unconstrained `T`. `SchemaLike<T extends object = object>` (Task 1)
 * bounds `T` to `object` at its own declaration because `SchemaClass<Shape
 * extends object>` requires it — but the slot positions below are typed
 * against the entity's own (unconstrained) generic parameters, exactly as
 * `KavoSchema<X>` was before this widening. Intersecting `& object` at
 * every slot to satisfy `SchemaLike`'s bound would change what's accepted
 * there (and does — it breaks inference in `EntityConfig`'s no-type-argument
 * position, e.g. `Parameters<...>` extraction, where the entity type
 * parameter defaults to `unknown`). Defining the union locally instead
 * keeps the `KavoSchema<T>` half exactly as unconstrained as it always was,
 * and only asks `SchemaClass` for `T & object` (its own actual bound).
 */
type SchemaSlot<T> = KavoSchema<T> | SchemaClass<T & object>;

/**
 * ADR-0055: `schema` is the per-slot, input/output-split counterpart to
 * `dto` — a {@link SchemaLike} (a `KavoSchema<Output>` validator or a bare
 * `SchemaClass<Output>`, the structural contracts `kavo-schema.ts`/
 * `schema-class.ts` define) instead of a `DtoClass<Shape>`. Landed
 * additively alongside `dto` rather than replacing it outright: `@kavo/nest`'s
 * OpenAPI generation, route decoration, and body-validation wiring
 * (`swagger.ts`/`kavo.decorator.ts`/`kavo.module.ts`) resolve DTOs directly
 * off core's `dto` exports today, and `pnpm check` builds the whole
 * workspace — deleting `dto` here before that framework-layer migration
 * lands would red the gate for a package this issue scopes out. `dto`'s
 * removal is tracked as follow-up work once `@kavo/nest` (and
 * `@kavo/graphql`/`@kavo/mcp`) migrate off it.
 */
export type SchemaInputSlot = "create" | "update" | "patch" | "query";
export type SchemaOutputSlot = "item" | "list";

/**
 * `schema.input`'s shorthand: a single {@link SchemaLike} in place of the
 * per-slot map, applied to `create`/`update`/`patch` alike (never `query`,
 * which has its own shape and no natural single-schema reading). Equivalent
 * to writing `{ create: X, update: X, patch: X }` by hand.
 */
export type SchemaInputMap<Entity, CreateOut, UpdateOut, PatchOut, QueryOut> =
  | SchemaSlot<CreateOut>
  | {
      readonly create?: SchemaSlot<CreateOut>;
      readonly update?: SchemaSlot<UpdateOut>;
      readonly patch?: SchemaSlot<PatchOut> | FieldsShorthand<Entity>;
      readonly query?: SchemaSlot<QueryOut>;
    };

/**
 * `schema.output`'s shorthand: a single {@link SchemaLike} in place of the
 * per-slot map, applied to `item`/`list` alike. Equivalent to writing
 * `{ item: X, list: X }` by hand.
 */
export type SchemaOutputMap<Entity, ItemOut, ListOut> =
  | SchemaSlot<ItemOut>
  | {
      readonly item?: SchemaSlot<ItemOut> | FieldsShorthand<Entity>;
      readonly list?: SchemaSlot<ListOut> | FieldsShorthand<Entity>;
    };

/**
 * Per-entity schema registration — the `schema` key of `createCrud`'s
 * config. Mirrors `dto`'s slot convention exactly (ADR-0055's own
 * decision), split into `input`/`output` rather than one flat map: `input`
 * feeds the engine's deserialization stage, `output` feeds response
 * mapping at serialization — the two never run at the same pipeline stage,
 * so keeping them apart avoids a single map whose keys mean different
 * things depending on which slot you're looking at.
 *
 * Both `input` and `output` accept a single {@link SchemaLike} as shorthand
 * for their whole per-slot map (`SchemaInputMap`/`SchemaOutputMap`), and
 * `EntitySchema` below additionally accepts a single `SchemaLike` in place
 * of this whole map, applied to every slot on both sides at once.
 */
export interface EntitySchemaMap<
  Entity,
  CreateOut = EntityInput<Entity>,
  UpdateOut = EntityInput<Entity>,
  PatchOut = Partial<UpdateOut>,
  QueryOut = QueryContext<Entity>,
  ItemOut = Entity,
  ListOut = ItemOut,
> {
  readonly input?: SchemaInputMap<Entity, CreateOut, UpdateOut, PatchOut, QueryOut>;
  readonly output?: SchemaOutputMap<Entity, ItemOut, ListOut>;
}

/**
 * `createCrud`'s `schema` key itself: `EntitySchemaMap`'s `input`/`output`
 * split, or a single {@link SchemaLike} as shorthand for
 * `{ input: X, output: X }` — one schema applied to `create`/`update`/
 * `patch` on the way in and `item`/`list` on the way out. Typed against
 * `CreateOut` only: the input leg is where a mismatched shape is actually
 * rejected (`SchemaValidationException`), while a failing `schema.output`
 * safely falls back to the already-projected value (`DefaultSchemaResolver`
 * below) — so requiring the same schema's output to also satisfy `ItemOut`
 * would reject shorthand usages (e.g. a create schema narrower than the
 * full entity) that work fine at runtime.
 */
export type EntitySchema<
  Entity,
  CreateOut = EntityInput<Entity>,
  UpdateOut = EntityInput<Entity>,
  PatchOut = Partial<UpdateOut>,
  QueryOut = QueryContext<Entity>,
  ItemOut = Entity,
  ListOut = ItemOut,
> =
  | SchemaSlot<CreateOut>
  | EntitySchemaMap<Entity, CreateOut, UpdateOut, PatchOut, QueryOut, ItemOut, ListOut>;

/**
 * Structural check: is `value` the whole-map shorthand (a bare validator or
 * class) rather than the `{ input, output }` / per-slot object? A validator
 * has `safeParse`; a class is itself a function ({@link isSchemaClass}) —
 * neither shape has meaning as a plain `{ input, output }` map, so either
 * one signals "this is the shorthand, not the map".
 */
function isSchemaShorthand(value: unknown): value is SchemaSlot<unknown> {
  if (typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  if (value === null) {
    return false;
  }
  return isSchemaClass(value) || typeof (value as { safeParse?: unknown }).safeParse === "function";
}

/**
 * Bootstrap-cached schema resolution, the `schema`-typed sibling of
 * `DtoResolver`. Each slot resolves independently: the explicitly
 * registered schema, or `null` meaning "no schema configured — no input
 * validation, no output narrowing beyond whatever `dto`/the entity-derived
 * default already does."
 *
 * `patch` falls back to the registered `update` schema when unset (the
 * same fallback `DefaultDtoResolver` gives `dto.patch`); `list` falls back
 * to `item`. `create`/`query` have no fallback of their own.
 *
 * Resolution still declares its return type as `KavoSchema<unknown> | null`
 * rather than the wider `SchemaLike` the config side now accepts
 * (`EntitySchemaMap`/`EntitySchema`/`OperationSchemaOverride` below): a
 * class-shaped slot is accepted and stored here, but `kavo-engine.ts` does
 * not yet branch on kind before calling `safeParse` — that is Task 9's
 * change (per the `remove-dto` plan). Widening this resolver's own return
 * type ahead of that would red `kavo-engine.ts`'s build today.
 */
export interface SchemaResolver<_Entity = unknown> {
  resolveInput(slot: SchemaInputSlot, operation: OperationId): KavoSchema<unknown> | null;
  resolveOutput(slot: SchemaOutputSlot, operation: OperationId): KavoSchema<unknown> | null;
}

/**
 * `schema.input.create`/`.update`'s writable-fields fallback source — the
 * same top-level `create.fields`/`update.fields` config `resolveEntityConfig`
 * already resolves and passes to `DefaultDtoResolver` today.
 */
export interface WritableSchemaFieldsConfig<Entity> {
  readonly create?: WriteFieldsConfig<Entity>;
  readonly update?: WriteFieldsConfig<Entity>;
}

/**
 * Synthesizes a `SchemaClass` from a `WriteFieldsConfig`'s `fields` array —
 * mirrors `DefaultDtoResolver`'s own create/update fallback. Only the plain
 * array form is accepted here: the `{ exclude }` form is resolved to a
 * concrete array by `resolveEntityConfig` before it ever reaches this
 * resolver (same division of labor `DefaultDtoResolver` relies on), so
 * anything else (including the raw `{ exclude }` shape, if it somehow
 * arrives unresolved) yields no fallback rather than a wrong one.
 */
function writableFieldsToSchemaClass<Entity>(
  fields: WriteFieldsConfig<Entity>["fields"] | undefined,
): SchemaClass | null {
  if (fields === undefined || !Array.isArray(fields)) {
    return null;
  }
  return schemaClassFromFields(fields as readonly string[]);
}

export class DefaultSchemaResolver<Entity = unknown> implements SchemaResolver<Entity> {
  private readonly input: Readonly<Record<SchemaInputSlot, KavoSchema<unknown> | null>>;
  private readonly output: Readonly<Record<SchemaOutputSlot, KavoSchema<unknown> | null>>;

  constructor(schema?: EntitySchema<Entity>, writable: WritableSchemaFieldsConfig<Entity> = {}) {
    const map: EntitySchemaMap<Entity, unknown, unknown, unknown, unknown, unknown, unknown> = isSchemaShorthand(
      schema,
    )
      ? { input: schema, output: schema }
      : (schema ?? {});
    const input = isSchemaShorthand(map.input)
      ? { create: map.input, update: map.input, patch: map.input }
      : (map.input ?? {});
    const output = isSchemaShorthand(map.output) ? { item: map.output, list: map.output } : (map.output ?? {});
    // A `{ fields }` shorthand slot resolves to a synthesized `SchemaClass`
    // once; a non-shorthand slot (a `KavoSchema` validator or a hand-written
    // class, or unset) passes through unchanged. Resolving once and reusing
    // the result for the `patch`→`update` / `list`→`item` fallback chains
    // matters: `resolveSchemaClassSlot` synthesizes a fresh class per call,
    // and `shorthandFieldsOf`'s `WeakMap` is keyed on class identity, so
    // resolving the same shorthand twice would produce two classes that
    // read back inconsistently downstream.
    const resolveSlot = (value: unknown): KavoSchema<unknown> | SchemaClass | undefined =>
      isFieldsShorthand(value)
        ? (resolveSchemaClassSlot(value) ?? undefined)
        : (value as KavoSchema<unknown> | SchemaClass | undefined);
    const patch = resolveSlot(input.patch);
    const update = resolveSlot(input.update);
    const item = resolveSlot(output.item);
    const list = resolveSlot(output.list);
    // Cast: slot values are `SchemaLike` (Task 1), but the resolver's own
    // declared return type stays `KavoSchema<unknown> | null` until Task 9
    // teaches `kavo-engine.ts` to branch on kind — see the interface doc
    // comment above.
    this.input = Object.freeze({
      create: (input.create ?? writableFieldsToSchemaClass(writable.create?.fields) ?? null) as
        | KavoSchema<unknown>
        | null,
      update: (update ?? writableFieldsToSchemaClass(writable.update?.fields) ?? null) as KavoSchema<unknown> | null,
      patch: (patch ?? update ?? null) as KavoSchema<unknown> | null,
      query: (input.query ?? null) as KavoSchema<unknown> | null,
    });
    this.output = Object.freeze({
      item: (item ?? null) as KavoSchema<unknown> | null,
      list: (list ?? item ?? null) as KavoSchema<unknown> | null,
    });
  }

  resolveInput(slot: SchemaInputSlot, _operation?: OperationId): KavoSchema<unknown> | null {
    return this.input[slot];
  }

  resolveOutput(slot: SchemaOutputSlot, _operation?: OperationId): KavoSchema<unknown> | null {
    return this.output[slot];
  }
}

/**
 * Per-operation schema override (the `schema`-typed sibling of
 * `OperationDtoOverride`, issue #131): `operations.<id>.schema.<field>` →
 * root `schema.input.<slot>`/`schema.output.<slot>` → entity-derived
 * default, the same three-tier fallback chain `dto` has.
 *
 * Unlike `OperationDtoOverride`, this is not narrowed per standard
 * operation id via `Pick` — every field is simply optional here, and which
 * ones are meaningful for a given id is enforced at bootstrap
 * (`resolveSchemaOverride`, `default-operation-registry.ts`), the runtime
 * mirror of the same check `DTO_OVERRIDE_FIELDS` makes for `dto`.
 */
export interface OperationSchemaOverride<InputOut = unknown, OutputOut = unknown, QueryOut = unknown> {
  readonly input?: SchemaSlot<InputOut>;
  readonly output?: SchemaSlot<OutputOut>;
  readonly query?: SchemaSlot<QueryOut>;
}

/**
 * The three `Schema*Of` type-inference helpers, the `schema`-typed
 * siblings of `DtoInputOf`/`DtoOutputOf`/`DtoQueryOf`. A `schema` override
 * takes precedence when present (`SchemaOutput<S>`, the structural-contract
 * equivalent of `z.infer`); otherwise resolves `Fallback` (the entity's
 * root-slot-derived type) directly — there is no further fallback to a
 * `dto`-typed reading here.
 */
export type SchemaInputOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly schema: { readonly input: SchemaLike<infer Output> } }
    ? Output
    : Fallback;

export type SchemaOutputOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly schema: { readonly output: SchemaLike<infer Output> } }
    ? Output
    : Fallback;

export type SchemaQueryOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly schema: { readonly query: SchemaLike<infer Output> } }
    ? Output
    : Fallback;
