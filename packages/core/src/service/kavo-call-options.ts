import type { KavoAppContext } from "../context/kavo-context.js";
import type { KavoSettings } from "../config/settings.js";
import type { DeepPartial } from "../types/utility.js";
import type { RequestPreconditions } from "../caching/etag.js";
import type { TransactionContext } from "../persistence/transaction-manager.js";

/**
 * Per-call scope — the last link of the precedence chain.
 * Overrides are parameters for this one call; configuration is immutable
 * after bootstrap and there is no runtime mutation API.
 */
export interface KavoCallOptions {
  /** Join an existing transaction (the explicit `{ ctx }` parameter). */
  readonly transaction?: TransactionContext;
  /** The application's request-scoped context to expose on `KavoContext.app`. */
  readonly app?: KavoAppContext;
  /** Per-call settings overrides (e.g. a one-off `pagination.count`). */
  readonly settings?: DeepPartial<KavoSettings>;
  /**
   * Conditional-request tokens for this call — how the typed service
   * surface (`service.updateOne(id, data, { preconditions })`) reaches
   * `KavoRequest.preconditions` without every method growing a parameter
   * for it. `KavoRequest.preconditions`, when set, wins.
   *
   * Only the `ifMatch` half does anything here. It is evaluated inside the
   * engine, so a failed precondition surfaces as a thrown
   * `PreconditionFailedException` either way. `ifNoneMatch` is answered by
   * setting `KavoResponse.notModified`, and these methods return
   * `response.item` — so through this surface it is a **no-op**. Reach for
   * `service.engine.execute(...)` when the not-modified answer is the one
   * you need; that is what `@kavo/nest`'s generated routes do.
   */
  readonly preconditions?: RequestPreconditions;
}
