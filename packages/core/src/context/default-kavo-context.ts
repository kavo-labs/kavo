import type { KavoAppContext, KavoContext, KavoContextState, StateKey } from "./kavo-context.js";
import type { NormalizedQueryContext } from "../query/query-context.js";
import type { OperationId } from "../operations/operation.js";
import type { RepositoryAdapter } from "../persistence/repository-adapter.js";
import type { ResolvedEntityConfig } from "../config/resolved-entity-config.js";
import type { TransactionContext } from "../persistence/transaction-manager.js";

/** Map-backed implementation of the typed per-request state bag. */
export class DefaultKavoContextState implements KavoContextState {
  private readonly values = new Map<symbol, unknown>();

  get<T>(key: StateKey<T>): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T>(key: StateKey<T>, value: T): void {
    this.values.set(key, value);
  }

  has(key: StateKey<unknown>): boolean {
    return this.values.has(key);
  }
}

/**
 * Web Crypto is a runtime global on every supported platform (Node ≥ 20,
 * browsers), but `@kavo/core` compiles against pure ES lib types with
 * zero imports (ADR-0005) — hence the typed accessor instead of a
 * `node:crypto` import.
 */
export function randomUuid(): string {
  return (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();
}

export interface KavoContextInit<Entity> {
  readonly operation: OperationId;
  readonly config: ResolvedEntityConfig<Entity>;
  /**
   * The entity's repository adapter (ADR-0025). Required rather than
   * optional: every handler reaches persistence through it, so a context
   * built without one produces a `TypeError` inside whatever handler runs
   * next, far from whoever built the context. Nothing checks it at run
   * time — the type is the guard, and a caller that erases it gets the
   * deferred failure this shape exists to make unrepresentable.
   */
  readonly repository: RepositoryAdapter<Entity>;
  readonly app?: KavoAppContext;
  readonly transaction?: TransactionContext | null;
  readonly query?: NormalizedQueryContext<Entity> | null;
  readonly correlationId?: string;
}

/** The shared frozen `{}` handed out when a request carries no app context. */
const EMPTY_APP_CONTEXT: KavoAppContext = Object.freeze({});

/**
 * Build the per-request context. The correlation id is generated
 * here when the caller (e.g. a framework layer forwarding an upstream
 * request id) doesn't supply one.
 */
export function createKavoContext<Entity>(init: KavoContextInit<Entity>): KavoContext<Entity> {
  return {
    entityName: init.config.entityName,
    operation: init.operation,
    config: init.config,
    repository: init.repository,
    app: init.app ?? EMPTY_APP_CONTEXT,
    transaction: init.transaction ?? null,
    query: init.query ?? null,
    correlationId: init.correlationId ?? randomUuid(),
    state: new DefaultKavoContextState(),
  };
}
