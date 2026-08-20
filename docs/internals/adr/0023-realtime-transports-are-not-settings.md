# ADR-0023 — Realtime transports are resolved config, not settings-tree data

**Status:** accepted

## Context

Realtime event publishing (issue #154) needed a place in the config
precedence chain: `enabled`, per-event toggles (`events`), and a
field-subscription allowlist (`subscribableFields`) are exactly the kind of
plain data every other `KavoSettings` key already holds, merged
`built-in defaults → global → entity → operation` and deep-frozen once
resolved (`deepFreeze`, merge-settings.ts) — the same treatment
`softDelete` or `relations.edges` get.

The obvious place for the list of registered `RealtimeTransport`s (a
WebSocket server, a broker connection — whatever `publish()` an app hands
in) was the same `RealtimeSettings` object, as `transports: readonly
RealtimeTransport[]`. It failed the moment a test registered a real
transport: `resolveEntityConfig` calls `deepFreeze(entitySettings)`, which
recurses into every object reachable from the settings tree and freezes it.
A transport is a live object — internal subscriber maps, buffers, whatever
state its own `publish()` closes over — and `deepFreeze` cannot tell it
apart from a plain `{ field, direction }` sort entry. Freezing it breaks it
silently: `Object.freeze` on an array makes it non-extensible, so a
transport's own `this.events.push(...)` (or a real transport's connection
registry) throws — and that throw lands inside the engine's own
`try { await transport.publish(event) } catch` guard (the "never fails the
mutation" contract), so it fails **silently**, not loudly.

`deepFreeze`'s recursion cannot be made to distinguish "data" from "a live
object with methods" by shape alone — a transport built as a plain object
literal (`{ name, publish: async () => {...} }`, the natural shape for a
small factory function) is structurally indistinguishable from a settings
leaf. Patching `deepFreeze` itself to skip anything with a function-typed
property is fragile and changes shared, load-bearing infrastructure for one
caller's sake.

## Decision

Registered transports are **not** a `KavoSettings` key. They are resolved
once per `createKavo` root, from a new `KavoOptions.realtimeTransports`,
validated at that single point (`kavo.ts`'s `validateRealtimeTransports`,
so a malformed transport fails once at startup, not once per entity that
happens to bootstrap first) and carried on `ResolvedEntityConfig.
realtimeTransports` — structural, resolved config living beside `settings`,
the same relationship `dto`, `computed`, and `relations` already have to
it. Only the **array container** is frozen (`Object.freeze([...transports])`
— shallow, blocking a runtime push/splice), never an element's own state.

This mirrors an existing exception in the same schema: `operations.<id>.
handler` (a live object with an `execute` method) is deliberately excluded
from `SETTINGS_KEYS` — the subset `pickSettings` merges from `EntityConfig`
— for the identical reason. `RealtimeSettings` stays exactly what
`softDelete`/`relations`/every other key already is: enablement and rules,
never behavior.

`RealtimeSettings` keeps `events`, `subscribableFields`, and
`onPublishError` (a function — already safe, since `deepFreeze`'s
`typeof value === "object"` guard never touches functions in the first
place) — the actual configuration, still merged through the normal
precedence chain. `realtime: false` disables the subtree, the same
`false`-disables-the-subtree shape `softDelete` uses; `realtime: { ... }`
(any object) turns it on. Only the live objects moved out.

## Consequences

- A transport is registered once, process-wide (`createKavo({
realtimeTransports: [...] })`), not per entity — matching how transports
  are actually used in practice (one WebSocket server for the whole app),
  and consistent with `infrastructure` being the same kind of once-per-root
  concern.
- The engine reads transports off `context.config.realtimeTransports`, not
  `context.config.settings.realtime.transports` — anyone extending the
  engine hook (a future `@kavo/sse`/`@kavo/rabbitmq`-adjacent concern) reads
  from there, not from settings.
- `deepFreeze` stays untouched, general-purpose, and still safe to assume
  "recurses into pure data" everywhere else it's called.
- Cost: an entity cannot register a _different_ set of transports than the
  root's. If a real need for per-entity transport fan-out shows up, it is a
  new, explicit seam (e.g. an entity-scope `realtimeTransports` override
  resolved the same structural way) — not a reason to put live objects back
  inside `KavoSettings`.
