# ADR-0046 — A `defaults` block covers what a request looks like when the client asks for nothing

**Status:** accepted

## Context

Request defaults were scattered across three unrelated homes, each with its
own shape and its own scope rules: default sort lived at `query.defaultSort`
(`Sort[]` — already the internal AST shape, not the wire shorthand `sort=`
itself accepts); default include was a per-relation boolean,
`relations.edges.<name>.defaultInclude`, sitting inside loading tuning it had
nothing to do with (ADR-0028 already flagged this as an awkward neighbor when
it moved `includable` out of the same record); and there was no default
_selection_ at all — an entity with a narrow `allowed.selectable` had no way
to also narrow what an unadorned `GET` actually returns without either
forcing every caller to send `select=`, or registering an `item`/`list` DTO
that also renames the concern for something that is only a projection
default.

All three answer the same question — "what does this request look like when
the client specifies nothing for this axis?" — but a reader had to already
know to look in three different subtrees, one of them fully absent, to find
the answer. `allowed` (`QueryAllowed`, entity-config.ts) is the equivalent
single home for the opposite question, "what may a request specify at all?"
(issue #374 renamed the allowlists block to `allowed`); there was no
omission-side counterpart.

`defaultInclude`'s placement had a second, sharper problem beyond
discoverability: it stayed cross-checked against `allowed.includable`
(ADR-0028) via a name-keyed boolean scattered per relation, which meant
adding a `defaults.select` in the same idiom would have meant inventing yet
another per-field boolean map — a shape none of `filterable`/`sortable`/
`selectable` use for their own omission behavior today, since none of them
had one yet.

## Decision

**A new `defaults` block lands on `KavoSettings`, with exactly three keys:
`sort`, `select`, `include`.** Like every other `KavoSettings` subtree, it
merges through the ordinary precedence chain — `built-in defaults → global →
entity → operation → per-call` — with the same replace-wholesale array
algebra `mergeSettings` already applies everywhere else (`merge-settings.ts`).
The semantics are one sentence, and the same sentence for all three keys:
**applied only when the request omits that axis; a client-supplied value
replaces it outright, never merges with it** — the exact rule
`query.defaultSort` already had, just generalized.

**`query.defaultSort` and `relations.edges.<name>.defaultInclude` are deleted
outright — no alias, no deprecation shim.** `defaults.sort` and
`defaults.include` are their replacements, not new names for the same field:
`defaults.sort` also changes shape (below), and `defaults.include` changes
the storage granularity from "one boolean per relation record" to "one flat
list, entity-wide."

**`defaults.sort` takes the same wire shorthand `sort=` does — plain strings,
`-field` for descending — not the internal `Sort` AST.** Previously
`query.defaultSort: Sort[]` forced every caller to spell out `{ field,
direction }` objects for a _default_, while the client-facing spelling of the
identical concept was a comma-separated string. `defaults: { sort: ["-createdAt",
"id"] }` reads the same as `?sort=-createdAt,id` because it _is_ the same
grammar. `QueryNormalizer.defaultSortOf` (`query-normalizer.ts`) parses each
token with the same per-token logic `parseSort` already uses for the wire
param — extracted once, as `parseSortToken` — rather than duplicating the
`-` prefix convention a second time.

**`defaults.select` is new: an entity-wide list, not a DTO.** Absent (the
default), behavior is unchanged: every selectable field is projected, exactly
as today. Configured, it becomes the effective `select.root` whenever the
request sends none — resolved in `QueryNormalizer` on both the wire and
programmatic paths, the same place `defaultSortOf` already runs, so
`@kavo/graphql`/`@kavo/mcp` inherit it with no binding-side change (both
delegate entirely to `QueryNormalizer`, ADR-0016).

**`defaults.include` replaces the per-relation `defaultInclude` boolean with
one flat list of relation names, entity-wide.** The ADR-0028 cross-check —
`defaultInclude` on a relation not in `allowed.includable` is a bootstrap
error, "it would load a relation clients cannot ask for" — moves with it
unchanged in spirit: every name in `defaults.include` must also be in
`allowed.includable`. `RelationDescriptor.defaultInclude` (the field the
include resolver actually reads at request time) still exists and is still
populated by `DefaultRelationRegistry`, just from the new `defaultIncludes`
constructor parameter instead of from `edges[name].defaultInclude` —
`relations.edges` keeps only pure loading tuning (`maxDepth`/`strategy`/
`write`) now, with nothing permission- or default-shaped left in it.

**All three keys are validated in two stages, following the existing
pattern.** `validateSettings` (`validate-settings.ts`) checks shape alone —
each key is an array of non-empty strings, `defaults.select` only when
present — because it only ever sees `KavoSettings`, which carries no `Entity`
type parameter and so cannot check field names against real metadata.
`validateDefaults` (`resolve-entity-config.ts`, the renamed and widened
`validateDefaultSort`) cross-checks resolved values against the resolved
`allowed` allowlist — `defaults.sort` fields (after stripping a leading `-`)
against `sortable`, `defaults.select` fields against `selectable`,
`defaults.include` relations against `includable` — run at both entity scope
and per-operation scope, the same two call sites `validateDefaultSort`/
`validateIncludableRelations` already ran at.

**`KavoSettings` stays entity-agnostic; `defaults` is not entity-typed.** The
same reasoning ADR-0028 gave for why `includable` had to leave
`RelationEdgeSettings`(and could not just gain typed keys in place) does not
apply here in reverse: `defaults` is not moving _out of_ `KavoSettings` the
way `includable` moved out of it, so there was no equivalent forcing
function to give it compile-time `FieldPath<Entity>` typing the way `allowed`
has. Every key stays a plain `readonly string[]`, the same laxity
`relations.edges`'s keys and `RealtimeFieldSelector` already have, for the
same reason: `KavoSettings` is one schema for global, entity, operation, and
per-call scope alike, and only entity scope ever has a concrete `Entity` to
type against.

## Consequences

**This is a breaking change.** Any app setting `query.defaultSort` or
`relations.edges.<name>.defaultInclude` needs a mechanical migration:
`query.defaultSort: [{ field: "createdAt", direction: "desc" }]` becomes
`defaults: { sort: ["-createdAt"] }`; `relations.edges.<name>.defaultInclude:
true` becomes `defaults: { include: ["<name>"] }` (with `allowed.includable`
still granting the relation, unchanged). Neither migration is purely a
rename — the sort shape changes from AST objects to wire strings, and the
include default moves from a per-relation record to one flat entity-wide
list.

**The same global-scope hazard ADR-0028 already documented for
`defaultInclude` applies unchanged to `defaults.include`.** `allowed` sits
outside `resolveEntityConfig`'s `SETTINGS_KEYS`, so it can only be set at
entity scope. A `defaults.include` set at global (`createKavo`) scope with no
matching entity-level `allowed.includable` grant is a bootstrap
`ConfigurationException` on every entity that happens to have a relation of
that name — loud, not a silent no-op, the same posture ADR-0028 chose.

**`DefaultRelationRegistry`'s constructor grew a sixth parameter.**
`(descriptors, includable, edges, entityName, arrayMutationDefault,
defaultIncludes)` — appended at the end, not inserted, so existing positional
callers passing fewer arguments keep compiling if they relied on the
trailing defaults; any caller constructing one directly and wiring
`defaultInclude` needs to move that list into the new parameter.

## References

- ADR-0028, the direct precedent this decision generalizes: the two-call-site
  validation pattern, the "grants nothing, only tunes loading" split for
  `relations.edges`, and the global-scope hazard `defaults.include` inherits
  verbatim.
- ADR-0026 (`allowed.selectable` narrows the response projection), the
  request/response permission counterpart `defaults.select` is the omission
  side of.
- ADR-0022 (`since` pagination forces its own sort), which still overrides
  `defaults.sort` when active — unchanged by this decision.
- `docs/internals/architecture/08-configuration.md` §2 and §4.
