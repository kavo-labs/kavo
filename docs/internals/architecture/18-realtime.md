# 18 — Realtime Events, Channels & Subscription Filtering

A write can publish an event describing itself, to whatever transports an
app registered. Core owns the event shape and the publish hook; it ships no
transport of its own (ADR-0005). `@kavo/sse` is the first one.

```ts
const kavo = createKavo({
  infrastructure,
  realtimeTransports: [sse],
  defaults: { realtime: { enabled: true, events: { created: true, updated: true } } },
});
```

That is the whole opt-in for one entity's writes to start publishing.

## 1. The event vocabulary

`RealtimeEventId` (`packages/core/src/realtime/realtime-event.ts`) is a
closed, five-member vocabulary — `"created" | "updated" | "patched" |
"deleted" | "restored"` — one per standard write outcome.
`REALTIME_EVENT_BY_OPERATION` (`kavo-engine.ts`) maps `deleteOne` and
`purgeOne` both to `"deleted"`: a subscriber only needs to know the row is
gone, not which delete strategy produced that. A custom operation never
emits — the vocabulary stays closed until a future issue decides what one
publishes as.

## 2. The engine's publish hook

`KavoEngine.emitRealtimeEvent` runs once, after every successful write,
right before `execute` returns (`kavo-engine.ts`). Every check ahead of the
transport loop is ordered cheapest-first and returns immediately, so an
entity with realtime off (the default) or a write that maps to no event id
pays for nothing beyond a couple of property reads — no `RealtimeEventDto`
is even constructed. `publish` rejecting never fails the mutation that
already succeeded; a transport's own delivery failure is reported through
`RealtimeSettings.onPublishError`, if the app supplied one, and swallowed
otherwise (core has no ambient logger — ADR-0005).

`RealtimeEventDto` (the wire payload):

| Field        | Meaning                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `event`      | The `RealtimeEventId`.                                                                                                    |
| `entity`     | `EntityMetadata.name` — also the **collection channel** (§3).                                                             |
| `id`         | The written row's id.                                                                                                     |
| `channel`    | `<entity>.<id>` — the **item channel** (§3).                                                                              |
| `occurredAt` | ISO-8601, set once by the engine so every transport agrees on it.                                                         |
| `item`       | The same output-DTO serialization already computed for the REST response — no second pass. `null` on `"deleted"`.         |
| `changed`    | `"updated"`/`"patched"` only — the field names present in the write payload, not a diff against the row's previous value. |

## 3. Channels: item-level and collection-level

Issue #160 added collection-level subscriptions without adding a field to
`RealtimeEventDto` (ADR-0024): the collection channel a subscriber opens is
exactly the entity name, which `entity` already carries. A transport reads
`channel` for an item-level subscriber and `entity` for a collection-level
one off the same payload — the engine still builds and publishes exactly
one `RealtimeEventDto` per write; the dual routing is the transport's job.

`@kavo/sse`'s `handleRequest` accepts either shape on `?channel=`:

- `<entity>.<id>` — every event for one row.
- `<entity>` — every event for the entity.

Field-level channels (a topic per field) are not built. `subscribableFields`
(§5) narrows the payload of either channel above; it does not create a
third channel kind.

## 4. Subscribe-time filtering

A collection-channel subscribe request may also carry the ordinary REST
filter grammar (`filter[field][operator]=value`, doc 05 §1) to scope itself
to a subset of rows — `GET /realtime?channel=Book&filter[status][eq]=published`.
This reuses REST's grammar and AST verbatim (ADR-0024): no second filter
language, no new `RealtimeSettings` key. The filter travels on the
subscribe request's query string, the same transport-level parameter
`channel`/`fields` already are.

### 4.1 Parsing and validation

`@kavo/sse` parses a subscribe request's filter with the same
`DefaultFilterParser` REST uses, against a `FilterableEntity` — an
entity's `EntityMetadata` + `ResolvedEntityConfig` — that the host app
supplies via `SseTransportOptions.filterableEntities`, the same pattern
`subscribableFields` already established:

```ts
const sse = createTransport({
  subscribableFields: (entity) => (entity === "Book" ? ["title", "status", "price"] : undefined),
  filterableEntities: (entity) =>
    entity === "Book" ? { metadata: bookService.engine.metadata, config: bookService.engine.config } : undefined,
});
```

