# ADR-0028 — Relation inclusion permission moves into `allowlists.includable`

**Status:** accepted

## Context

`QueryAllowlists` (`filterable`/`sortable`/`selectable`, entity-config.ts) is
where every other request/response permission gate lives, and each key is
typed against the entity's real paths (`FieldPath<Entity>`), so a typo fails
at compile time. `include=` permission lived somewhere else entirely:
`relations.edges.<name>.includable` (`RelationEdgeSettings`, settings.ts), a
plain boolean buried alongside unrelated loading tuning
(`defaultInclude`/`maxDepth`/`strategy`), and typed only as
`Readonly<Record<string, RelationEdgeSettings>>` — a plain string-keyed map,
because `KavoSettings` carries no `Entity` type parameter. A typo'd relation
name there produced no compile error, only a bootstrap
`ConfigurationException` (`DefaultRelationRegistry`).

Two problems followed from where the key sat, not from what it did:

1. **No compile-time typing.** Every other allowlist catches a typo before
   the app runs; `includable` could not, because `RelationEdgeSettings` is
   part of `KavoSettings`, which is deliberately entity-agnostic (it is the
   same schema for global, entity, operation, and per-call scope).
2. **One concept split across two unrelated categories.** `edges` mixed a
   permission gate (`includable`) with pure loading tuning
   (`defaultInclude`/`maxDepth`/`strategy`) in the same record, where naming a
   relation there was itself sufficient to open it
   (`includable: edge.includable ?? true`) — an easy default to get backwards
   when skimming the shape.

The alternative — leave `includable` on `relations.edges` but type its keys
against the entity's real relation names in place, the same way `filterable`/
`sortable` are typed against `FieldPath<Entity>` — was raised and rejected.
It fixes problem 1 alone; it does nothing about problem 2, and a config
schema is not the layer to fix half a documented inconsistency.

## Decision

**`includable` moves onto `QueryAllowlists`, typed against the entity's own
top-level relation names.** `IncludePath<Entity, 1>` — `IncludePath` capped
to depth 1 — is exactly that set: `include=` grants permission one relation
segment at a time from the root (`blog` is the unit `includable` grants;
`blog.name` is a filter/sort/select path, a different thing entirely), so
depth 1 is not an arbitrary choice, it is the shape of the permission. The
new type, `RelationFieldSelector<Entity>`, mirrors `QueryFieldSelector`'s
array-or-`{ exclude }` shape.

**`relations.edges` keeps only loading tuning.** `RelationEdgeSettings` drops
`includable`; `defaultInclude`/`maxDepth`/`strategy` stay exactly where they
were, because they are not a permission question — a relation `edges` tunes
without also being named in `allowlists.includable` still validates and
applies its tuning, but grants nothing. This is the same split ADR-0026 drew
between `selectable` (a permission/projection gate) and everything else
`KavoSettings` tunes.

**The opt-in default is preserved across the move — deliberately the odd one
out among the four allowlist keys.** `filterable`/`sortable`/`selectable`
default to "every own column" when unconfigured (a validation posture: reject
the unexpected, don't hide the expected). `includable` defaults to "no
relation" when unconfigured (a disclosure posture: a client cannot even probe
whether a relation exists until config says so — the same fail-closed
reasoning `errors/message-hints.ts`'s disclosure rule documents for the
rejection message itself). Moving the key does not get to also flip that
default; `resolveAllowlists` (`resolve-entity-config.ts`) resolves
`includable` through its own resolver, `resolveIncludableSelector`, returning
`[]` on `undefined` where every other key's resolver returns its base set.

**`{ exclude: [] }` is the one spelling that opts every relation in at
once.** `{ exclude }` still resolves against the full base set (every
relation), consistent with the other three keys — the asymmetry is in the
_default_, not in how `{ exclude }` resolves once written.

**The typo fail-fast moves with the permission, not with the tuning.**
`DefaultRelationRegistry` now takes `includable` (resolved names) and `edges`
(tuning) as two separate parameters. A name in `includable` that is not a
real relation throws `ConfigurationException` at `allowlists.includable`; a
name in `edges` that is not a real relation still throws too, at
`relations.edges.<name>` — the tuning-only entry gets the same fail-fast
treatment it always had, it just no longer doubles as a permission grant.

**The `defaultInclude` vs. permission cross-check moves out of
`validateSettings`.** `defaultInclude: true` on a relation the entity did not
open (`allowlists.includable`) is still a bootstrap `ConfigurationException`
— "it would load a relation clients cannot ask for" — but `validateSettings`
only ever sees `KavoSettings`, which no longer carries permission at all. The
check is now `validateIncludableRelations` in `resolve-entity-config.ts`, run
after `allowlists` resolves, alongside `validateDefaultSort`/
`validateSincePagination`, which already cross-check settings against a
resolved allowlist for the same reason.

