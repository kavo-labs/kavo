# ADR-0047 — `KavoSettings` groups request-cost ceilings under `limits` and lifts `search` to top level

**Status:** accepted

## Context

`KavoSettings` mostly follows one convention for its optional subsystems:
each lives at a top-level key, and `false` disables the subtree wholesale
(`cache`, `softDelete`, `realtime`, `arrayMutation`). `search`, though, was
buried at `query.search` — a scope discoverable only by already knowing the
`query` block exists — while the request-cost ceilings that guard filter
depth, `IN`-array length, and `like`-pattern length (`query.maxFilterDepth`/
`maxInValues`/`maxLikePatternLength`) sat in that same `query` block, and the
two relation-include ceilings (`relations.maxIncludeDepth`/
`maxIncludedNodes`) sat in an unrelated block entirely — a caller tuning
"how expensive can one request get" had to know to look in two places for
five conceptually identical knobs. After ADR-0046 moved `query.defaultSort`
out to `defaults.sort`, the `query` block held only ceilings and `search`,
with no remaining reason to exist as its own scope.

## Decision

`KavoSettings` drops the `query` block entirely. Its members move as
follows:

- `search` moves to a **top-level** key, keeping its `SearchSettings | false`
  shape and `false`-disables-the-subtree convention (the same one `cache`/
  `softDelete`/`realtime`/`arrayMutation` already use).
- `maxFilterDepth`, `maxInValues`, and `maxLikePatternLength` join a new
  **`LimitsSettings`** block, alongside `relations.maxIncludeDepth` and
  `relations.maxIncludedNodes` (renamed `includeDepth`/`includedNodes`),
  which move out of `RelationSettings`. The `max` prefix on each is dropped
  inside `limits` — the block name already says these are ceilings —
  yielding `limits.filterDepth`, `limits.inValues`, `limits.likePattern`,
  `limits.includeDepth`, `limits.includedNodes`.
- `RelationSettings` is `{ edges }` only after the move — inclusion
  _permission_ (`allowed.includable`), inclusion _defaults_
  (`defaults.include`), and inclusion _limits_ (`limits.includeDepth`/
  `includedNodes`) are now three separate blocks, none of them
  `RelationSettings`, which is left holding only per-relation loading
  tuning.
- `pagination.maxLimit` is the one ceiling that does **not** move to
  `limits`. It stays in `pagination` because `max` there distinguishes it
  from the sibling `defaultLimit`, and because it is genuinely coupled to
  `pagination.strategy` (irrelevant under `strategy: "none"`, a keyset
  ceiling under `"cursor"`/`"since"`) in a way the other ceilings are not
  coupled to anything outside `limits`.

This is a pure restructuring: every ceiling keeps its default value and its
enforcement point, and a breach still produces the same `KAVO_QUERY_LIMIT_
EXCEEDED`/`400`. Nothing here is behind a compatibility alias — old paths
are simply gone (`feat!` with a `BREAKING CHANGE:` footer enumerating every
path move).

## Consequences

- A reviewer checking "is this a request-cost ceiling" now has one place to
  look (`limits`) instead of two (`query`, `relations`), and "is search on"
  now has one place to look (`search`) instead of needing to know it hides
  under `query`.
- `validateSettings`'s error paths (`limits.filterDepth`, `search.mode`,
  etc.) and every doc comment, Swagger comment, and prose reference that
  named the old paths move with them — a reader following an error's `path`
  field into the schema finds the key at the name the error names.
- A future settings key that caps some request cost has an obvious home
  (`limits`) rather than a choice between inventing a new top-level key or
  overloading an unrelated block.
