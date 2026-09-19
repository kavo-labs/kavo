import type { KavoSchema } from "./kavo-schema.js";
import type { SchemaClass, SchemaLike } from "./schema-class.js";
import { isSchemaClass } from "./schema-class.js";
import { isFieldsShorthand, resolveSchemaClassSlot } from "./schema-fields-shorthand.js";
import type { OperationEntryOf } from "../operations/operation-entry.js";
import type { OperationId } from "../operations/operation.js";
import type { EntityInput } from "../types/utility.js";
import type { QueryContext } from "../query/query-context.js";
import type { WriteFieldsConfig } from "../config/write-fields.js";
import type { FieldsInput } from "./schema-fields-shorthand.js";
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
 * ADR-0055: `schema` is the per-slot, input/output-split entity contract.
 * Each slot takes a {@link SchemaLike} — a `KavoSchema<Output>` validator or
 * a bare `SchemaClass<Output>`, the structural contracts `kavo-schema.ts`/
 * `schema-class.ts` define. It replaced the former `dto` config key.
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
  | FieldsInput<Entity>
  | {
      readonly create?: SchemaSlot<CreateOut> | FieldsInput<Entity>;
      readonly update?: SchemaSlot<UpdateOut> | FieldsInput<Entity>;
      readonly patch?: SchemaSlot<PatchOut> | FieldsInput<Entity>;
      readonly query?: SchemaSlot<QueryOut>;
    };

/**
 * `schema.output`'s shorthand: a single {@link SchemaLike} in place of the
 * per-slot map, applied to `item`/`list` alike. Equivalent to writing
 * `{ item: X, list: X }` by hand.
 */
export type SchemaOutputMap<Entity, ItemOut, ListOut> =
  | SchemaSlot<ItemOut>
  | FieldsInput<Entity>
  | {
      readonly item?: SchemaSlot<ItemOut> | FieldsInput<Entity>;
      readonly list?: SchemaSlot<ListOut> | FieldsInput<Entity>;
    };

/**
 * Per-entity schema registration — the `schema` key of `createCrud`'s
 * config. Mirrors `schema`'s slot convention exactly (ADR-0055's own
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
  | FieldsInput<Entity>
  | EntitySchemaMap<Entity, CreateOut, UpdateOut, PatchOut, QueryOut, ItemOut, ListOut>;

type NormalizedSlot = KavoSchema<unknown> | SchemaClass | undefined;

/**
 * Canonicalizes every spelling `schema` accepts (a bare validator/class, a
 * bare `['a', 'b']` array or `{ fields }` object at the whole-schema,
 * `input`/`output`, or per-slot level) into per-slot values: a validator, a
 * class, or unset. A field list is synthesized into one `SchemaClass` per
 * position — once, because `shorthandFieldsOf` is keyed on class identity, so
 * resolving one shorthand twice would read back inconsistently downstream.
 * `input`'s whole-position shorthand covers `create`/`update`/`patch`, never
 * `query`; `output`'s covers `item`/`list`.
 */
export function normalizeEntitySchema(schema: EntitySchema<any> | undefined): {
  readonly input: Partial<Record<SchemaInputSlot, NormalizedSlot>>;
  readonly output: Partial<Record<SchemaOutputSlot, NormalizedSlot>>;
} {
  const resolveSlot = (value: unknown): NormalizedSlot =>
    isFieldsShorthand(value) ? (resolveSchemaClassSlot(value) ?? undefined) : (value as NormalizedSlot);
  const whole = isSchemaShorthand(schema) || isFieldsShorthand(schema) ? resolveSlot(schema) : undefined;
  const map = (whole !== undefined ? { input: whole, output: whole } : (schema ?? {})) as EntitySchemaMap<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  >;
  const inputWhole = isSchemaShorthand(map.input) || isFieldsShorthand(map.input) ? resolveSlot(map.input) : undefined;
  const outputWhole =
    isSchemaShorthand(map.output) || isFieldsShorthand(map.output) ? resolveSlot(map.output) : undefined;
  const inputMap = (inputWhole !== undefined ? {} : (map.input ?? {})) as Partial<Record<SchemaInputSlot, unknown>>;
  const outputMap = (outputWhole !== undefined ? {} : (map.output ?? {})) as Partial<Record<SchemaOutputSlot, unknown>>;
  return {
    input: {
      create: inputWhole ?? resolveSlot(inputMap.create),
      update: inputWhole ?? resolveSlot(inputMap.update),
      patch: inputWhole ?? resolveSlot(inputMap.patch),
      query: resolveSlot(inputMap.query),
    },
    output: {
      item: outputWhole ?? resolveSlot(outputMap.item),
      list: outputWhole ?? resolveSlot(outputMap.list),
    },
  };
}

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
 * Bootstrap-cached schema resolution, each slot resolves independently: the explicitly
 * registered schema, or `null` meaning "no schema configured — no input
 * validation, no output narrowing beyond whatever `schema`/the entity-derived
 * default already does."
 *
 * `patch` falls back to the registered `update` schema when unset (the
 * same fallback `schema.input.patch` has); `list` falls back
 * to `item`. `create`/`query` have no fallback of their own.
 *
 * Resolution declares its return type as the wider `SchemaLike<object> |
 * null`: a class-shaped slot is accepted and stored here, and `kavo-engine.ts` branches on kind (`isSchemaClass`)
 * before ever calling `safeParse`.
 */