## Consequences

**This is a breaking change to `EntityConfig`/`RelationEdgeSettings`'s public
shape.** Any app writing `relations.edges.<name>.includable` needs a
migration: move the relation names to `allowlists.includable`, keep any
`maxDepth`/`strategy` on `relations.edges.<name>` as before. `defaultInclude`
needs more care than a mechanical move if it was set at **global**
(`defaults`) scope — see the next consequence.

**`includable` can no longer be set at global (`createKavo`) or per-operation
scope, and a global `defaultInclude` now fails loudly instead of silently.**
`allowlists` sits outside `resolveEntityConfig`'s `SETTINGS_KEYS` — it merges
from nowhere but the entity's own `EntityConfig`, exactly like
`filterable`/`sortable`/`selectable` already did (`swagger.ts` documents the
same limitation for those three). Before this change, a global
`defaults.relations.edges.<name>.defaultInclude: true` was safe: naming the
relation in `edges` at all was itself the opt-in, so it needed no companion
grant. It is not safe to leave in place now — `validateIncludableRelations`
cross-checks `defaultInclude` against `allowlists.includable`, which cannot
be set at that same global scope, so a global `defaultInclude: true` with no
matching entity-level grant is a bootstrap `ConfigurationException` on every
entity that happens to have a relation of that name. This is deliberate
(failing loudly at bootstrap is preferable to the alternative — silently
dropping the setting, which would be `defaultInclude`'s own contract broken
silently), but it means the migration is not purely mechanical for this one
sub-key: `defaultInclude` set at global scope has to move down to each
entity's own `relations.edges.<name>`, alongside that entity's
`allowlists.includable` grant, not just have its host relation renamed.
Separately: a relation reachable only through `include=` and never given its
own `createCrud`/`@Kavo` call — legitimate, and covered in doc 12 §2 — can no
longer have that relation's own further relations opened by a caller-side
global default; opening them now requires giving that target entity its own
`createCrud`/`@Kavo` registration.

**`DefaultRelationRegistry`'s constructor signature changed, and it is a
barrel export.** `(descriptors, edges, entityName)` became `(descriptors,
includable, edges, entityName)` — a parameter inserted in the middle, not
appended. Any caller constructing one directly (outside the
`resolveEntityConfig` call this ADR's decision lives in) needs to add the new
`includable: readonly string[]` argument in the right position.

**Swagger's `include`/`select[relation]` docs read `allowlists.includable`
instead of `relations.edges`, with one added case.** `{ exclude }` cannot be
resolved at `@Kavo` decoration time (no ORM metadata exists yet, ADR-0012) —
the same limitation the other three allowlist keys already have — so
`includableRelations` (`packages/frameworks/nest/src/swagger.ts`) returns
`null` for that shape, distinct from a known-empty array: the caller
advertises the `include` parameter without a description rather than omitting
a parameter that may well do something.

**`{ exclude }`'s own names are existence-checked, unlike the other three
allowlist keys' `{ exclude }` form.** An earlier draft of this change left
`resolveIncludableSelector` with no existence check on `{ exclude }`'s names,
mirroring `resolveFieldSelector`'s behavior for `filterable`/`sortable`/
`selectable` — a name that matches nothing there silently excludes nothing
(the same hazard ADR-0026 §"Consequences" documents for `selectable`, left
open as a follow-up). That mirroring was wrong for this key specifically:
`{ exclude: ["ptes"] }` on an entity whose relation is actually named `pets`
would have excluded nothing and opened **every** relation — the typo
defeating the exclusion rather than producing a bootstrap error, on the one
allowlist whose whole posture is fail-closed by default. Unlike
`selectable`'s version of the hazard, which costs one served column, this one
would have cost the entire relation surface. `resolveIncludableSelector`
therefore checks `{ exclude }`'s names against the entity's real relations
and throws `ConfigurationException` at `allowlists.includable.exclude` on a
typo, the same fail-fast treatment the plain-array form already had.
`IncludePath<Entity, 1>` still catches most typos at compile time for a
properly typed config; this check is what catches the rest — a config built
through `as never`/erasure, which every ORM adapter's own tests use for
relation names that don't type-check cleanly against a marker class or a
lean-document shape (ADR-0017, ADR-0018).

## References

- ADR-0026 (`allowlists.selectable` narrows the response projection), the
  precedent for treating `allowlists` as the request/response permission
  surface and for splitting a permission gate out of unrelated tuning.
- ADR-0008 (field-path recursion cap), whose depth counter `IncludePath`
  reuses and this decision caps at 1.
- ADR-0012 (decoration-time route generation), the reason Swagger's
  `include` docs cannot resolve an `{ exclude }` selector.
- `docs/internals/architecture/12-relations-and-includes.md` §1 and §2.
