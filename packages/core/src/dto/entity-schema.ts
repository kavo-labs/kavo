import type { KavoSchema } from "./kavo-schema.js";
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
 * Per-entity schema registration — the `schema` key of `createCrud`'s
 * config. Mirrors `dto`'s slot convention exactly (ADR-0055's own
 * decision), split into `input`/`output` rather than one flat map: `input`
 * feeds the engine's deserialization stage, `output` feeds response
 * mapping at serialization — the two never run at the same pipeline stage,
 * so keeping them apart avoids a single map whose keys mean different
 * things depending on which slot you're looking at.
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
  readonly input?: {
    readonly create?: KavoSchema<CreateOut>;
    readonly update?: KavoSchema<UpdateOut>;
    readonly patch?: KavoSchema<PatchOut>;
    readonly query?: KavoSchema<QueryOut>;
  };
  readonly output?: {
    readonly item?: KavoSchema<ItemOut>;
    readonly list?: KavoSchema<ListOut>;
  };
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

  constructor(schema?: EntitySchemaMap<Entity>) {
    const input = schema?.input ?? {};
    const output = schema?.output ?? {};
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
