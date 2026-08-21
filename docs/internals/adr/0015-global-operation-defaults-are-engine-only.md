# ADR-0015 — Global operation defaults are enforced by the engine, not decoration-time routing

**Status:** accepted (issue #38); the precedence described below applies
only when the entity's own `operations` key is absent — see the
issue #257 note at the end.

## Context

Disabling an operation was, until now, only an entity-scope decision
(`operations: { deleteOne: false }` in each `createCrud`/`@Kavo` config).
Apps that want a conservative default — read-mostly APIs, admin-only
writes — had to repeat the same block on every entity. This adds a
global `KavoSettings.operations` boolean map, resolved through the
existing `built-in → global → entity → operation` precedence chain
(`resolveEntityConfig`) and fed into `createOperationRegistry`'s
existing `enabled` resolution as one more fallback rung, ahead of the
unconditional/soft-delete default and behind the entity's own
`operations.<id>`.

The complication is the same one ADR-0012 already names: `@kavo/nest`
generates routes at **class-decoration time** (import time), strictly
before `KavoModule.forRootAsync`'s (sync or async) factory ever runs —
decoration is the only moment Nest's router scan can see the generated
methods, and there is no bootstrap-time value to read yet. A global
operations default therefore cannot reach the router the way an
entity-level `operations.<id>: false` already does (no route generated
at all): the value that would disable the route simply does not exist
when the route is generated.

The alternative — deferring `@kavo/nest` route generation to a
bootstrap-time step that has seen `forRootAsync`'s options — is a
DX option ADR-0012 already reserves as a possible future
change. Chasing it here would turn a config-schema addition into a
routing-architecture rewrite for a case (global operation-enablement
defaults) that doesn't need the route removed, only the request refused.

## Decision

A global `defaults.operations.<id>` reaches **only** the engine/service
side of the split: `createKavo`'s `createCrud` resolves it through
`resolveEntityConfig` and passes it to `createOperationRegistry`, which
every `DefaultKavoService` call and every `engine.execute(...)` custom
dispatch goes through. `@kavo/nest`'s route generation
(`kavo.decorator.ts`) calls `createOperationRegistry` the same way it
always has — two arguments, entity config only, no global value — so it
keeps computing `enabled` from exactly what it could see before this
change.

The result is a deliberate split: an entity that doesn't override a
globally-disabled operation still gets the route (decoration couldn't
know to skip it), but calling that route always resolves through the
bound service, which does know the global default, and throws
`OperationDisabledException` (`KAVO_OPERATION_DISABLED`, HTTP 405) via
the existing problem-details path — never a silent 2xx, and never a
bare 404 that would suggest the route was never there.

An entity that wants the route itself to disappear still states so in
its own `operations.<id>: false`, exactly as before this change —
nothing about entity-level disabling changes.

## Consequences

- A global default is a _behavioral_ switch, not a _routing_ switch. Apps
  that need the route to vanish (e.g. to keep it out of generated
  OpenAPI docs) must still say so per entity; the global default only
  guarantees the operation cannot execute.
- The two registry builds (engine, router) stay independently correct
  for what each can see, the same discipline ADR-0013 established for
  soft-delete operations — this ADR generalizes that pattern to an
  arbitrary global boolean rather than adding a second special case.
- If a future change moves `@kavo/nest` route generation behind a
  bootstrap-time registration (ADR-0012's reserved option), this gap
  closes for free — nothing about the config shape here needs to change,
  only where `createOperationRegistry` is called from.

## Update (issue #257)

Declaring an entity's `operations` key at all now makes it an exclusive
whitelist: every standard id the entity doesn't name is off, regardless
of what the global default says about it. The "ahead of the
unconditional/soft-delete default and behind the entity's own
`operations.<id>`" precedence in Context, and "an entity that doesn't
override a globally-disabled operation still gets the route" in
Decision, hold only for an entity whose `operations` key is absent
entirely. The moment it's present, the global default is bypassed for
every id the entity doesn't name, not merely overridden for the ids it
does — see `docs/internals/architecture/08-configuration.md` §"operations
is a special case" for the current resolution rule.
