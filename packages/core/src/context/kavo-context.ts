import type { OperationId } from "../operations/operation.js";
import type { RepositoryAdapter } from "../persistence/repository-adapter.js";
import type { ResolvedEntityConfig } from "../config/resolved-entity-config.js";
import type { NormalizedQueryContext } from "../query/query-context.js";
import type { TransactionContext } from "../persistence/transaction-manager.js";

/**
 * A typed key into the per-request state bag. The phantom type parameter
 * ties `set`/`get` to the same value type without casts:
 *
 * ```ts
 * const AuditStart = Symbol("auditStart") as StateKey<Date>;
 * context.state.set(AuditStart, new Date());
 * const started = context.state.get(AuditStart); // Date | undefined
 * ```
 */
export type StateKey<T> = symbol & { readonly __stateType?: T };

/** Typed per-request state bag for custom handlers to pass data. */
export interface KavoContextState {
  get<T>(key: StateKey<T>): T | undefined;
  set<T>(key: StateKey<T>, value: T): void;
  has(key: StateKey<unknown>): boolean;
}

/**
 * The per-request context threaded through the whole pipeline —
 * one object carrying identity, resolved config, and request-scoped state.
 */
export interface KavoContext<Entity = unknown> {
  readonly entityName: string;
  readonly operation: OperationId;
  readonly config: ResolvedEntityConfig<Entity>;
  /**
   * This entity's repository adapter — the reads and writes every handler
   * runs against, built-in and custom alike (ADR-0025).
   *
   * It is here because the context is the only thing a handler is handed.
   * A built-in handler could be given the adapter when it is constructed,
   * since `createCrud` builds it where the adapter already exists; a
   * handler supplied through `operations.<id>.handler` is built by the
   * caller, and under `@Kavo` that is class-decoration time (ADR-0012),
   * before the infrastructure a `KavoModule.forRootAsync` factory produces
   * exists at all. Threading it through the request is what lets both be
   * written the same way.
   *
   * Adapter methods take a context of their own, so a handler passes this
   * same context back — `context.repository.patch(id, data, context)` —
   * which is how the call inherits the active transaction, the resolved
   * soft-delete strategy and the per-call settings view. It is the entity's
   * own adapter and nothing wider: a cross-entity write is still the
   * application's to make, through whatever it uses to reach the other
   * entity.
   *
   * Both halves are present on a read as well as a write.
   * `OperationKind` decides the request's shape (query resolution, `@Query`
   * versus `@Body`), never what a handler is permitted to do.
   */
  readonly repository: RepositoryAdapter<Entity>;
  /**
   * The authenticated caller — opaque to core, and available to custom
   * operation handlers and computed-field resolvers. Core never inspects
   * it and never populates it: it is whatever the caller put in
   * `KavoCallOptions.principal`, and `null` when nothing did.
   *
   * A programmatic caller passes it per call
   * (`crud.findOne(id, query, { principal })`). Over HTTP it is the
   * framework layer's job, and `@kavo/nest` does it only when the app has
   * said where the caller lives — `KavoModule.forRoot({ principal: true })`
   * for `request.user`, or an extractor function for anything else.
   * Without that option a generated route sends no options at all and this
   * stays `null`.
   */
  readonly principal: unknown;
  /** Active transaction, if any; `null` outside transactions. */
  readonly transaction: TransactionContext | null;
  /** Parsed, validated query — read operations only; `null` for writes. */
  readonly query: NormalizedQueryContext<Entity> | null;
  readonly correlationId: string;
  readonly state: KavoContextState;
}