export interface SchemaResolver<_Entity = unknown> {
  resolveInput(slot: SchemaInputSlot, operation: OperationId): SchemaLike<object> | null;
  resolveOutput(slot: SchemaOutputSlot, operation: OperationId): SchemaLike<object> | null;
  /**
   * The writable-field allowlist synthesized from the top-level
   * `create.fields`/`update.fields` config, independent of whether a
   * validator occupies the slot. The deserializer narrows the body with it
   * first; a validator only then judges the narrowed body, so a lenient
   * validator can never widen what `create.fields` excluded. `patch` shares
   * `update`'s list. `null` when no `fields` list is configured.
   */
  resolveWriteAllowlist(slot: "create" | "update" | "patch"): SchemaClass | null;
}

/**
 * `schema.input.create`/`.update`'s writable-fields fallback source — the
 * same top-level `create.fields`/`update.fields` config `resolveEntityConfig`
 * already resolves and passes to `DefaultSchemaResolver`.
 */
export interface WritableSchemaFieldsConfig<Entity> {
  readonly create?: WriteFieldsConfig<Entity>;
  readonly update?: WriteFieldsConfig<Entity>;
}

/**
 * Synthesizes a `SchemaClass` from a `WriteFieldsConfig`'s `fields` array —
 * the create/update writable-fields fallback. Only the plain
 * array form is accepted here: the `{ exclude }` form is resolved to a
 * concrete array by `resolveEntityConfig` before it ever reaches this
 * resolver (the same division of labor as here), so
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
  private readonly input: Readonly<Record<SchemaInputSlot, SchemaLike<object> | null>>;
  private readonly output: Readonly<Record<SchemaOutputSlot, SchemaLike<object> | null>>;
  private readonly writeAllowlist: Readonly<Record<"create" | "update" | "patch", SchemaClass | null>>;

  constructor(schema?: EntitySchema<Entity>, writable: WritableSchemaFieldsConfig<Entity> = {}) {
    const { input, output } = normalizeEntitySchema(schema);
    const patch = input.patch;
    const update = input.update;
    const item = output.item;
    const list = output.list;
    const resolvedUpdate = update ?? writableFieldsToSchemaClass(writable.update?.fields) ?? undefined;
    const createAllowlist = writableFieldsToSchemaClass(writable.create?.fields);
    const updateAllowlist = writableFieldsToSchemaClass(writable.update?.fields);
    this.writeAllowlist = Object.freeze({ create: createAllowlist, update: updateAllowlist, patch: updateAllowlist });
    this.input = Object.freeze({
      create: (input.create ??
        writableFieldsToSchemaClass(writable.create?.fields) ??
        null) as SchemaLike<object> | null,
      update: (resolvedUpdate ?? null) as SchemaLike<object> | null,
      patch: (patch ?? resolvedUpdate ?? null) as SchemaLike<object> | null,
      query: (input.query ?? null) as SchemaLike<object> | null,
    });
    this.output = Object.freeze({
      item: (item ?? null) as SchemaLike<object> | null,
      list: (list ?? item ?? null) as SchemaLike<object> | null,
    });
  }

  resolveInput(slot: SchemaInputSlot, _operation?: OperationId): SchemaLike<object> | null {
    return this.input[slot];
  }

  resolveOutput(slot: SchemaOutputSlot, _operation?: OperationId): SchemaLike<object> | null {
    return this.output[slot];
  }

  resolveWriteAllowlist(slot: "create" | "update" | "patch"): SchemaClass | null {
    return this.writeAllowlist[slot];
  }
}

/**
 * Per-operation schema override (the `schema`-typed sibling of
 * `OperationDtoOverride`, issue #131): `operations.<id>.schema.<field>` →
 * root `schema.input.<slot>`/`schema.output.<slot>` → entity-derived
 * default, the same three-tier fallback chain `schema` has.
 *
 * Unlike `OperationDtoOverride`, this is not narrowed per standard
 * operation id via `Pick` — every field is simply optional here, and which
 * ones are meaningful for a given id is enforced at bootstrap
 * (`resolveSchemaOverride`, `default-operation-registry.ts`), the runtime
 * mirror of the same check `DTO_OVERRIDE_FIELDS` makes for `schema`.
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
 * `schema`-typed reading here.
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
