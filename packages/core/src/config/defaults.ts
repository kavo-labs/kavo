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
  limits: Object.freeze({
    filterDepth: 3,
    inValues: 100,
    likePattern: 200,
    includeDepth: 2,
    includedNodes: 10,
  }),
  // Off by default, the same `false` sentinel `softDelete`/`realtime` use:
  // `search[query]` is rejected until an entity or operation scope sets an
  // object, even though `searchable`'s own default is permissive (doc 05
  // §4). Any object turns it on; `mode`/`driver` are backfilled from
  // `substring`/`orm` in `resolveEntityConfig`.
  search: false,
  errors: Object.freeze({
    exposeInternals: false,
  }),
  relations: Object.freeze({
    // Inclusion is opt-in: with no edges configured, `include=` has
    // nothing to reach.
    edges: Object.freeze({}),
  }),
  // Unset: today's no-`sort`-means-no-`ORDER BY`, no-`select=`-means-every-
  // selectable-field, and no-`include=`-means-nothing-included behavior is
  // unchanged for apps that don't declare a default (issue #375).
  defaults: Object.freeze({
    sort: Object.freeze([]),
    include: Object.freeze([]),
  }),
  // Off by default. A full object rather than `false` — like `softDelete`'s
  // default — so a partial `cache: { ttl: 60 }` override merges against a
  // complete base instead of replacing a `false` wholesale. `ttl` is the
  // switch: `0` (the default) means off, and any positive `ttl` in an
  // override means on — there is no separate `enabled` key and no presence
  // rule to remember. `etag` defaults to `true`: the conditional-request
  // machinery serves independently of the result cache.
  // The store itself lives outside this tree entirely
  // (`KavoOptions.cacheStore`), the same way realtime transports do (see
  // `RealtimeSettings`'s doc).
  cache: Object.freeze({
    ttl: 0,
    // On by default: an `ETag` on every single-item response costs one hash
    // of a representation that was going to be serialized anyway, and a
    // client that sends no conditional header pays nothing beyond it.
    etag: true,
  }),
  // `auto`: soft for entities carrying the marker field, hard for the rest
  // nothing to configure for entities that aren't
  // soft-deletable.
  softDelete: Object.freeze({
    field: "deletedAt",
    strategy: "auto" as const,
  }),
  // Off by default, the same `false` sentinel `softDelete`/`cache` use at
  // this scope. Registered transports live outside this tree entirely
  // (`KavoOptions.realtimeTransports` — see `RealtimeSettings`'s doc), so
  // there is nothing transport-shaped to default here.
  realtime: false,
  // No default strategy (issue #221 amends ADR-0029): the key is never
  // consulted unless a relation opts in via `relations.edges.<name>.write`,
  // and once one does, `validateArrayMutationRelations`
  // (`resolve-entity-config.ts`) demands an explicit `strategy` rather than
  // silently assuming one. The empty object — not `false` — is still the
  // base, so a partial `arrayMutation: {...}` override merges against a
  // complete base instead of replacing a `false` wholesale, the same
  // "harmless default" reasoning `cache`'s `ttl: 0` object default documents.
  arrayMutation: Object.freeze({}),
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
