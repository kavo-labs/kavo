# ADR-0019 — Computed fields are serializer-evaluated, and never filterable, sortable, or writable

**Status:** superseded by [ADR-0046](0046-derived-fields-come-from-orm-metadata.md)

> Issue #373 removed `computed` (`ComputedFieldDescriptor`/`ComputedFieldMap`,
> `EntityConfig.computed`, and all serializer/deserializer wiring for it)
> entirely from `@kavo/core`. This document is kept for history — the
> problem it solved is now solved by reading a derived field's definition
> from ORM metadata instead of a resolver function; see ADR-0046 for the
> replacement design and its accepted capability regression (no more
> context-varying resolved value).

## Context

Every projection Kavo derives comes from the metadata seam (ADR-0011),
which describes **columns**. A field with no backing column — `fullName`
from `firstName`/`lastName`, a formatted total, a caller-dependent flag —
therefore has nowhere to live. The workaround that appeared to work was
registering an `item` DTO naming a property that the entity class happens
to expose as a getter: `DefaultSerializer` copied it because `key in
source` was true. That is an accident of TypeORM handing the engine class
instances. `@kavo/prisma`, `@kavo/mongoose`, and any adapter returning
plain rows carry no getter, so the same config silently emitted nothing —
and no ORM's rows made the field reachable through `select=`, because the
`selectable` allowlist derives from columns alone.

Making such a field first-class raises one question with a wrong obvious
answer. A field the client can _see_ looks like a field the client should
be able to filter and sort on, and every other selectable path is. But
filtering and sorting are pushed down to the database: the filter
translators turn a path into `WHERE`/`ORDER BY` against a column that must
exist. Honoring `filter[fullName][eq]` would mean fetching rows and
evaluating the predicate in memory — which silently breaks pagination
(`limit`/`offset` are applied by the database, before the predicate),
`total`, and every performance property the query grammar is built on.
The alternative, "just add the field to `selectable` and hope nobody
filters", is exactly the fail-open posture `resolveAllowed` exists to
prevent.

Where the field is evaluated is the other half. Nothing in the pipeline
before response mapping can produce it: the adapter fetches columns, the
query normalizer validates paths, the handlers move rows. Response
mapping is also the one stage that already sees the fully-hydrated entity
and the request context together.

## Decision

An entity may declare **computed fields** — `EntityConfig.computed`, a
record of `ComputedFieldDescriptor<Entity>` keyed by the name each
serializes as — and they are governed by four rules.

