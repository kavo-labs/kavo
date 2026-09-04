# ADR-0008 — `FieldPath` recursion cap (default 3, max 5)

**Status:** accepted

## Context

`FieldPath<TEntity>` expands entity shapes into a template-literal union
of dot-paths. The union grows combinatorially with depth; on entities with
many mutually-referential relations an uncapped expansion can slow type
checking dramatically or hit compiler limits ("type instantiation is
excessively deep").

## Decision

Depth is capped by a tuple-decrement counter: default 3, hard maximum 5
(`FieldPathDepth`). `any`/`unknown`/index-signature shapes degrade to
`string` rather than erroring.

## Consequences

- Compile-time spell-checking for the paths people actually write
  (`posts.comments.text`); deeper paths need an explicit
  `FieldPath<T, 4|5>` opt-in.
- Depth caps in the _type_ system are independent of the _runtime_ limits
  (`limits.includeDepth`, `allowed.includable`) — the runtime remains the security gate.
- The degrade-to-`string` rule means untyped entities lose checking
  silently; documented, and acceptable against the alternative of breaking
  them.
- The cap is **one policy, not a pattern**: `IncludePath` (issue #6) reuses
  this decision's `Prev` counter, default depth, hard maximum and
  degradation rules rather than declaring its own. A second path type that
  needed a different recursion policy would be a reason to revisit this
  ADR, not to fork it.
