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
 *     userId?: string;
 *     roles?: string[];
 *     tenantId?: string;
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
 * **Declare every field optional** unless an extractor is guaranteed to fill
 * it: Kavo types `context.app` as fully populated regardless of what the
 * request carried, so a required field is a `string` at compile time and
 * `undefined` at run time on any request with no (or a partial) `app`
 * extractor — including every GraphQL/MCP call.
 *
 * **Put only plain, shallow data here** — the fields policies and computed
 * fields read, not a framework/ORM object passed straight through. With the
 * result cache on, `context.app` is walked by `canonicalize` into the cache
 * key on every cacheable read: a value with prototype getters (a Passport
 * user class, a TypeORM entity, a class-transformer instance) canonicalizes
 * to the same string for every caller, collapsing them onto one cache
 * bucket; a deeply nested or cyclic value is a per-read cost or a stack
 * overflow. Build a plain object in the extractor / `KavoCallOptions.app`.
 *
 * Treat it as read-only inside a handler: a request that carries no app
 * context is handed a shared frozen `{}`, so a write either throws or is a
 * silent no-op depending on the caller's strict-mode.
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
