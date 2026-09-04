# ADR-0044 — A relation-dotted `allowed.selectable` entry caps an included relation's projection

**Status:** superseded by [ADR-0045](/internals/adr/0045-relation-projection-ceiling-removed), which reverts this decision entirely — `allowed.selectable` takes root paths only again, and a relation-dotted entry is now a bootstrap error rather than a ceiling. The rest of this document describes behaviour that no longer exists.

## Context

`allowed.selectable` narrows the root entity's response projection
(ADR-0026). An **included** relation was projected by its own target's
`selectable` or registered `item`/`list` DTO, and never by the config of
the entity doing the including — ADR-0026 decision 4 states it outright:
"A relation is projected by its own target's `selectable`, never the
root's." A caller could trim an include per request with
`select[<relation>]=`, but there was no way to say in config "an included
`dictionary` returns only `id`, always" — an adopter who includes a
relation to surface one field ships the relation's whole row unless every
caller remembers the sparse-fieldset param.

Two facts made a config spelling natural rather than novel:

1. `QueryFieldSelector` is typed as `FieldPath<Entity>` at depth 3, so a
   relation-dotted entry (`"dictionary.id"`) already **type-checks** in
   `selectable`.
2. It also already did **nothing**. `resolveProjection` returns the
   configured list and the serializer intersects it with the entity's
   derived scalar/computed keys — a dotted entry matches none of them and
   is silently dropped. ADR-0026's own resolver comment notes the residue:
   "an explicit `selectable` may legitimately name a relation path, which
   is not a key this projection ever emits."

So the config surface accepted a plausible-looking line and ignored it.
The alternative considered — a dedicated per-relation selector, e.g. a
per-relation object on `allowed.includable` or a `selectable` key on
`relations.edges.<name>` — adds a second config mechanism for an outcome
the first mechanism already half-expresses, and fights ADR-0028's split
that keeps `relations.edges` loading-tuning-only.

## Decision

**A relation-dotted entry in the _array_ form of `allowed.selectable`
is a projection ceiling for that included relation.**
`selectable: ["id", "title", "dictionary.id"]` resolves to a root
projection of `["id", "title"]` and a `relationProjection` of
`{ dictionary: ["id"] }` on `ResolvedEntityConfig`.

- **It is a default and a ceiling.** When a request sends no
  `select[<relation>]=` for that node, the ceiling _is_ the node's
  fieldset. When it does, the requested fields are validated against the
  target's `selectable` **and** the ceiling; a field allowed by the target
  but outside the ceiling is a `KAVO_QUERY_INVALID_FIELD` 400, named
  against the owning entity's config. A request narrows within the
  ceiling, never past it.
- **It is an intersection, never a widening.** The ceiling applies on top
  of whatever the target resolves — its own `selectable` or a registered
  `item`/`list` DTO — so a DTO that exposes `title` still cannot widen
  `dictionary` past `["id"]`.
- **Enforcement is `DefaultIncludeResolver`, against the _owner's_
  config.** `relationProjection` is keyed by the owning entity's own
  relation names, and the resolver already walks the tree one level at a
  time holding the config of the entity that owns each edge — so each
  owner's ceiling applies at its own level of a nested `include`, with no
  extra threading.
- **Reads only.** `KavoEngine.execute` normalizes a query for read
  operations only; a write never resolves `include`, so there is no
  write-echo path to bound.
- **Root residue is removed, not just tolerated.** The relation-dotted
  entries are stripped from the resolved `allowed.selectable` (which
  documents exactly "what a request may name in `select=`") and from the
  derived `projection`, so `select=dictionary.id` no longer passes root
  field validation as a no-op.

**Rejected shapes fail at bootstrap with a `ConfigurationException`, not
silently:**