**1. Serializer-evaluated, post-fetch.** `DefaultSerializer` produces a
computed key by calling the descriptor's `resolve(entity, context)`,
never by reading it off the row. That is the only stage involved, which
is what makes computed fields behave identically for a TypeORM class
instance and a Prisma/Mongoose plain object, and why **no ORM adapter
changes**: no adapter consumes `query.select` (selection is "kept
internally, stripped late"), so every row arrives fully hydrated and a
computed field's source columns are always present, even under
`select=fullName`. There is no dependency declaration and none is needed.

`resolve` is **synchronous** and runs once per served item. An
async or database-hitting resolver is not offered: it would reintroduce
per-row N+1 at exactly the stage the include resolver exists to batch. An
`async resolve` is a bootstrap error rather than a slow success, because
the serializer emits the return value unawaited and the response would
silently carry `{}`. Returning `undefined` omits the key and `null` emits
it, the same distinction the column branch draws.

`resolve` must also be **total**, which is a stronger requirement than
pure and the one that actually bites. `serializeList` is an unguarded
`entities.map(...)` and nothing downstream catches a resolver, so a
single row the resolver cannot handle takes down the whole collection
response — for every caller, not just that row, until the row is
repaired. `todo.title.toLowerCase()` against a nullable column is
therefore a latent outage, not a style issue: a client may `POST`
`title: null` (the computed key is stripped from the payload, `title` is
an ordinary column, the write succeeds) and `GET /todos` answers 500
from then on. Resolvers are written defensively —
`todo.title?.toLowerCase() ?? null`. The serializer deliberately does
**not** swallow the throw: everything else in the pipeline fails loudly,
and a caught resolver would turn a config bug into a field that is
sometimes silently absent.

Because selection is "kept internally, stripped late", `resolve` receives
the **fully hydrated row**, not the projected object. A computed field
can therefore surface a column that a narrowed `item` DTO or `selectable`
list hides. That is intended rather than a leak — `resolve` is
server-authored code at the same trust level as `exposeInternals` — but
it means the resolver, not just the DTO, is part of the exposure
decision.

**2. Present by default, narrowed like any other field.** A declared
computed field joins the entity-derived `item`/`list` projection with no
DTO registration, and joins the `selectable` allowlist unless the
descriptor sets `selectable: false`. Both narrowing mechanisms then apply
unchanged: an explicit `item`/`list` DTO that omits it hides it, and
`select=` narrows it away. The normative order is untouched — DTO mapping
first, then field selection; selection never widens.

**3. Never filterable, never sortable.** Not deferred — rejected. A
computed field never joins the derived `filterable`/`sortable` allowlist
configurations, and naming one in a configured `allowed.filterable` or `allowed.sortable` is a
bootstrap `ConfigurationException`. In-memory post-fetch filtering is not
a future option here; a caller who needs to filter or sort on a derived
value wants a real generated column, which every supported ORM already
offers.

**4. Never writable**, in two layers. A registered
`create`/`update`/`patch` DTO naming a computed field is a **bootstrap
`ConfigurationException`**, like every other computed misdeclaration: the
declaration is judgeable once, at `createCrud`, and a silent per-request
drop is the wrong report for it. It also has a wire consequence no
runtime strip can reach — `@kavo/nest` builds `@ApiBody` from the DTO's
runtime shape, so OpenAPI would advertise a property the engine
unconditionally discards. (A raw body key naming a computed field is
still just dropped; that is an unknown key, not a declaration.)

Underneath, `DefaultDeserializer` strips computed names from every write
payload regardless. Keeping them out of the derived writable projection
is _not_ sufficient on its own — a registered DTO replaces that
projection wholesale (`dtoShapeKeys(dto) ?? this.writableProjection`) —
and `DefaultDeserializer` is exported, so its contract is "a computed
name never reaches the adapter" on its own terms, not "the config
resolver checked first". Through `createCrud` the bootstrap error makes
the strip unreachable; it stays as the guarantee for a deserializer
constructed directly.

Further declarations are bootstrap errors for the same
fail-fast-with-the-key-path reason: a computed name colliding with a real
column or relation (the shadowed value would silently vanish from every
response), a descriptor with no `resolve` function, and the name
`__proto__`, which is not an ordinary object key and would disappear from
the resolved map without a word. `__proto__` has to be caught twice: the
computed-key spelling (`{ ["__proto__"]: … }`) creates an own key and is
rejected by name, while the object-literal spelling (`{ __proto__: … }`)
invokes the prototype setter and never reaches `Object.keys` at all — it
is detected by checking the declared record's prototype.

`computed` carries functions, so — like `dto` and `relations` — it is
**entity-scope structural config, outside the settings precedence chain**:
it is absent from `SETTINGS_KEYS`, never merged global → entity →
operation, and unreachable from a per-call `KavoCallOptions.settings`
override.

At the type level, `EntityConfig` takes an eighth parameter, `Computed`,
inferred from the keys of `computed`. It widens `allowed.selectable`
to `FieldPath<Entity> | Computed` so an explicit selectable list can name
a computed field without a cast — and, deliberately, widens nothing else,
so rule 3 is a compile error before it is a bootstrap error.

## Consequences

- A computed field on a relation **target** works with no extra machinery:
  the serializer already resolves an included node's projection from the
  target's own `ResolvedEntityConfig` through the `EntityCatalog`, and
  that config now carries `computed`. A relation still cannot widen what
  its target exposes.
- What that composition does **not** give it is a context of its own. One
  response is one request, and `KavoContext` describes that request, so a
  target's resolver is handed the _root_ operation's context:
  `GET /posts/1?include=author` gives an `Author` computed field a context
  whose `entityName`, `operation`, `config`, `query` and `repository`
  (ADR-0025) are Post's. Only
  the request-scoped members — `app`, `correlationId`,
  `transaction`, `state` — are meaningful from a relation target. A
  per-target context was rejected as a worse lie: it would have to invent
  an `operation` that no caller issued and a `query` that was never
  normalized against that entity.
- `selectable: false` narrows the allowlist, not the projection. The field
  stays in the default response and its name becomes a 400 in `select=`;
  a request that sends any fieldset still drops it, with no way to ask for
  it back. That follows from rule 2 rather than contradicting it —
  selection narrows uniformly — but it is the one place the flag's name
  reads as a stronger promise than it makes.
- `ResolvedEntityConfig` gains a required `computed` member. It is
  produced by Kavo and read by the serializer/deserializer; anything
  constructing one by hand has to supply it.
- Static typing of the _response_ is unchanged: the entity-derived
  `ItemDto` does not grow the computed key. A caller wanting the field
  statically typed registers an `item`/`list` DTO naming it, exactly as
  for any other narrowing today. Deriving it automatically was considered
  and left out — it would mean synthesizing a response type from a config
  value, which every other DTO slot deliberately does not do.
- The **generated OpenAPI response schema** has the same gap for the same
  reason. `@kavo/nest`'s `successBodyFor` falls back to the entity class
  when no `item`/`list` DTO is registered, so `GET /todos/1` returns the
  computed field at runtime while the document does not mention it.
  Registering an `item`/`list` DTO naming the field is the one escape
  hatch for both consequences at once.
- **A throwing resolver is a 500 labelled `KAVO_PERSISTENCE_FAILED`.**
  Nothing in core catches `resolve`, so it takes the engine's ordinary
  untranslated-error path: the original error is preserved as `cause` and
  its message is never leaked into the problem-details body. The code is
  the existing catch-all rather than a truthful one — "persistence
  failed" is a poor label for caller code running at response mapping,
  and a dedicated code was not worth a new entry in the stable catalog
  for a case the cause already identifies. Note where in the lifecycle
  this lands: response mapping runs **after** the handler, so on
  `createOne` the row is already committed when the 500 goes out. A
  client that retries duplicates it.
- The extension point, if a later version wants derived values the
  database can filter on: that is a generated column, declared through
  the ORM and surfaced by the metadata seam as an ordinary field — not a
  second mode of this feature.
