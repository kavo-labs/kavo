import type { KavoSettings } from "./settings.js";

/**
 * The built-in defaults — the base of the precedence chain
 * `built-in defaults → global → entity → operation → per-call`.
 * The zero-config `createCrud(Entity)` path runs on exactly these values.
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
  query: Object.freeze({
    maxFilterDepth: 3,
    maxInValues: 100,
    // Unset: today's no-`sort`-means-no-`ORDER BY` behavior is unchanged
    // for apps that don't declare a default.
    defaultSort: Object.freeze([]),
    // Off by default: `search[query]` is rejected until an entity or
    // operation opts in explicitly, even though `searchable`'s own default
    // is permissive (doc 05 §4).
    search: Object.freeze({
      enabled: false,
      mode: "substring" as const,
      driver: "orm" as const,
    }),
  }),
  errors: Object.freeze({
    exposeInternals: false,
  }),
  relations: Object.freeze({
    maxIncludeDepth: 2,
    maxIncludedNodes: 10,
    // Inclusion is opt-in: with no edges configured, `include=` has
    // nothing to reach.
    edges: Object.freeze({}),
  }),
  // On by default: an `ETag` on every single-item response costs one hash
  // of a representation that was going to be serialized anyway, and a
  // client that sends no conditional header pays nothing beyond it.
  caching: Object.freeze({
    etag: true,
  }),
  // Off by default. A full object rather than `false` — like `softDelete`'s
  // default — so a partial `cache: { ttl: 60 }` override merges against a
  // complete base instead of replacing a `false` wholesale. The presence
  // rule (ADR-0031) then flips `enabled` for whatever scope wrote the
  // override; `enabled: false` spelled explicitly stays off. The store
  // itself lives outside this tree entirely (`KavoOptions.cacheStore`),
  // the same way realtime transports do (see `RealtimeSettings`'s doc).
  cache: Object.freeze({
    enabled: false,
    ttl: 60,
  }),
  // `auto`: soft for entities carrying the marker field, hard for the rest
  // nothing to configure for entities that aren't
  // soft-deletable.
  softDelete: Object.freeze({
    field: "deletedAt",
    strategy: "auto" as const,
  }),
  // Off by default. A full object rather than `false` — like `softDelete`'s
  // default — so a partial override (`realtime: { events: {...} }`) merges
  // against a complete base instead of replacing a `false` wholesale and
  // dropping `enabled`. Registered transports live outside this tree
  // entirely (`KavoOptions.realtimeTransports` — see `RealtimeSettings`'s
  // doc), so there is nothing transport-shaped to default here.
  realtime: Object.freeze({
    enabled: false,
    events: Object.freeze({}),
  }),
  // No default strategy (issue #221 amends ADR-0029): the key is never
  // consulted unless a relation opts in via `relations.edges.<name>.write`,
  // and once one does, `validateArrayMutationRelations`
  // (`resolve-entity-config.ts`) demands an explicit `strategy` rather than
  // silently assuming one. The empty object — not `false` — is still the
  // base, so a partial `arrayMutation: {...}` override merges against a
  // complete base instead of replacing a `false` wholesale, the same
  // "harmless default" reasoning `realtime`'s object default documents.
  arrayMutation: Object.freeze({}),
  // Unset: today's `STANDARD_OPERATIONS` enabled-by-default behavior (and
  // ADR-0013's soft-delete-driven `restoreOne` auto-enable) is unchanged
  // for apps that don't set a global default.
  operations: Object.freeze({}),
});
