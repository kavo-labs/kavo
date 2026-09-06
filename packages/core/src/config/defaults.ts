import type { KavoSettings } from "./settings.js";

/**
 * The built-in defaults — the base of the precedence chain
 * `built-in defaults → global → entity → operation → per-call`.
 * The zero-config `createCrud(Entity)` path runs on exactly these values.
 *
 * Field-group defaults and ceilings (`filter`, `sort`, `select`, `search`,
 * `include` — issue #386) are not here: they are entity-scope-only and
 * resolved directly from `EntityConfig` by `resolve-entity-config.ts`, with
 * their own built-in fallbacks (`BUILT_IN_FILTER_LIMITS` etc.) — there is no
 * global default for them. Per-relation config (`EntityConfig.relations` —
 * issue #404, replacing `relations.edges` and `arrayMutation`) is the same:
 * entity-scope-only, resolved by `DefaultRelationRegistry`, no global default.
 */
export const BUILT_IN_DEFAULTS: KavoSettings = Object.freeze({
  pagination: Object.freeze({
    defaultLimit: 20,
    maxLimit: 100,
    strategy: "offset",
    count: true,
    // The documented convention (ADR-0022): only consulted under
    // `strategy: "since"`, where a missing 'updatedAt' column is a
    // bootstrap `ConfigurationException`, not a silent fallback.
    since: Object.freeze({ field: "updatedAt" }),
  }),
  errors: Object.freeze({
    exposeInternals: false,
  }),
  // Off by default. A full object rather than `false` — like `delete`'s
  // default — so a partial `cache: { ttl: 60 }` override merges against a
  // complete base instead of replacing a `false` wholesale. `ttl`'s
  // presence is the switch: omitted (the default) means off, and any
  // positive `ttl` in an override means on — there is no separate `enabled`
  // key and no magic number to remember. `etag` defaults to `true`: the
  // conditional-request machinery serves independently of the result cache.
  // The store itself lives outside this tree entirely
  // (`KavoOptions.cacheStore`), the same way realtime transports do (see
  // `RealtimeSettings`'s doc).
  cache: Object.freeze({
    // On by default: an `ETag` on every single-item response costs one hash
    // of a representation that was going to be serialized anyway, and a
    // client that sends no conditional header pays nothing beyond it.
    etag: true,
  }),
  // `auto`: soft for entities carrying the marker field, hard for the rest
  // nothing to configure for entities that aren't
  // soft-deletable.
  delete: Object.freeze({
    field: "deletedAt",
    strategy: "auto" as const,
  }),
  // Off by default, the same `false` sentinel `delete`/`cache` use at
  // this scope. Registered transports live outside this tree entirely
  // (`KavoOptions.realtimeTransports` — see `RealtimeSettings`'s doc), so
  // there is nothing transport-shaped to default here.
  realtime: false,
  // Unset: today's `STANDARD_OPERATIONS` enabled-by-default behavior (and
  // ADR-0013's soft-delete-driven `restoreOne` auto-enable) is unchanged
  // for apps that don't set a global default.
  operations: Object.freeze({}),
  // Off by default (ADR-0033): an operation with no `policy.<id>` entry
  // runs unrestricted, today's behavior, until an app opts in.
  authorization: Object.freeze({
    required: false,
  }),
});
