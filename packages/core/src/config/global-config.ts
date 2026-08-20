import type { KavoSettings } from "./settings.js";
import type { DeepPartial } from "../types/utility.js";
import type { PolicyNode } from "../policy/kavo-policy.js";

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
   * Framework-wide default policy (ADR-0036, amending ADR-0032/ADR-0033):
   * applied to every operation on every entity that configures no `policy`
   * of its own, at either entity scope (`EntityConfig.policy`) or operation
   * scope (`OperationConfig.policy`) — nearest scope wins, wholesale, not a
   * field-by-field merge.
   *
   * Deliberately **not** a `KavoSettings` field, even though this is the
   * settings tree's global-scope home: `PolicyNode` is a discriminated
   * union, and `DeepPartial` (what `defaults` is typed as) partializes every
   * branch independently, which would erase the discriminant and admit a
   * malformed node the type system can no longer catch. `policy` stays a
   * structural field at every scope it is configured on, `defaults` included
   * — the same reason `EntityConfig.policy`/`OperationConfig.policy` sit
   * beside `DeepPartial<KavoSettings>` rather than inside it.
   *
   * `operations.<id>.policy: false` still overrides this (or an entity's
   * own `policy`) back to unrestricted for that one operation. There is
   * still no per-call override — a per-call parameter that could loosen a
   * policy would let a caller weaken its own authorization (ADR-0032).
   */
  readonly policy?: PolicyNode;
}
