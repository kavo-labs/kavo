import type { KavoSchema } from "../schema/kavo-schema.js";
import type { OperationEntryOf, DtoInputOf, DtoOutputOf, DtoQueryOf } from "./dto.js";
import type { OperationId } from "../operations/operation.js";
import type { EntityInput } from "../types/utility.js";
import type { QueryContext } from "../query/query-context.js";

/**
 * ADR-0055: `schema` is the per-slot, input/output-split counterpart to
 * `dto` — a `KavoSchema<Output>` (the structural contract `kavo-schema.ts`
 * defines) instead of a `DtoClass<Shape>`. Landed additively alongside
 * `dto` rather than replacing it outright: `@kavo/nest`'s OpenAPI
 * generation, route decoration, and body-validation wiring
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
 * `schema.input`'s shorthand: a single {@link KavoSchema} in place of the
 * per-slot map, applied to `create`/`update`/`patch` alike (never `query`,
 * which has its own shape and no natural single-schema reading). Equivalent
 * to writing `{ create: X, update: X, patch: X }` by hand.
 */
export type SchemaInputMap<CreateOut, UpdateOut, PatchOut, QueryOut> =
  | KavoSchema<CreateOut>
  | {
      readonly create?: KavoSchema<CreateOut>;
      readonly update?: KavoSchema<UpdateOut>;
      readonly patch?: KavoSchema<PatchOut>;
      readonly query?: KavoSchema<QueryOut>;
    };

/**
 * `schema.output`'s shorthand: a single {@link KavoSchema} in place of the
 * per-slot map, applied to `item`/`list` alike. Equivalent to writing
 * `{ item: X, list: X }` by hand.
 */
export type SchemaOutputMap<ItemOut, ListOut> =
  | KavoSchema<ItemOut>
  | {
      readonly item?: KavoSchema<ItemOut>;
      readonly list?: KavoSchema<ListOut>;
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
 * Both `input` and `output` accept a single {@link KavoSchema} as shorthand
 * for their whole per-slot map (`SchemaInputMap`/`SchemaOutputMap`), and
 * `EntitySchema` below additionally accepts a single `KavoSchema` in place
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
  readonly input?: SchemaInputMap<CreateOut, UpdateOut, PatchOut, QueryOut>;
  readonly output?: SchemaOutputMap<ItemOut, ListOut>;
}

/**
 * `createCrud`'s `schema` key itself: `EntitySchemaMap`'s `input`/`output`
 * split, or a single {@link KavoSchema} as shorthand for
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
> = KavoSchema<CreateOut> | EntitySchemaMap<Entity, CreateOut, UpdateOut, PatchOut, QueryOut, ItemOut, ListOut>;

/** Structural check: a `KavoSchema` shorthand has `safeParse`, a per-slot map does not. */
function isKavoSchema(value: unknown): value is KavoSchema<unknown> {
  return typeof value === "object" && value !== null && typeof (value as KavoSchema<unknown>).safeParse === "function";
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
 */
export interface SchemaResolver<_Entity = unknown> {
  resolveInput(slot: SchemaInputSlot, operation: OperationId): KavoSchema<unknown> | null;
  resolveOutput(slot: SchemaOutputSlot, operation: OperationId): KavoSchema<unknown> | null;
}

export class DefaultSchemaResolver<Entity = unknown> implements SchemaResolver<Entity> {
  private readonly input: Readonly<Record<SchemaInputSlot, KavoSchema<unknown> | null>>;
  private readonly output: Readonly<Record<SchemaOutputSlot, KavoSchema<unknown> | null>>;

  constructor(schema?: EntitySchema<Entity>) {
    const map: EntitySchemaMap<Entity, unknown, unknown, unknown, unknown, unknown, unknown> = isKavoSchema(schema)
      ? { input: schema, output: schema }
      : (schema ?? {});
    const input = isKavoSchema(map.input)
      ? { create: map.input, update: map.input, patch: map.input }
      : (map.input ?? {});
    const output = isKavoSchema(map.output) ? { item: map.output, list: map.output } : (map.output ?? {});
    this.input = Object.freeze({
      create: input.create ?? null,
      update: input.update ?? null,
      patch: input.patch ?? input.update ?? null,
      query: input.query ?? null,
    });
    this.output = Object.freeze({
      item: output.item ?? null,
      list: output.list ?? output.item ?? null,
    });
  }

  resolveInput(slot: SchemaInputSlot): KavoSchema<unknown> | null {
    return this.input[slot];
  }

  resolveOutput(slot: SchemaOutputSlot): KavoSchema<unknown> | null {
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
  readonly input?: KavoSchema<InputOut>;
  readonly output?: KavoSchema<OutputOut>;
  readonly query?: KavoSchema<QueryOut>;
}

/**
 * The three `Schema*Of` type-inference helpers, the `schema`-typed
 * siblings of `DtoInputOf`/`DtoOutputOf`/`DtoQueryOf`. A `schema` override
 * takes precedence when present (`SchemaOutput<S>`, the structural-contract
 * equivalent of `z.infer`); otherwise falls through to the corresponding
 * `Dto*Of` reading (which itself falls through to `Fallback`) — so a
 * `KavoService` position narrows from whichever of `schema`/`dto` an
 * operation actually configured, without a caller having to declare both.
 */
export type SchemaInputOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly schema: { readonly input: KavoSchema<infer Output> } }
    ? Output
    : DtoInputOf<Ops, Id, Fallback>;

export type SchemaOutputOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly schema: { readonly output: KavoSchema<infer Output> } }
    ? Output
    : DtoOutputOf<Ops, Id, Fallback>;

export type SchemaQueryOf<Ops, Id extends string, Fallback> =
  OperationEntryOf<Ops, Id> extends { readonly schema: { readonly query: KavoSchema<infer Output> } }
    ? Output
    : DtoQueryOf<Ops, Id, Fallback>;
