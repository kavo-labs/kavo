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
 * The application's own request-scoped context — an interface Kavo carries
 * on `KavoContext.app` but never populates, inspects or shapes. It is `{}`
 * until the app widens it by declaration merging:
 *
 * ```ts
 * declare module "@kavo/core" {
 *   interface KavoAppContext {
 *     userId: string;
 *     roles: string[];
 *     tenantId: string;
 *   }
 * }
 * ```
 *
 * One shape per process (the `Express.Request` pattern), not per entity:
 * `@Kavo` is a decorator and cannot infer a generic from a module option,
 * so a global augmented interface is what types every `context.app.*` read.
 * Unaugmented it stays `{}`, and any field read is a compile error — the
 * signal to declare the fields the app actually uses. This is the caller
 * slot the pre-ADR-0043 context carried untyped (ADR-0043).
 *
 * Treat it as read-only inside a handler: a request that carries no app
 * context is handed a shared frozen `{}`, so a write either throws or is a
 * silent no-op depending on the caller's strict-mode. Build the object in
 * the extractor / `KavoCallOptions.app`, don't mutate it downstream.
 */
// oxlint-disable-next-line no-empty-interface -- widened by app declaration merging
export interface KavoAppContext {}

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
   * The application's request-scoped context (`KavoAppContext`) — available
   * to custom operation handlers, computed-field resolvers and policies.
   * Core never inspects, populates or shapes it: it is whatever the caller
   * put in `KavoCallOptions.app`, and an empty object when nothing did.
   *
   * A programmatic caller passes it per call
   * (`crud.findOne(id, query, { app })`). Over HTTP it is the framework
   * layer's job, and `@kavo/nest` fills it only when the app configures an
   * extractor — `KavoModule.forRoot({ app: (request) => request.user })`.
   * Without that option a generated route sends no options at all and this
   * stays `{}`.
   */
  readonly app: KavoAppContext;
  /** Active transaction, if any; `null` outside transactions. */
  readonly transaction: TransactionContext | null;
  /** Parsed, validated query — read operations only; `null` for writes. */
  readonly query: NormalizedQueryContext<Entity> | null;
  readonly correlationId: string;
  readonly state: KavoContextState;
}
