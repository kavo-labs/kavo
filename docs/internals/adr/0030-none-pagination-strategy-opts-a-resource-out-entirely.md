# ADR-0030 — `pagination.strategy: "none"` opts a resource out of pagination entirely

**Status:** accepted

## Context

`pagination.maxLimit` always clamps `findMany`, and `PaginationSettings` had
no escape hatch — unlike `softDelete`, `realtime`, and `arrayMutation`, which
each accept `false` at entity scope to switch the whole subtree off
(`packages/core/src/config/settings.ts`). A resource that genuinely never
wants a page boundary (a small lookup/reference table) could only raise
`defaultLimit`/`maxLimit` to some large number — still a clamp, still an
arbitrary ceiling the OpenAPI docs would advertise (issue #225).

The `false`-disables-the-subtree convention does not transfer directly here.
`softDelete`/`realtime`/`arrayMutation` are each a whole top-level
`KavoSettings` key that can be `SomeSettings | false`; `pagination` itself is
never optional — every `findMany` response still needs a `limit`/`offset`
pair for the envelope, so there is no whole subtree to switch off. The two
candidate shapes were a new field, `pagination.maxLimit: number | false`, or
a new value for the field that already selects behavior,
`pagination.strategy: "none"`.

`maxLimit: false` was rejected for three reasons. First, it collides with
`PaginationLimits`, the public interface every third-party `PaginationStrategy`
receives (`{ defaultLimit: number, maxLimit: number }`) — widening `maxLimit`
to `number | false` there means every existing strategy's
`Math.min(limit, limits.maxLimit)` silently clamps to `0` the moment `false`
reaches it, unless every strategy author updates first. Second, it only
answers "how big can a page be", not "should there even be a boundary" — a
plain `GET /widgets` would still be `defaultLimit`-sized unless `defaultLimit`
were _also_ unbounded, which the issue's own examples call for ("a resource
that legitimately wants to serve its whole table in one call"). Reaching that
means resolving two settings together as one concept, which is what a
dedicated strategy name already is. Third, `pagination.strategy` is already
the seam this exact kind of behavioral choice lives on — `cursor` and `since`
each change what a page even means (ADR-0021, ADR-0022); "no page at all" is
a third variant of the same question, not a modifier on `offset`.

## Decision

**1. `"none"` is a fifth built-in `PaginationStrategy`.** Registered in
`builtInPaginationStrategies()` alongside `offset`/`page`/`cursor`/`since`,
so `strategyFor`'s "unknown strategy" error still enumerates it and nothing
about strategy resolution needs to know it is special.

**2. `limit`/`offset` are rejected outright, never silently ignored.**
Accepting a client-sent `limit` and quietly not applying it would leave the
client believing paging took effect when it didn't — the same "wrong
strategy, told" treatment `cursor`/`since` params already get under any
other strategy (`keysetParamUnsupportedIssue`). Both issues are collected
into **one** `QueryValidationException` when both `limit` and `offset` are
sent, matching `QueryNormalizer`'s own documented contract ("all issues from
all sections … collected into a single exception, so a client fixes its
request in one round trip") — a strategy raising its own exception is not
exempt from that contract just because it lives outside the normalizer's own
issue-collection loop.

**3. The reported `limit` is `2^31 - 1` (`2147483647`), not
`Number.MAX_SAFE_INTEGER`.** The envelope's shape is fixed (`items`, `limit`,
`offset`, `total`, `meta`), so `limit` has to report _something_ even though
there is no real page size — the same reasoning that leaves a cursor page's
`offset` at `0` (ADR-0021 §6). `Number.MAX_SAFE_INTEGER` (`2^53 - 1`)
overflows a signed 32-bit integer, which is what this value has to survive
unchanged through every consumer in the workspace: every SQL driver's
`LIMIT`/`.take()` (fine up to 64-bit), `@kavo/graphql`'s `GraphQLInt` envelope
field (`graphql-js` throws serializing above `2^31 - 1`), and MongoDB's wire
`limit`, which is int32. `2^31 - 1` is the ceiling every one of those can
carry without a second, adapter-specific ceiling — and it is not a real limit
for any table this strategy is a reasonable fit for.

**4. The programmatic path (`QueryNormalizer.normalizeInput`) knows `"none"`
by name, not by the shape it produces.** ADR-0021 §4 established
`paginationShape`'s probe as structural — deliberately not comparing a
strategy's _name_ to `"cursor"`/`"since"`, so a third-party strategy under
another name is still classified correctly by what it returns. `"none"`
cannot get the same treatment: it produces a plain `OffsetPagination`
(`{ limit, offset }`), structurally identical to `offset`/`page`, because the
envelope has no field for "unbounded" to live in. `normalizeInput`'s offset
branch already computes `limit`/`offset` directly
(`Math.min(input.limit ?? defaultLimit, maxLimit)`) rather than calling the
registered strategy — true for `offset`/`page` today, for the same
architectural reason `PagePaginationStrategy` cannot be reused there either
(the programmatic API's `limit`/`offset` fields don't share `page`'s wire
spelling) — so nothing short of a `strategy === "none"` check would make that
branch unbounded too. This is a deliberate, narrow, and comment-flagged
exception to the "structural, not name-based" rule, not a reversal of it: the
rule still holds for every strategy whose _shape_ can carry the information
(`cursor`, `since`, and any future keyset strategy).

**5. `defaultLimit`/`maxLimit` go unused under `"none"`.** No new
`validateSettings` rule was added — an unused pair of built-in defaults
(`20`/`100`) always satisfies the existing positive-integer check, so
leaving them be costs nothing and avoids a config error that would only fire
because a value nobody reads happens to be present.

## Consequences

- **A resource opted into `"none"` has no configured ceiling — the adopter's
  judgment call, not a warning Kavo issues.** Nothing here detects a table
  that has outgrown one response; that stays an adopter obligation, the same
  posture ADR-0021 takes toward the missing composite index a cursor strategy
  needs.
- **`@kavo/graphql`/`@kavo/mcp` are not restricted the way `cursor`/`since`
  are.** Both bindings pass through whatever `limit`/`offset` a caller
  supplies; a caller that never asks for either gets the whole match set
  correctly, and one that does gets the same `KAVO_QUERY_UNSUPPORTED_PARAM`
  a REST caller would. No `requireOffsetPageable`-style bootstrap refusal was
  added — unlike a keyset strategy, `"none"` does not silently return the
  wrong page when a binding ignores something; it composes correctly by
  construction, so there is nothing for a bootstrap check to catch.
- **The OpenAPI `limit`/`offset` docs for `"none"` are decoration-time-blind
  to a global-only default.** `pagination` merges through the full
  precedence chain (global → entity → operation), so `KavoBinder.
onModuleInit`'s `applyPaginationDocs` (mirroring `applySearchQueryDocs`)
  is what actually applies the "not supported" description, using the fully
  resolved `pagination.strategy` — `listQueryParams` no longer declares
  `limit`/`offset` at decoration time at all, because `@nestjs/swagger`'s own
  parameter de-duplication (`unionWith` over `{ name, in }`) keeps the
  _first_ match, so a second `ApiQuery({ name: "limit" })` applied later
  would have been silently discarded rather than override an
  earlier-declared one.
