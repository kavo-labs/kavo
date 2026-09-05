---
name: add-config-key
description: How to add a new key to KavoSettings — schema, default, merge semantics, validation, and docs — through the one layered precedence chain (global → entity → operation → per-call). Use when a change needs a new configurable behavior rather than a hardcoded constant.
---

# Adding a config key

Kavo has **one** configuration mechanism: `KavoSettings`, merged through a
single precedence chain (`docs/internals/architecture/08-configuration.md`):

```
built-in defaults → global (createKavo) → entity (createCrud)
                  → operation (operations.<id>) → per-call (KavoCallOptions)
```

The schema-extensibility rule (doc 08 §1) is normative: **feature work adds
keys to this schema — it never adds a second config mechanism.** If you find
yourself threading a new constructor parameter or a separate options object
through the engine, stop; it belongs in `KavoSettings`.

## Where the pieces live

1. **`BUILT_IN_DEFAULTS`** (`packages/core/src/config/defaults.ts`) — add the
   key with its default value. Every key needs one; there is no "unset" state
   a resolved config can observe.
2. **The settings type** — extend the `KavoSettings` interface/schema so the
   new key is typed at every scope (global defaults, entity config,
   `operations.<id>` overrides, `KavoCallOptions.settings`).
3. **`mergeSettings`** (`packages/core/src/config/merge-settings.ts`) — confirm
   the new key's shape matches the existing merge semantics rather than
   inventing a new one:
   - scalars and object-as-value keys: nearer scope replaces farther scope,
     key by key;
   - `false` disables an inheritable feature where the schema allows it
     (follow the `softDelete` / `operations.<id>` pattern) — a nearer object
     re-enables it;
   - arrays replace wholesale, never merge element-wise;
   - `undefined` at any scope is skipped, not treated as an explicit override.
4. **`validateSettings`** — add bootstrap validation that fails with a
   `ConfigurationException` naming **the entity, the key path, and the
   offending value** (doc 08 §4's message shape is the bar:
   `Invalid configuration for entity 'User' at 'pagination.maxLimit': ...`).
   Validation runs once at bootstrap (`resolveEntityConfig`), not per request
   — the resolved config is deep-frozen afterward, so this is the only chance
   to catch a bad value before it's baked in.
5. **`describeResolvedConfig`** — check whether the new key should surface in
   `kavo.describe(entityName)`'s debug dump; most settings keys should.

## Naming

Config keys are camelCase, and booleans are phrased positively —
`exposeInternals`, never `hideInternals` (CLAUDE.md Conventions). A boolean
key that reads as a double negative when combined with `false`-to-disable
semantics is a naming bug, not just a style nit.

## Tests

Per the `write-tests` skill, at minimum:

- the new key's default value takes effect with nothing overriding it;
- each scope in the precedence chain actually overrides the one before it
  (a test that only checks global-vs-default misses entity/operation/
  per-call regressions);
- `false`-disables-then-nearer-re-enables, if the key supports that;
- bootstrap validation rejects an invalid value with `ConfigurationException`
  and the right code, naming the entity and key path;
- if the key is per-call (`KavoCallOptions.settings`), that it's merged as a
  parameter for that request only and never mutates the frozen resolved
  config for subsequent calls.

Finish with `pnpm check`.

## Docs

Update `docs/internals/architecture/08-configuration.md`'s key table (§1) —
it's the single source of truth for what's configurable, and a key missing
from it is invisible to the next reader. If the key represents a new
load-bearing precedent (not just a parameter on an existing mechanism),
see the `add-adr` skill.

## Allowlist-style keys are a different mechanism — don't force them in here

`EntityConfig.allowlists` (`filterable`/`sortable`/`selectable`/`includable`/
`searchable`/`creatable`/`updatable`) is declared on `EntityConfig` directly,
**not** on `KavoSettings` — there is no global default, no per-operation
override, and none of the merge machinery above applies. A key belongs here
instead of in `KavoSettings` when its job is to name a **subset of the
entity's own fields or relations that a request may touch**, rather than to
tune a behavior. Issue #259 (`creatable`/`updatable`, narrowing the writable
projection for `createOne`/`updateOne`/`patchOne`) is a worked example of
adding one:

1. **The raw selector type** (`packages/core/src/config/entity-config.ts`) —
   an array-or-`{ exclude }` shape typed against the right path depth.
   `QueryFieldSelector<Entity>` (`FieldPath<Entity>`, depth 3) for a key that
   can name a dotted relation path; a depth-1 `FieldPath<Entity, 1>` selector
   (see `WritableFieldSelector`) for a key that only ever grants one field or
   relation segment, the way a write body does. Add the key to
   `QueryAllowlists`, documented with its default posture (does it default to
   "every own column", like `filterable`, or opt-in like `includable`?) and
   its narrowing/precedence relationship to any nearby DTO-based override.
2. **The resolved type** (`resolved-entity-config.ts`) — add the frozen,
   always-array field to `ResolvedQueryAllowlists`.
3. **`resolveAllowlists`** (`resolve-entity-config.ts`) — compute the key's
   **base set** (what it means unconfigured) from `EntityMetadata`, and
   resolve the configured selector against that base with
   `resolveFieldSelector` (generic over the path type, so it serves both
   depth-3 and depth-1 selectors already). If the key can never legally name
   an ORM-derived field (as `creatable`/`updatable` can't — a derived field
   has no writable storage, ADR-0046), reject one at bootstrap with a
   `ConfigurationException`, the same way `searchable`
   already rejects one unconditionally.
4. **Where the resolved list actually gates something** — an allowlist key is
   inert until some consumer reads it. `creatable`/`updatable` are read in
   `DefaultDeserializer.deserialize` (per call, off `context.config.allowlists`,
   keyed by `context.operation`) — find or add the analogous read site for a
   new key, and decide its **DTO precedence**: does a registered DTO with a
   runtime shape still win outright (the `selectable`-vs-`dto.item` precedent,
   ADR-0026), or does the new key gate something no DTO already governs?
5. **The core barrel** (`index.ts`) — a new selector type is a new public
   type; add it to the explicit list (ADR-0010), and to
   `tests/barrel.spec.ts`'s manifest.
6. **Docs** — `docs/features/allowlists.md` (the adopter-facing guide) and
   `docs/reference/config-keys.md`'s `## allowlists` table, not
   `08-configuration.md` — that document is `KavoSettings` only.

Tests follow the same shape as `write-tests` describes for a `KavoSettings`
key, minus the per-call/operation-override cases that don't apply here: the
default derivation, an explicit array used verbatim, the `{ exclude }` form
resolved against the base (not "every column"), the ORM-derived-field rejection
if applicable, and — for a key with a consumer — that the consumer actually
narrows behavior and that any unconditional exclusion it must respect (an id,
a soft-delete marker) survives even when the list names it explicitly.
