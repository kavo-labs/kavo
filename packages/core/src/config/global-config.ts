import type { KavoSettings } from "./settings.js";
import type { DeepPartial } from "../types/utility.js";
import type { Policy } from "../policy/kavo-policy.js";

/**
 * Raw global (framework-scope) configuration — the argument to
 * `createKavo`. The bare `createCrud(Entity)` zero-config path is an
 * implicit root instance of this with built-in defaults; nothing about
 * global config may tax the zero-config case.
 */
export interface GlobalConfig {
  /** Framework-wide defaults, merged below entity/operation scope. */
  readonly defaults?: DeepPartial<KavoSettings>;
  /**
   * Framework-wide default policy (ADR-0037): applied to every operation on
   * every entity that configures no `policy` of its own, at either entity
   * scope (`EntityConfig.policy`) or operation scope
   * (`OperationConfig.policy`) — nearest scope wins, wholesale, not a
   * field-by-field merge.
   *
   * Deliberately **not** a `KavoSettings` field, even though this is the
   * settings tree's global-scope home: `defaults` is typed
   * `DeepPartial<KavoSettings>`, and `DeepPartial` recurses into any
   * property type that extends `object` — which a function type does — so
   * `DeepPartial<Policy>` would produce an object type keyed by
   * `Function.prototype`'s own properties (`name`, `length`, `call`, …)
   * instead of a callable function, silently losing the one property that
   * matters. `policy` stays a structural field at every scope it is
   * configured on, `defaults` included — the same reason
   * `EntityConfig.policy`/`OperationConfig.policy` sit beside
   * `DeepPartial<KavoSettings>` rather than inside it.
   *
   * `operations.<id>.policy: false` still overrides this (or an entity's
   * own `policy`) back to unrestricted for that one operation. There is
   * still no per-call override — a per-call parameter that could loosen a
   * policy would let a caller weaken its own authorization.
   */
  readonly policy?: Policy;
}
