# 07 — CRUD Engine

`KavoEngine` (`core/src/engine/kavo-engine.ts`) is the authoritative
request lifecycle. Both entry surfaces — the programmatic
`DefaultKavoService` and the generated NestJS routes — build the same
transport-agnostic `KavoRequest` and run the identical pipeline.

## 1. Lifecycle (Template Method; every boundary a seam)

```
KavoRequest
 → Operation Resolution   registry lookup; disabled/unknown → OperationDisabledException
 → Config Resolution      settingsFor(operation) + per-call overrides (parameters, never writes)
 → Query Resolution       reads only: WireQuery → normalizeWire, QueryContext → normalizeInput
 → Context Assembly       KavoContext: identity, config view, principal, transaction ⟨reserved⟩,
                          normalized query, correlationId, typed state bag
 → Policy                 configured operations.<id>.policy node, if any → 403 (ADR-0032)
 → Precondition Check     If-Match writes only: pre-read + hash → 412 / 404 (ADR-0020)
 → DTO Resolution         descriptor.input/output else the doc-4 slot default
 → Deserialization        writes only: body → allowed-key projection
 → Handler Execution      OperationHandler from the registry (built-in, overridden, or custom)
 → Response Mapping       item / ListResultDto envelope / void, by descriptor.cardinality
 → Serialization          DTO mapping → field selection
 → ETag                   single-item responses: hash the representation; If-None-Match → notModified
KavoResponse
```

Deliberately lean: no validation stage, no hooks. Cross-cutting behavior
otherwise lives in the consumer's own code around Kavo — the v6 tradeoff
a policy stage alone crossed (ADR-0032): it is one config key resolved
once at bootstrap and enforced for every operation by the engine itself,
not a mechanism a consumer wires by hand.

`createOne` and custom **write** operations share one input-resolution
branch: the deserialized body alone when the request carries no id, or
`{ id, body }` when it does (a custom operation addressed by `:id` needs
the id to identify its target, and `request.id` is simply absent for
`createOne`). A custom **read** follows `findOne`/`findMany` instead: there
is no request body to deserialize, so its input is the coerced id when the
route names one and `null` when it does not, with everything else on
`context.query`.

## 1a. Declaring a custom operation (ADR-0006, issue #145)

An `operations` key that is not one of the eight standard ids declares a
whole operation rather than configuring an existing one:

```ts
createCrud(Order, {
  operations: {
    markPaidOne: {
      handler: { async execute({ id, body }, context) { … } },
      meta: { routes: { method: "POST", path: ":id/mark-paid" } },
    },
  },
});
```

| Key           | Required | Default   | What it decides                                                                                                                           |
| ------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `handler`     | yes      | —         | The behavior. There is no built-in to fall back to.                                                                                       |
| `kind`        | no       | `"write"` | `"read"` runs query resolution and takes no body; `@kavo/nest` binds `@Query` instead of `@Body`.                                         |
| `cardinality` | no       | `"one"`   | `"many"` maps the result through the list envelope, so the handler returns a `FindManyResult`.                                            |
| `enabled`     | no       | `true`    | `false` registers the entry inert, exactly as it does for a standard id.                                                                  |
| `dto`         | no       | —         | `input`/`output` on a write, `output`/`query` on a read. The wrong field for the resolved `kind` is a bootstrap `ConfigurationException`. |
| `meta`        | no       | `{}`      | Framework metadata; in `@kavo/nest` the route (doc 10).                                                                                   |
| settings keys | no       | —         | The operation scope of the precedence chain, same as any standard id.                                                                     |

Everything downstream treats the entry as ordinary. The engine dispatches it
through the same lifecycle; DTO resolution falls back to the entity's own
`item`/`list` slot and writable projection when `dto` names nothing; the
response is serialized, ETagged and conditionally answered like any other.
`If-Match` is the one thing a custom operation cannot have evaluated for it:
nothing in the schema says which row it targets, so the request is refused
rather than performed unguarded (§3a).

