import type { EntityId } from "../types/entity-id.js";
import type { ListResultDto } from "../dto/list-result.js";
import type { StandardOperationId } from "../operations/operation.js";
import type { DtoInputOf, DtoOutputOf, OperationEntryOf } from "../dto/dto.js";

/**
 * The typed surface for a **custom** operation (issue #145) — everything
 * `KavoService.run` needs to give an id it has never heard of the same
 * static shape the eight named methods have.
 *
 * Every type here reads the `Ops` literal `EntityConfig.operations` was
 * inferred from, the same source `DtoInputOf`/`DtoOutputOf`/`DtoQueryOf`
 * (`dto/dto.ts`) already read for the standard eight. Where those fall back
 * to an entity-wide DTO generic, these fall back to the **registered
 * handler's own signature**: a custom operation has no entity-wide slot of
 * its own, and the handler is the one place its shapes are stated.
 */

/**
 * The input the registered handler declares, or `unknown` when the entry
 * was written against the wide `OperationHandler<Entity>` type and states
 * nothing more specific.
 *
 * `execute` is a method, so its parameter is compared bivariantly and a
 * narrower declared input still satisfies `OperationHandler<Entity>` —
 * which is exactly what leaves the literal here to infer from.
 */
type HandlerInputOf<Ops, Id extends string> =
  OperationEntryOf<Ops, Id> extends { readonly handler: { execute(input: infer In, ...rest: never): unknown } }
    ? In
    : unknown;

/** The value the registered handler resolves to, by the same route. */
type HandlerOutputOf<Ops, Id extends string> =
  OperationEntryOf<Ops, Id> extends { readonly handler: { execute(...args: never): Promise<infer Out> } }
    ? Out
    : unknown;

/**
 * The row type inside a many-cardinality handler's `FindManyResult`, so a
 * custom list operation's envelope is typed by its elements rather than by
 * the whole result shape.
 */
type RowOf<Result> = Result extends { readonly entities: readonly (infer Row)[] } ? Row : unknown;

/** Every custom id declared on `Ops`, or `never` when there are none. */
type DeclaredCustomIds<Ops> = Exclude<Extract<keyof Ops, string>, StandardOperationId>;

/**
 * Which ids `run` accepts: the custom ids the config declared, so they
 * complete and a typo is caught.
 *
 * It widens to `string` when the config declared none — which covers the
 * two ways a service arrives with nothing to read: a config of standard
 * operations only, and an *erased* service type (`DefaultKavoService<Book>`
 * with no `Ops` argument, which is how `getKavoServiceToken` hands one to a
 * constructor). Narrowing to `never` there would make `run` uncallable on
 * the service most applications actually hold, so the unknown case stays
 * open and the engine answers a wrong id with
 * `OperationNotRegisteredException`.
 */
export type CustomOperationId<Ops> = [DeclaredCustomIds<Ops>] extends [never] ? string : DeclaredCustomIds<Ops>;

/**
 * The request body a custom operation takes: its `dto.input` override when
 * it declares one (the class the engine deserializes into), else what its
 * handler declares — unwrapped from the `{ id, body }` pair the engine
 * hands an id-addressed operation, since `id` is passed separately here.
 */
export type CustomOperationBody<Ops, Id extends string> = DtoInputOf<
  Ops,
  Id,
  HandlerInputOf<Ops, Id> extends { readonly id: unknown; readonly body: infer Body } ? Body : HandlerInputOf<Ops, Id>
>;

/**
 * What `run` resolves to: the `dto.output` override when declared, else the
 * handler's own return type — wrapped in the list envelope for a
 * `cardinality: "many"` operation, which is mapped through the same
 * `ListResultDto` path `findMany` is.
 */
export type CustomOperationResult<Ops, Id extends string> =
  OperationEntryOf<Ops, Id> extends { readonly cardinality: "many" }
    ? ListResultDto<DtoOutputOf<Ops, Id, RowOf<HandlerOutputOf<Ops, Id>>>>
    : DtoOutputOf<Ops, Id, HandlerOutputOf<Ops, Id>>;

/**
 * The request half of a `run` call — the members of `KavoRequest` a caller
 * supplies, with the operation and the per-call options passed as their own
 * arguments. Every member is optional because a custom operation decides
 * for itself which it uses: `id` when its route targets one row, `body` on
 * a write, `query` on a read.
 */
export interface CustomOperationRequest<Id extends EntityId = EntityId, Body = unknown, Query = unknown> {
  /** The target row, for an operation routed under `:id`. */
  readonly id?: Id;
  /** The write payload, deserialized through the operation's input DTO. */
  readonly body?: Body;
  /** The read query, normalized exactly as `findOne`/`findMany`'s is. */
  readonly query?: Query;
}