| Shape                                                    | Why it is rejected                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| a relation path inside `selectable: { exclude: [...] }`  | the `{ exclude }` form cannot express a ceiling — its base set is the readable projection, which has no relation keys |
| `"a.b.c"` where `a` is a relation                        | deeper than one relation segment; deep projection is out of scope (issue #343)                                        |
| `"rel.field"` where `rel` is not on `allowed.includable` | the ceiling could never take effect                                                                                   |
| `"notARelation.field"`                                   | a dotted entry whose head is not a real relation — a typo, previously inert                                           |

The **field** half of a ceiling entry (`<field>` in `<relation>.<field>`)
is not checked at bootstrap — the target's metadata is not in scope there,
the same laxity `resolveAllowed` already documents for relation paths
on `searchable`. Its behaviour then splits by path:

- a request that names the field in `select[<relation>]=` gets a 400 if
  the field is not on the target's own `selectable`;
- with no request fieldset, the ceiling is used verbatim and a field that
  names no real target column is simply **omitted** from the projected
  relation — a quiet degrade, not an error. An entity that opts into a
  ceiling is expected to name fields that exist on the target.

## Consequences

**This is a breaking change**, scoped to configs that already carried an
inert relation path on `selectable`. Every shape in the table above boots
today (the path type-checks and is silently dropped) and now throws a
`ConfigurationException` at bootstrap. The one most likely to bite:
`selectable` built by copying a `filterable`/`sortable` list — which is
how issue #343's reporter wrote it — where the copied list contains a
relation path whose relation was never named on `allowed.includable`.
Migration: name the relation in `allowed.includable` (if the ceiling
is intended), or drop the entry (if it was noise). Pre-1.0, minor bump,
changelog note.

**The resolved `allowed.selectable` and `projection` are now narrower**
for such a config: the relation-dotted entries are removed. Anything that
reads the resolved list — `select=` request validation, the
`<Entity>Query.select` component-schema enum, `@kavo/nest`'s
`fallbackListSchema` — no longer sees a relation path it never did
anything useful with anyway. This is deliberate: the entry means
"relation ceiling", not "root `select=` path".

**This amends ADR-0026 decision 4.** The root config _can_ now narrow an
included relation — but only through `selectable` relation paths, and only
by intersection. ADR-0026's core rule (an include never _widens_ what its
target exposes) is unchanged and in fact reinforced.

**The ceiling holds for an unregistered relation target,** unlike
ADR-0026's projection: that decision notes decision 4 "holds only for
registered entities" because an unregistered target's derived config
"configures nothing". This ceiling is enforced through the include tree's
`node.fields`, set from the **owner's** config, so it applies whether or
not the target ever went through `createCrud`/`@Kavo` — the strongest
reason to prefer this spelling over a per-relation selector on the target.

**`ResolvedEntityConfig` gains a member,** `relationProjection`. It is
barrel-exported; anyone hand-constructing one through a cast (as the
in-repo tests do) gets an object the compiler no longer checks. This is
the same break ADR-0026 recorded for `projection` and ADR-0019 for
`computed`.

**Swagger gains a description.** `select[<relation>]` carries
`Restricted to: <fields>.` when the relation has a ceiling — resolvable at
decoration time (ADR-0012), because the ceiling is literal strings on
`allowed.selectable`, unlike an `{ exclude }` selector.

**The synthesized response schema uses the ceiling too** (issues #349 and #356).
`@kavo/nest`'s bind-time fallback `<Entity>Item`/`ListItem` schema —
the path with no registered `item`/`list` DTO — emits an optional property
for each `allowed.includable` relation. When the parent sets a one-hop
`selectable` ceiling for that relation, the parent wins: an inline object
limited to the ceiling fields, from `ResolvedEntityConfig.relationProjection`.
When it sets **no** ceiling, the property defers wholly to the target and is
composed by shared component — `registerKavoSchemas` resolves it to
`{ $ref: "#/components/schemas/<Target>Item" }` (a degraded `{ type: "object" }`
when the target publishes no synthesized item schema). Nested `include=a.b.c`
therefore types transitively, bounded on the request side by the existing
`limits.includeDepth` — there is no separate Swagger depth control.
The property never enters `required` (present only under `include=`), and a
`defaultInclude: true` relation is not promoted either: the shape is shared
with write responses, which carry no relations (ADR-0020).

## References

- ADR-0026 (`allowed.selectable` narrows the response), whose decision
  4 this amends.
- ADR-0028 (includable relations live on `allowed`), for the
  `relations.edges` vs `allowed` split this decision stays on the right
  side of.
- ADR-0008 (field-path recursion cap), the reason the ceiling is limited
  to one relation segment.
- ADR-0012 (decoration-time route generation), for why Swagger can
  document the ceiling but not an `{ exclude }` selector.
- `docs/internals/architecture/12-relations-and-includes.md` §2 and §4;
  `docs/features/allowed.md`.