An entity with no `filterableEntities` entry rejects any `filter[...]`
query param with `400` before the stream opens — filtering is opt-in per
entity, not a fallback that silently does nothing. A malformed filter
(bad operator, depth over `query.maxFilterDepth`, too many `in` values, …)
gets the same `400` REST would give it, via the same
`QueryValidationException`. A filter field that is not one of the entity's
own columns — a relation path, a computed field — is also rejected with
`400`: the in-memory evaluator (§4.2) has no join to walk and no
before-image to reach a relation's current value with, and a subscription
that silently never matches is worse than one that never opens.

A filter field must also be in `subscribableFields`, when configured — a
subscriber cannot scope itself by a field it isn't allowed to receive.

### 4.2 Evaluation

Once parsed, the `FilterExpression` is stored on the connection and
evaluated per candidate subscriber, per publish, by `evaluateFilter`
(`packages/core/src/query/filter-evaluator.ts`) — no adapter, no query
builder, no DB round trip. It follows SQL's three-valued-logic convention:
a `null`/missing item value makes every operator except
`IS_NULL`/`IS_NOT_NULL` evaluate to `false`, including `NE`/`NOT_IN` (naive
`!(null === x)` would otherwise include a null row a real `!= x` predicate
excludes). `LIKE`/`ILIKE` translate to an anchored `RegExp`, escaping every
regex metacharacter in the literal portion first — this runs once per
subscriber per publish for the life of a long-lived connection, so an
unescaped pattern is both wrong and a ReDoS surface, not just wrong.

### 4.3 Filter-boundary crossings (ADR-0024)

A write can move a row across a subscriber's filter boundary:

| Transition                                          | Delivered as                                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Row didn't match, write makes it match ("enter")    | The ordinary event id (`updated`/`patched`/`restored`) — **not** a synthesized `"created"`.                                                                            |
| Row matched, write makes it stop matching ("leave") | **Nothing.** No before-image is available to detect this without an extra read the engine does not otherwise do — a documented limitation, not a silently-wrong event. |
| `"deleted"` (item is `null`)                        | **Always**, regardless of filter — there is nothing to evaluate against.                                                                                               |
| `"restored"`                                        | Evaluated normally against the restored item (it has one).                                                                                                             |

The `"deleted"` bypass is a confidentiality tradeoff, not only a staleness
one: a subscriber on `filter[ownerId][eq]=me` learns the `id` of every row
deleted on the entity, including ones it never had visibility into.
Acceptable only because subscriber-level authorization is already out of
this seam (§6) — a filter narrows _which_ events a subscriber receives, not
_whether_ they were authorized to.

## 5. `subscribableFields`: unconditional payload narrowing

`RealtimeSettings.subscribableFields` (or `@kavo/sse`'s equivalent
callback) bounds an outgoing `item` **unconditionally**, once configured —
not only when a subscriber names a `fields` query param, the same way
`allowlists.selectable` bounds a REST response whether or not the caller
asked for a subset. A `fields` param narrows further _within_ that bound;
it can never widen past it. A `filter` field must also be in this
allowlist (§4.1) — a subscriber cannot see, or scope itself by, a field
outside it.

## 6. Authorization

Out of scope for `@kavo/sse`, deliberately, since #154/#155:
`RealtimeTransport`'s own doc comment is the authoritative statement — a
transport that fans `channel`/`entity` into a pub/sub topic without
checking, per subscriber, whether that principal could have read the row
over REST leaks it to every subscriber of that channel, filtered or not.
Row/tenant-level subscriber scoping (`authorize`) is future work.

`@kavo/sse` also has **no authentication of its own** — `handleRequest`
accepts any subscribe request that otherwise validates. A deployment that
needs to gate who may open a stream does so in front of `handleRequest` (a
reverse proxy, or the host framework's own guard/middleware on the mounted
route); `handleRequest` is an ordinary `(req, res)` handler for that
purpose, nothing more. `subscribableFields` narrowing and subscribe-time
filtering are the only things bounding what a connection can _see_, and
neither is an access-control mechanism — worth restating given how easy
`filter[ownerId][eq]=me` reads as if it were one (§4.3, §5).

## 7. Known limitations

- **No resume-on-reconnect.** `@kavo/sse` frames carry an `id:`, but
  nothing reads `Last-Event-ID` yet.
- **No multi-node fan-out.** `@kavo/sse`'s channel registry is one
  process's in-memory `Map`.
- **No "leave" event on an ordinary write** (§4.3) — only a genuine
  `"deleted"` reliably tells a filtered subscriber a row is gone.
- **No filtering by which fields changed** (`RealtimeEventDto.changed`) —
  a subscribe-time filter matches row _data_, not the write's diff.

See also: ADR-0023 (why registered transports live outside `KavoSettings`),
ADR-0024 (channel/vocabulary/filter decisions above), and doc 05 (the
filter grammar this seam reuses).
