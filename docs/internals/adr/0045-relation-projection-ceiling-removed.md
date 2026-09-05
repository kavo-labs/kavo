# ADR-0045 — `allowed.selectable` takes root paths only; the relation-dotted ceiling is removed

**Status:** accepted — supersedes [ADR-0044](/internals/adr/0044-relation-projection-ceiling-from-selectable), which is fully reverted; restores [ADR-0026](/internals/adr/0026-selectable-narrows-the-response-projection) decision 4 to full force.

## Context

ADR-0044 gave `allowed.selectable` a second meaning: a relation-dotted
entry in the array form (`selectable: ["id", "title", "dictionary.id"]`)
was a per-relation _projection ceiling_ on an included relation, resolved
from the parent entity's config and intersected with the relation target's
own `selectable`.

One config key carrying two unrelated jobs — a root-resource field
allowlist _and_ a cross-entity projection cap — is the cost ADR-0044
accepted for reusing a spelling that already type-checked. In practice the
overload is the problem: `selectable` no longer reads as "what a request
may name in `select=`", the resolved list had to be filtered before use,
and `ResolvedEntityConfig` grew a `relationProjection` member that three
packages threaded through.

The same restriction is already expressible without the overload:
configure the **target** entity's own `allowed.selectable` (it governs
every include of that entity, ADR-0026 decision 4), or don't make the
relation `includable` at all. The one capability ADR-0044 added over that
baseline — capping a relation from the _parent_ side, per relation, even
for an unregistered target — is not worth a permanently overloaded key.

## Decision

**`allowed.selectable` takes this entity's own column names and its
declared computed-field names, and nothing else. A relation-dotted entry
is a bootstrap `ConfigurationException` (`KAVO_CONFIG_INVALID`), in both
the array and the `{ exclude }` form.**

- `allowed.selectable` gets its own selector type,
  `SelectableFieldSelector`, capped to depth 1 (`FieldPath` with `MaxDepth`
  1. plus the entity's declared computed-field names — the same cap
     `WritableFieldSelector` already uses for `creatable`/`updatable`. A
     relation-dotted entry no longer type-checks, unlike on
     `filterable`/`sortable`, which keep `QueryFieldSelector` and still take
     one.
- The runtime check in `resolveAllowed` stays, for an erased or cast
  config: any `selectable` entry that contains a `.` and is not itself a
  known field name is rejected, naming the entity, `allowed.selectable`,
  and the offending entry. (A genuine dotted column name — no adapter
  emits one today — is left alone; the rule stays precise.) This catches
  every ADR-0044 ceiling entry (`dictionary.id`), every relation-headed
  typo (`notARelation.field`), and the `a.b.c` deep form in one rule. The
  exception message tells the adopter to drop the entry or move the
  restriction to the target entity's own config.
- `ResolvedEntityConfig.relationProjection` and its resolver
  (`resolveRelationProjection`) are removed. The resolved
  `allowed.selectable` is the configured array verbatim (no
  post-filter step), and `projection` equals it, as for any other
  explicit `selectable`.
- `DefaultIncludeResolver` projects an included relation from the
  **target** entity's own resolved `selectable` only. With no
  `select[<relation>]=` in the request, the node carries no sparse
  fieldset and the target's default projection applies.
- `@kavo/nest` Swagger synthesis drops the ceiling path entirely: every
  includable relation in a synthesized `<Entity>Item`/`ListItem` schema
  is emitted as the deferred `x-kavo-includable-ref` marker that
  `registerKavoSchemas` composes into a `$ref` to `<Target>Item`; the
  `select[<relation>]` query parameter carries no `Restricted to:`
  description.

This is the third state of this surface, not a return to the first:

| State    | A relation-dotted `selectable` entry                       |
| -------- | ---------------------------------------------------------- |
| pre-0044 | boots, silently inert (type-checks, dropped at resolution) |
| ADR-0044 | some shapes throw at bootstrap; a valid one is a ceiling   |
| ADR-0045 | every relation-dotted entry throws at bootstrap            |

## Consequences

**Breaking change**, scoped to configs that carried a relation-dotted
`selectable` entry — every such config now throws at bootstrap instead of
either silently ignoring the entry (pre-0044) or enforcing it as a ceiling
(ADR-0044). Migration: drop the entry, or restrict the relation's shape on
the **target** entity's own `allowed.selectable`. Pre-1.0, `feat!` /
minor bump, changelog note.

**A parent can no longer narrow an included relation from its own side.**
An included relation's projection is governed wholly by the target
entity's own `selectable` (or its derived all-columns default). This is
the accepted tradeoff — see Context. An unregistered relation target,
which has no config to narrow, is served by its derived projection; there
is no parent-side override for that case any more.

**A new barrel type, `SelectableFieldSelector`.** Added to the core barrel
alongside `QueryFieldSelector`/`WritableFieldSelector`. `QueryAllowed.selectable`
is retyped from `QueryFieldSelector` to it — a config that spelled a
relation-dotted `selectable` entry now fails to compile as well as at
bootstrap.

**`ResolvedEntityConfig` loses a member.** `relationProjection` is gone
from the interface and from `describeResolvedConfig`'s dump. Anyone
hand-constructing a `ResolvedEntityConfig` through a cast (as the in-repo
tests do) simply stops setting a key that no longer exists.

**The synthesized Swagger `<Entity>Item` shape is simpler and more
composed.** Every includable relation now `$ref`s `<Target>Item` (or
degrades to `{ type: "object" }` when the target publishes no synthesized
item schema) — there is no longer an inline-object branch for a
parent-ceilinged relation. `select[<relation>]` loses its per-entity
`Restricted to:` description.

**ADR-0026 decision 4 is restored to full force.** "A relation is
projected by its own target's `selectable`, never the root's" holds with
no exception. ADR-0044's amendment to it is withdrawn.

## References

- ADR-0044, fully reverted by this decision.
- ADR-0026 (`allowed.selectable` narrows the response projection),
  whose decision 4 this restores.
- ADR-0028 (includable relations live on `allowed`), for the
  `relations.edges` vs `allowed` split.
- `docs/internals/architecture/12-relations-and-includes.md` §2 and §4;
  `docs/internals/architecture/10-nestjs-integration.md`;
  `docs/features/allowed.md`.