That DTO fallback is where the genericity has a sharp edge, and it is worth
naming rather than leaving as an inference. A standard operation's result
_is_ the entity, so falling back to the entity's projection loses nothing. A
custom operation's result is whatever its handler returns, so the same
fallback silently filters it to the entity's columns — and a result sharing
no field with them survives as `{}`. That shipped with a 201 and no signal
of any kind, while `CustomOperationResult` typed `run`'s return as the
handler's own return type, so the static types promised the shape the wire
did not carry (#181).

`mapResponse` now refuses that case: a **custom** id whose result carried
something and projects to zero keys raises `ConfigurationException`
(`operations.<id>.dto.output`). Four details decide what it catches and what
the message says.

**What counts as "carried something"** is deliberately wider than "has own
enumerable keys", which was the first cut and let three shapes through in
silence — the exact symptom the guard exists to end. `Object.keys` misses a
class instance whose fields are accessors, while `DefaultSerializer.project`
emits with `key in source` and does not; it also misses a `Date`. And a
non-empty **array** is what a handler that meant `cardinality: "many"` and
left it at the default returns. All three now raise. A literally empty `{}`
is still exempt: returning nothing meaningful is not a shape mistake.

**Zero intersection is the test**, not "narrower than the result" — a genuine
narrowing is exactly what the projection is for, so a result mixing entity
fields with its own is still stripped silently.

**The message names what the result was projected _through_.** With no
`dto.output` it names the entity and says to declare one. With one registered
it names that class and its keys, because the entity's fields are irrelevant
and telling an author to declare a DTO they already declared sends them to
fix the thing they got right. With one registered that has **no runtime
shape** — the declared-only class `@kavo/nest` supports on purpose, so
Swagger's decorators can answer — it names the missing initializers, since
the projection has silently fallen back to the entity.

**Two scopings.** The guard is skipped under an explicit `fields=`, which can
empty a projection on its own and would make the message blame the wrong
thing; and it is scoped to custom ids, because a standard operation's empty
projection is a different bug that `dto.output` does not fix.

The pattern is `withListMeta`'s: a handler that returned a shape the envelope
cannot use fails at request time, keyed to the operation, rather than
assembling something broken. It is a request-time `KAVO_CONFIG_INVALID`,
which is why doc 06's catalog row covers both that and the bootstrap case —
and it fires _after_ the handler ran, so a write it made through
`context.repository` stands.

In code it is called through `service.run("markPaidOne", { id, body })`,
which is the same `engine.execute` the eight named methods make, typed from
the operation's own `dto` override or, failing that, from the registered
handler's signature.

The handler reads and writes through `context.repository`, its entity's own
`RepositoryAdapter` (ADR-0025):

```ts
async execute({ id }: { id: EntityId }, context: KavoContext<Order>) {
  const order = await context.repository.findOneById(id, null, context);
  if (order === null) throw new NotFoundException({ … });
  return context.repository.patch(id, { paidAt: new Date() }, context);
}
```

Passing the same context back is what makes the call inherit the active
transaction, the resolved soft-delete strategy and the per-call settings
view. It matters most under `@Kavo`, where this config literal is evaluated
when the controller class is defined (ADR-0012) and there is no adapter,
infrastructure or `DataSource` in scope to close over.

One thing such a write does not do is notify realtime subscribers: the
event vocabulary is keyed by standard operation id (doc 18), so a custom
operation emits nothing however it changes the row.

Two bootstrap errors are worth knowing about, both naming the entity and
the key path. A custom entry with no `handler` cannot run, so it is refused
rather than registered. And an id that differs from a standard one only by
case (`deleteone`) is refused too: it would otherwise register a second,
unrelated operation beside the real `deleteOne` while the configuration the
author meant went unapplied.

Custom entries are registered **ahead** of the standard table. That is a
routing decision rather than a dispatch one, and doc 10 covers it.

## 2. `KavoContext` contents

Entity + operation identity, the resolved config view (with per-call
settings already merged), `repository` (the entity's own
`RepositoryAdapter`, which is how every handler reaches persistence,
ADR-0025 and §1a), `principal` (opaque to core, copied from
`KavoCallOptions.principal` and `null` when the caller sent none — the
framework layer fills it per request from the module's `principal`
extractor, doc 10 §1a), `transaction` (an opaque handle a programmatic caller may
pass through `KavoCallOptions`; `null` otherwise, and nothing in v6 creates
one — the adapter-level hook is reserved), the normalized
query for reads (`null` for writes), a `correlationId` (generated if the
caller didn't forward one), and the typed `state` bag
(`StateKey<T>`-keyed) for custom handlers to pass data.

## 3. Built-in handlers

Ordinary registry entries (ADR-0006), one adapter call each plus the
"missing vs. error" decision — adapters return `null`, handlers raise
`NotFoundException`. The adapter they call is `context.repository`, the
same one a custom handler is handed (ADR-0025), which is why
`builtInHandlers()` needs no argument and why one of these handlers can be
wrapped and registered from a `@Kavo` config, where no adapter exists yet.
Passing one (`builtInHandlers(replica)`) overrides that choice for the
handlers it returns and means only that. `findMany` returns `{ entities, total, meta?, hasMore? }`
where `total` is only computed when `pagination.count` is true (a separate
count query, never `getManyAndCount`), and `hasMore` is the has-more
signal `meta.nextCursor` needs under cursor pagination (§3.1, ADR-0021):
the built-in handler over-fetches `limit + 1` rows from the adapter, drops
the sentinel row, and reports whether it was there. That over-fetch lives
in the handler, not in the adapters, so `EntityReader`'s contract stays
"return exactly what the query asks for" and a third-party adapter needs
no cursor awareness beyond honouring `readFilter` — only the built-in
`findMany` handler sets `hasMore`; a replacement handler that omits it is
taken at its word: no signal, no next page. `deleteOne`/`restoreOne`/
`purgeOne` are equally ordinary entries — the delete strategy is resolved
in config and applied by the adapter (doc 11), so no handler branches on
it. The batch (`*Many`) entries are registered **disabled**: calling one
raises `OperationDisabledException` and no route generates — a real seam,
not a TODO.

The engine also coerces URL path ids against the id column's kind, so
`GET /users/abc` on a numeric key is a clean 400 rather than a driver
error.

### 3.1 The list envelope's `meta`

`FindManyResult.meta` is optional and the built-in handler never sets it,
so a zero-config list carries no `meta` at all. What makes it a real seam
is that response mapping **merges** what it finds there rather than
discarding it (issue #122): an overriding or wrapping `findMany` handler
returns `meta` alongside `entities`/`total`, and it lands on
`ListResultDto.meta` verbatim. `meta` is caller data, not entity data, so
it never passes through the serializer — no DTO projection, no `fields=`
selection, no renaming.

`ListResultDto.meta` is the envelope's one **optional** field, and the
contrast with `total` is the reason. `total` reports `null` rather than
disappearing when `pagination.count` is off, because every list answers
"how many matched" and `null` is that answer; an empty `meta` answers
nothing, and the zero-config list — the common case — is exactly what
would pay for it on every response. So emptiness means omission: the key
is left off the object entirely, not set to `undefined`, or `Object.keys`
and `JSON.stringify` would disagree about whether the envelope has one.
Emptiness is judged after the merge, so a contributor returning `{}` is
indistinguishable from no contributor. Consumers read `meta?.x`.

`KavoEngine.listMeta` is that single merge point, named rather than
inlined because the handler is only the first contributor. Under cursor
pagination it computes `meta.nextCursor` itself (ADR-0021) — `null` on
the last page, otherwise `encodeCursor` over the last returned row's sort
values — and that computed value is the **base** that the handler's own
`meta` (or a `withListMeta` contributor's) merges over: a contributor that
names `nextCursor` explicitly wins, the same "more specific wins"
direction every other precedence chain in Kavo runs. `listMeta` also
raises `ConfigurationException` when the token it just computed equals the
one the request carried — that equality is what an adapter ignoring
`readFilter` looks like from here (every page would echo the same cursor),
and erroring beats looping a client forever.
`withListMeta(handler, compute)` (`core/src/engine/with-list-meta.ts`) is
the ergonomic wrap for the common case; its merge precedence is the
contributor's keys over the wrapped handler's, matching the direction
config precedence already runs (global → entity → operation → per-call).
It is typed against `OperationHandler<Entity>` so it composes with
`builtInHandlers(...)` and `OperationConfig.handler` without a cast, which
erases the output type — hence the runtime shape check that raises
`ConfigurationException` instead of assembling a malformed envelope.

Not to be confused with `OperationConfig.meta` (`OperationMetadata`,
ADR-0007): that is route/framework metadata on a registry entry and never
reaches a response body.

## 3a. Conditional requests (ADR-0020)

`cache.etag` (doc 08, default on) makes every single-item response
carry a strong `ETag` — a SHA-256 of the **canonicalized serialized
representation**, keys sorted so a DTO field reorder is not a spurious
cache miss. Collection responses carry none. The tag and a
`notModified` flag ride on `KavoResponse`, so any transport can act on
them; `@kavo/nest` turns them into the `ETag` header and a `304`.

`If-Match` is the one stage that needs a read the handlers cannot give
it: `KavoEngineDependencies.repository` is what it reads through. The
engine re-reads
the target through that adapter, hashes the row's **canonical read
representation** (what `findOne` with no `fields`/`include`/`sort`
would return, `withDeleted` on a soft-deletable entity so the same read
serves a deleted row), and raises `PreconditionFailedException` (412)
when no supplied token matches. It runs on every standard write that
targets one identified row — `updateOne`, `patchOne`, `deleteOne`,
`restoreOne`, `purgeOne`.

Everything outside that set is **refused, never dropped**:
`PreconditionUnsupportedException` (412
`KAVO_PRECONDITION_UNSUPPORTED`) for an operation that targets no
single row (`createOne`, any custom operation), for `cache.etag`
being off, and for `findOne` not being enabled — the three ways the
check cannot run on a request that changes state. Reads are the one
exception and ignore `If-Match` outright, since a safe method cannot
lose an update. A row with no current representation is left to the
handler rather than 404'd here, so `DELETE` on a soft-deleted row is
the same 409 with or without the header. `If-Match: *` short-circuits
before the pre-read: the comparison answers it without a tag.

This is application-level check-then-write, **not** an atomic
compare-and-swap; the race window is real and stated in the ADR.

## 3b. Result cache (ADR-0031)

`cache` (doc 08, default off) short-circuits `findOne`/`findMany` before
the handler: a hit serves the response without the adapter, the serializer,
or a DTO. The lookup sits **after** `checkIfMatch` — a failed `If-Match` on
a write never becomes a stale cache read — and **before** the handler.
Only the two standard reads are cached; a custom read is never cached
however cheap its handler, and write responses are never stored. The store
is `ResolvedEntityConfig.cacheStore`, a live object registered on
`KavoOptions` (ADR-0023, ADR-0031) — never a settings key.

The key is `operation:targetId:canonicalize(queryFingerprint(query))`, and
the entity name is a separate parameter the store keys on. The target id
rides on `request.id`, outside the normalized query, so it must be a key
part or `findOne(1)` and `findOne(2)` would share one entry.
`queryFingerprint` is a plain-data projection (`filter`, `sort`,
`pagination`, `fields`, `include`, `withDeleted`, `onlyDeleted`, `count`)
folding each include node to its query-decided parts, because the include
tree carries live `RelationDescriptor`s `canonicalize` must not serialize.
Per-call settings are deliberately not in the key; the one known
response-reshaping case without a query change is `softDelete.strategy`,
stated as a limitation rather than silently answered wrong.

After any successful write — standard or custom — the entity's every entry
is dropped (`invalidateCache`): nothing about a write's payload tells the
engine which cached queries it changed, so whole-entity is the only correct
granularity. A hit still recomputes the current `etag` off the cached
`item` and answers `If-None-Match` (ADR-0020), and clones the payload
(`structuredClone` through the same typed `WebGlobals` accessor `etag.ts`
uses), so shared storage is never corrupted by one caller mutating a
returned item. Every store call is wrapped: a store that throws costs a hit
or an invalidation, never the read or the write (ADR-0031).

## 4. Patterns

The engine's share of the catalog; the full list, with implementation
files and the ADR behind each, is
[doc 01 §6](01-system-architecture.md#6-design-patterns-and-why).

- **Template Method** — the fixed lifecycle above.
- **Strategy** — repository adapter, serializer/deserializer, pagination
  strategies, error handler: all constructor-injected interfaces.
- **Dependency Injection** — `KavoEngineDependencies` is plain
  constructor injection; no container in core (`@kavo/nest` provides
  one at the framework layer).

## 5. Root factory (`createKavo` / `createCrud`)

`createKavo(options)` holds the global scope; `createCrud(Entity,
config?, runtime?)` is bootstrap: resolve config (doc 08), build the
registry with built-in handlers, wire serializer/deserializer/normalizer
from entity metadata, and return the bound service. Metadata and adapter
come from `options.infrastructure` (the ORM package's implementation of
the seam) or per-call `runtime` overrides — which is what makes the
engine fully testable with an in-memory fake and no ORM anywhere
(`core/tests/engine.spec.ts`).
