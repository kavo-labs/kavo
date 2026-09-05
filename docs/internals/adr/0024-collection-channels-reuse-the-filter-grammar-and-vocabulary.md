# ADR-0024 — Collection-level realtime subscriptions reuse the entity name as their channel and the REST filter grammar/vocabulary for scoping

**Status:** accepted

## Context

Issue #160 asked for two things REST already has and realtime (#154/#155)
didn't: a way to subscribe to every write on an entity, not just one row,
and a way to scope that subscription to a subset of rows. Four questions had
to be answered before any code could be written, and each had an obvious
wrong answer that would have made this a second, parallel query language and
a wider realtime vocabulary:

1. **Does a collection channel need a new `RealtimeEventDto` field?**
   `RealtimeEventDto.entity` already carries the entity's name — exactly what
   a collection channel is named after. Adding a second field (`
collectionChannel`) would duplicate it and give a transport two sources
   of truth for the same string.
2. **Does a subscribe-time filter need its own grammar?** REST already has
   one (`filter[field][operator]=value`, `docs/internals/architecture/
05-query-grammar.md` §1), parsed into a `FilterExpression` AST. Building
   a second one for realtime would mean a client learns two filter
   languages for the same entities.
3. **Does a row entering/leaving a filtered subscriber's view need new event
   ids?** `RealtimeEventId` (`packages/core/src/realtime/realtime-event.ts`)
   has been a deliberately closed vocabulary since #154 — five ids, no
   custom-operation id, "closed until a future issue decides." A synthesized
   `"entered"`/`"left"` pair was the obvious next move and would have grown
   that vocabulary for the first time.
4. **What does a filtered subscriber get on `"deleted"`, where `item` is
   `null`?** There is nothing to evaluate the filter against.

## Decision

**1. The collection channel is the bare entity name; no new DTO field.** A
transport treats `RealtimeEventDto.channel` (`<entity>.<id>`) as the
item-level subscription target and `RealtimeEventDto.entity` as the
collection-level one — the same event, published once by the engine, fans
out to both kinds of subscriber because a transport reads both fields off
one payload. `@kavo/sse`'s `handleRequest` accepts either `?channel=<entity>`
or `?channel=<entity>.<id>`.

**2. Subscribe-time filtering reuses the REST filter grammar and AST
verbatim, evaluated in memory.** A subscribe request may carry ordinary
`filter[field][operator]=value` query params; `@kavo/sse` parses them with
the same `DefaultFilterParser` REST uses (a `FilterableEntity` — an
entity's `EntityMetadata` + `ResolvedEntityConfig`, supplied by the host app
the same way `subscribableFields` already is) and validates them against the
same `filterable` allowlist and `limits.filterDepth`/`limits.inValues` limits.
The resulting `FilterExpression` is evaluated per candidate subscriber, per
publish, by a new core function — `evaluateFilter` (`packages/core/src/
query/filter-evaluator.ts`) — rather than by building a query and asking an
adapter. It follows SQL's three-valued-logic convention: a `null`/missing
item value makes every operator except `IS_NULL`/`IS_NOT_NULL` evaluate to
`false`, including `NE` and `NOT_IN` (a naive `!(null === x)` would
otherwise include a null row a real `!= x` predicate excludes). A filter
field must be one of the entity's own columns — a relation or dotted path
is rejected with `400` at subscribe time rather than silently matching
nothing forever, because the evaluator has no join to walk and no
before-image to reach a relation's current value with.

**3. Filter-boundary crossings are not new events.** A write that makes a
row start matching a filter ("enter") is delivered as whatever its real
event id already is (`updated`/`patched`/`restored`) — not a synthesized
`created`. A write that makes a row stop matching ("leave") is not
delivered at all: detecting that transition needs the row's pre-write
match state, and the engine does not read a row before every write today
(only under an `If-Match` precondition) — adding that read unconditionally,
paid by every write on a realtime-enabled entity whether or not a filtered
collection subscriber exists, was rejected as a cost with no matching
benefit for the common case. This is a documented limitation, not a
silently-wrong "leave" event: a client that needs to know a row left its
filtered view cannot rely on this seam for it today.

**4. A `"deleted"` event bypasses the filter unconditionally.** `item` is
`null` on delete, so there is nothing to evaluate; every filtered
subscriber of the channel receives it regardless of match. The alternative
— excluding it — leaves a client with a row in its view that is permanently
gone and no signal that it should not be. This is a confidentiality
tradeoff, not just a staleness one: a subscriber on `filter[ownerId][eq]=me`
now learns the `id` of every row deleted on the entity, including ones it
never had visibility into. That is acceptable only because subscriber-level
authorization is already out of scope for `@kavo/sse` (`RealtimeTransport`'s
own doc, since #154/#155) — a filter narrows _which_ events a subscriber
receives, it does not establish _whether_ they were authorized to.

`RealtimeEventId`'s vocabulary stays exactly five ids. `"deleted"` is now
overloaded to mean "stop expecting to see this row," not strictly "this row
no longer exists" — documented on the type itself.

## Consequences

- A second `RealtimeTransport` (a future `@kavo/websocket`) gets collection
  channels and filtering for free from `event.channel`/`event.entity` and
  `evaluateFilter` — it only needs its own per-connection subscription
  bookkeeping and its own `FilterableEntity` wiring, the same shape
  `@kavo/sse` uses.
- `KavoEngine` gained a `metadata` getter (alongside its existing `config`/
  `registry` ones) so a transport's host app can build a `FilterableEntity`
  from `service.engine.metadata`/`service.engine.config` without a new core
  seam.
- A client cannot yet learn "this row left my filtered view" from an
  ordinary write — only from a genuine delete. Fixing that is future work
  gated on deciding whether the extra pre-write read is worth paying for
  every write on a realtime-enabled entity, not only ones with a filtered
  collection subscriber.
- Field-level channels (a topic per field) remain unbuilt; `subscribableFields`
  narrows the payload of an item- or collection-level channel, but does not
  create a third channel kind.
