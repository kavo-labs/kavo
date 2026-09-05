# 10 — NestJS Integration

`@kavo/nest` turns one decorator into a full CRUD controller:

```ts
@Kavo(UserEntity)
@Controller("users")
export class UserController {}
```

`@nestjs/common`/`core` are peerDependencies; `@nestjs/swagger` is an
optional peer. The package never imports an ORM adapter (ADR-0002
boundary) — infrastructure arrives through DI.

## 1. Module design

- **`KavoModule.forRoot(options)`** (global): creates the Kavo root
  instance (`createKavo` skin — `defaults` passes through untouched),
  registers the problem-details exception filter app-wide (`APP_FILTER`),
  exposes `KAVO_INSTANCE`, and registers `KavoBinder`. **`forRootAsync`**
  resolves the options via `useFactory`/`inject` — the checkpoint app uses
  it to wait for the `DataSource` before building
  `createInfrastructure(dataSource)`.
- **`KavoBinder`** (`onModuleInit`, internal): uses `@nestjs/core`'s
  `DiscoveryService` to find every `@Kavo`-decorated controller already in
  the app's module graph and assigns `kavo.createCrud(entity, config)`
  directly onto `this[KAVO_SERVICE_PROPERTY]` — bootstrap happens here,
  once per controller. This is what makes a plain Nest `controllers:` array
  (in `AppModule` or anywhere else) sufficient on its own; no explicit
  per-entity registration is needed for the generated route methods, which
  only read that property at request time, well after `onModuleInit`.
  The configured `app` context extractor rides the same pass onto
  `this[KAVO_APP_CONTEXT_PROPERTY]`, for the same reason and with the same
  timing (§1a).
- **`KavoModule.forFeature(controllers)`**: registers the controllers
  (redundant if they're already in some module's `controllers:` array) and
  additionally provides the entity's service under
  `getKavoServiceToken(Entity)` as a real DI provider. Reach for this only
  when some class needs to constructor-inject that token itself — a
  resolution that happens at instantiation time, before `onModuleInit` has
  run, so it can't rely on the binder. A non-`@Kavo` class fails fast with
  a `ConfigurationException`. Inside a `@Kavo`-decorated class itself,
  prefer `boundKavoService(this)` over constructor injection — the binder
  has already bound it by the time any request arrives.
- **`KavoModule.forFeature()`** (no arguments): the same DI-provider half
  of `forFeature`, but for every `@Kavo`-decorated class the process has
  seen so far, read from the decoration-time registry `@Kavo` itself
  populates — no controller list, and no `controllers:` field in the
  returned module (the caller already put them in an ordinary Nest
  `controllers:` array). This is what lets a normal app get constructor
  injection everywhere with one stable call that needs no updates as
  controllers are added or removed. Fails fast if two different
  controllers registered the same entity — the provider token is
  per-entity, so which config would win is otherwise silently ambiguous.
  Scoped to the whole process rather than one app's module graph, which is
  exactly why `@kavo/nest`'s own tests — many differently-configured
  `@Kavo(Todo, ...)` classes declared across one file's test modules —
  always pass `forFeature` an explicit array instead.
- **`{ provideServices: true }`** on `forRoot`/`forRootAsync` folds the
  no-argument `forFeature()` in directly — the same providers, merged into
  the same call — so a normal app states its Kavo config once instead of
  importing both `forRootAsync({...})` and a separate `forFeature()`.

**Singleton services, deliberately:** the engine threads every
per-request concern (app context, transaction, query, correlation id,
state) through `KavoContext`, so request-scoped providers would buy
nothing and cost per-request instantiation of the whole graph.

### 1a. The app context (a per-request value under a decoration-time route)

`KavoContext.app` is the application's request-scoped context — an
app-augmented `KavoAppContext`, replacing the removed `principal`
(ADR-0043). It reaches core one way only — `KavoRequest.options.app`,
which the engine copies onto the context (`KavoCallOptions` is per-call
scope, so this is a parameter, never a config write). A programmatic
caller fills it directly. A generated route has to build it from the
incoming request, and that is the awkward part: routes are generated at
decoration time (ADR-0012), while both the value and the rule for
building it are things decoration time cannot see.

The two halves split along that seam:

- **The rule** is a `KavoModule` option, `app`: a
  `(request) => KavoAppContext` extractor. It is bound once, in
  `KavoBinder`, onto the controller **instance** beside the service.
  Instance-scoped rather than on the prototype for the reason the service
  already is — the class is process-wide, so a second app in the same
  process would otherwise inherit the first one's options, which is every
  `@kavo/nest` test file.
- **The value** is resolved per request, inside `makeHandler`'s generated
  function, from the raw request that `applyParamDecorators` now wires as
  the layout's trailing `@Req()` parameter. Nothing is memoized between
  requests; nothing is read at decoration time.

Absent the option, the extractor is `undefined` and the handler sends
`options: null`, byte for byte the request an unconfigured route has
always sent, so `KavoContext.app` stays `{}` for an app that never opts
in. Kavo does not authenticate and does not judge: whatever the extractor
returns is carried opaquely (doc 01 §8), and a throwing extractor fails
the request rather than degrading to `{}`.

Methods Kavo does not generate reach the engine themselves, so nothing
fills `options` for them; `boundKavoAppContext(controller, request)` runs
the same configured extractor for an `@Override`'d method or a fully
custom route, which is why they get the request in the layout too.

## 2. Route generation (registry-driven, decoration-time)

The decorator builds the entity's operation registry with the same
`createOperationRegistry` the engine uses and generates a route per
**enabled** entry (ADR-0006, ADR-0012):

| Operation    | Route                | Status |
| ------------ | -------------------- | ------ |
| `createOne`  | `POST /`             | 201    |
| `findMany`   | `GET /`              | 200    |
| `findOne`    | `GET /:id`           | 200    |
| `updateOne`  | `PUT /:id`           | 200    |
| `patchOne`   | `PATCH /:id`         | 200    |
| `deleteOne`  | `DELETE /:id`        | 204    |
| `restoreOne` | `PATCH /:id/restore` | 200    |
| `purgeOne`   | `DELETE /:id/purge`  | 204    |

Disabled entries (config `operations.<id>: false`, or a default-off
entry) get **no route**. Any entry's route shape is overridable through
its own `meta.routes` (`method`, `path`, `successStatus`);
`meta.routes.enabled: false` keeps it service-only. Because generation
walks the registry, soft delete's restore/purge appeared by _enabling
entries_ — this generator did not change. Their enablement is
config-declared rather than metadata-driven, precisely because
decoration time has no ORM metadata (ADR-0013): `softDelete: { strategy:
"soft" }` adds the restore route, `operations: { purgeOne: true }` the
purge route.

**Global `defaults.operations.<id>` (issue #38, ADR-0015) is not seen
here.** `KavoModule.forRootAsync`'s `defaults` resolves only once its
factory runs, which is always _after_ `@Kavo` has already decorated
every controller and generated its routes (ADR-0012) — there is no
value to read yet at the moment this table's decision is made. A route
an entity doesn't disable itself therefore still generates, even under
a global `operations.<id>: false`. The bound service _does_ see the
global default (it's resolved through `createKavo`'s `createCrud`,
which runs at `onModuleInit`), so calling that route always answers
`405` with `code: "KAVO_OPERATION_DISABLED"` — never a silent success,
and never a bare `404` that would suggest the route was never mapped.
An app that wants the route itself gone still states so per entity,
exactly as before.

**Custom operations** (issue #145) need nothing in this generator either.
An `operations` key outside the eight standard ids is an ordinary registry
entry (doc 07 §1a), so the same loop routes it from its own `meta.routes`:

```ts
@Kavo(Order, {
  operations: {
    markPaidOne: {
      handler: markPaid,
      meta: { routes: { method: "POST", path: ":id/mark-paid" } },
    },
  },
})
@Controller("orders")
export class OrderController {}
```

An entry with no `meta.routes` falls back to `POST /<operation id>`, which
is the most a route generator can infer from a name it has never seen: a
write against the collection. Every rule above applies unchanged, including
`meta.routes.enabled: false` for a service-only operation, and both of the
mechanisms below.

The one thing custom operations change is **order**. Custom entries are
registered ahead of the standard table, and registration order is route
order, so a custom `GET /orders/pending` is matched before `GET /orders/:id`
rather than being swallowed by it and answered with "'pending' is not a
valid number". The same rule lets a custom entry whose `meta.routes`
reproduces a standard route's shape take that route, which is what an
explicitly configured route should do.

**Manual-method-wins:** a hand-written controller method whose name
matches an operation id suppresses that generated route — detected via
`hasOwnProperty` on the prototype, no config needed. It applies to a custom
id exactly as it does to a standard one.

**`@Override(operationId?)`** (issue #23) is the additive middle path
between a config-level `operations.<id>.handler` override and plain
manual-method-wins: the decorated method still gets the registry's route
— method, path, status, `@Param`/`@Query`/`@Body`, and Swagger metadata,
identical to what a generated route would carry — only the function
backing it is the decorated method itself, not `makeHandler`'s generated
one. `operationId` defaults to the method's own name, the same inference
manual-method-wins already uses. Resolution order in the `@Kavo` loop is
override map → manual-method-wins → generate, so a decorated method never
falls through to plain name-matching.

The mechanism needs no core change: `defineRoute`'s two jobs — installing
a generated function, then applying Nest's real method/param/status
decorators to whatever sits at that property — split into an
`applyRouteDecorators` step shared by both paths. For an override, Kavo
skips installing a function and applies that same step to the existing,
hand-written method; Nest dispatches to it directly at request time, with
no engine or `KavoEngine` involvement in the indirection.

The decorated method typically delegates to default behavior via the
entity's bound `DefaultKavoService`, reachable as `boundKavoService(this)`
(`this.base.createOne(dto)`), the same "base" pattern config-level
overrides get through `context` inside a plain `OperationHandler`.

Because Kavo owns the param wiring, the decorated method must accept
parameters in the same fixed position a generated route would — reads:
`(id?, query, preconditions, request)`; writes:
`(id?, body?, preconditions, request)`;
declare only as many as the method actually uses — and must not declare its own
`@Param`/`@Query`/`@Body`: `@Kavo` checks for existing Nest route-argument
metadata on the method and fails at decoration time (ADR-0012's only
moment) rather than let the two decorations collide silently. The same
fail-fast rule covers a duplicate override target (two methods claiming
one operation id) and an override naming an operation id that is absent
or disabled in the registry — a silent no-op override is a footgun.

**A read override's `query` parameter arrives already wrapped in
`WireQuery`** (issue #25) — `applyParamDecorators` is the single call site
that decides a read operation's `@Query()` decorator, shared by a
generated route and an `@Override`'d method alike, and it applies
`Query(new WireQueryPipe())` rather than a bare `Query()`. Nest's pipe
runs before either a generated handler or a hand-written override method
body executes, so both receive the identical normalized value — an
override does not need to (and should not) call `flattenQuery`/`WireQuery`
itself:

```ts
@Override()
async findOne(id: EntityId, query: WireQuery) {
  return this.base.findOne(id, query);
}
```

`flattenQuery`/`WireQuery` stay exported from `@kavo/nest`/`@kavo/core` for
the rare caller wiring a query param manually outside this fixed position;
the common case needs neither.

**Fully custom, registry-independent routes** (issue #26) are a separate,
simpler path that needs no `@Kavo` involvement at all — the way to add an
action with no operation identity of its own. (An action that _has_ one is
a custom operation instead: an `operations` key outside the standard eight,
issue #145, whose handler reaches data through `context.repository`,
ADR-0025.) The decoration-time
loop only visits methods two ways: manual-method-wins (name matches a
registry operation id) and the `@Override` map (name registered via
`@Override`). A method matching neither — carrying its own native
`@Get`/`@Post`/etc. decorator and its own `@Param`/`@Query`/`@Body` — is
never inspected by `@Kavo`; it is an ordinary Nest controller method that
happens to live on a `@Kavo`-decorated class. The only Kavo-specific
piece it typically wants is the entity's bound service, reachable the
same way an `@Override`'d method reaches it — `boundKavoService(this)`,
which reads the property `KavoBinder` already bound at
`onModuleInit`:

```ts
@Controller("users")
@Kavo(User)
export class UserController {
  private get base(): DefaultKavoService<User> {
    return boundKavoService<User>(this);
  }

  @Get(":id/summary")
  async summary(@Param("id") id: string): Promise<unknown> {
    const user = await this.base.findOne(id as never);
    return { headline: `${user.name} <${user.email}>` };
  }
}
```

This is the same "base" delegation pattern `@Override` and config-level
handlers use, without any of the registry machinery around it: no
generated method/path/status from config, no `@Override`-supplied
Swagger metadata, no automatic param wiring — the method owns all of
that itself, exactly as it would on a plain Nest controller with no
`@Kavo` in the picture. Reach for `@Override` when the action is one of
the standard operations and should keep getting its route/Swagger/param
metadata generated from config while only its implementation changes;
reach for a plain native-decorated method for anything else — an action
with no operation identity of its own needs none of that generated
machinery. `examples/nest-typeorm/src/address/address.controller.ts` shows
the split: `validatePostalCode` takes the plain native-decorated path,
while `normalizePostalCodeOne` is a custom operation, because correcting a
stored value on one row is an operation on `Address` and answering
`{ valid }` about it is not.

Mechanically, generated methods are defined on the prototype and
decorated by _calling_ Nest's own decorators (`Post(path)(proto, name,
descriptor)`, `Param("id")(…)`, …) — identical metadata to hand-written
syntax, so guards, interceptors, versioning, and prefixes compose
normally. The service arrives by property injection under a private key;
`WireQueryPipe` (internal to `@kavo/nest`) wraps `req.query` in core's
`WireQuery`, after `flattenQuery` normalizes qs-extended nested objects
back to flat bracket keys, making the binding query-parser-agnostic.

Every generated handler is one shape — build the `KavoRequest` from the
fixed parameter layout (`id?`, `query` or `body`, then
`preconditions`) and call `service.engine.execute`, returning the
envelope. It goes through the engine rather than the typed
`DefaultKavoService` methods because those unwrap to the item and
discard the `etag`/`notModified` the next section needs; it is the same
pipeline either way, since those methods are `execute` plus that unwrap.

### 2a. Conditional requests (ADR-0020)

Two pieces, both applied programmatically at decoration time:

- `ConditionalRequest()` — a `createParamDecorator` that reads
  `If-Match` / `If-None-Match` off the request into core's
  `RequestPreconditions`, applied as the last parameter of every
  generated method (and available to an `@Override`'d one that declares
  it, since both paths carry identical route metadata).
- `KavoResponseInterceptor` — applied **method-scoped, to every routed
  method** (generated and `@Override`'d alike), as an instance so it
  needs no DI registration. It sets the `ETag` header from the
  envelope, turns `notModified` into a bodyless `304`, and unwraps to
  `item`/`list` — being the innermost interceptor, nothing downstream
  ever sees the envelope. It acts only on an engine envelope, and an
  `@Override` reaches it holding one either way: `applyOverrideEtag`
  runs first and promotes a bare return into an envelope carrying the
  tag ([ADR-0027](/internals/adr/0027-an-override-inherits-the-etag-but-not-the-precondition)).
  What an override returning `service.engine.execute(...)` additionally
  gets is the `304`, since `notModified` is the engine's answer against
  the request's own `If-None-Match`.
- **`applyOverrideEtag`** (`kavo.decorator.ts`), applied only on the
  `@Override` path and only for `cardinality: "one"`. It replaces the
  method with one that awaits the original and, unless the result is
  already an envelope, is `null`/`undefined`, is an `Observable` or a
  `StreamableFile`, or the operation has `cache.etag` off, returns a
  `KavoResponse` carrying `computeEtag(result)`. It **copies every
  `Reflect` metadata key from the original onto the replacement** —
  Nest keys method metadata on the function object, so without that an
  `@Override` carrying `@UseGuards` or a `SetMetadata`-based decorator
  would be routed with it silently dropped.

`If-Match` enforcement is the engine's, not the binding's, so a method
that replaces a generated one bypasses it — `@Override`'d or plain
manual-method-wins. The tokens are still handed to the method (the
`ConditionalRequest` parameter is applied to both paths); forwarding
them as `{ preconditions }` or through `engine.execute` is what
re-applies the guard. ADR-0020 §7 states the same rule; the e2e in
`tests/caching.e2e.spec.ts` pins both arms.

`parseEntityTags` distinguishes an absent header from a present but
empty one: `If-Match:` yields `[]`, not `undefined`, so it evaluates
false and 412s rather than sliding through as an unguarded write.

Setting the status from an interceptor works because Nest applies the
route's static `@HttpCode` _before_ interceptors run and does not
re-apply it when replying. Both `header()` and `status()` are
duck-typed, so Express and Fastify are served by one interceptor — the
same trick as `ProblemResponse` in the exception filter. Kavo's tag is
set before Express would add its own weak one, and Express only fills in
a tag that is not already there, so ours wins.

Being innermost also means the tag is set before any outer interceptor
can rewrite the body. An app interceptor that redacts fields per role
therefore emits a hash of the _unredacted_ representation; redaction
belongs in the operation's `item` DTO, which the engine serializes
through before hashing.

## 3. Exception mapping

`KavoExceptionFilter` (`@Catch(KavoException)`) is the one boundary
between Kavo's hierarchy and HTTP: catalog status +
`application/problem+json` body via `toProblemDetails`, honoring
`errors.exposeInternals`. Kavo exceptions never extend Nest's.

## 4. Swagger integration

Optional and zero-cost when absent (`createRequire` probe, cached).
When `@nestjs/swagger` is installed, generated routes get: operation ids
(`User_findMany`), a `tags: [entity.name]` entry, `x-kavo-entity`/
`x-kavo-operation` vendor extensions on the operation object, the `:id`
param, the query params documented on list routes (doc 5), registered DTO
classes as body schemas (`ApiBody`), problem-details response schemas for
400/404, and the conditional-request surface (ADR-0020) — the `ETag`
response header, `If-None-Match` + `304` on single-item reads, `If-Match` +
`412` on single-row writes, gated on `cache.etag`.

The tag and both vendor extensions are derived only from `entity.name` and
`OperationDescriptor` (ADR-0012), so they apply identically to a standard
route, a custom operation (issue #145), and an `@Override`d route —
`applySwaggerMetadata` runs the same way for all three. They exist because
client generators like Orval and `openapi-generator` key file/module
splitting off `tags` (with none, every operation across every entity lands
in one flat client module), and because nothing else in the document links
an operation, or a generated DTO schema, back to the Kavo entity/operation
it came from. Every inline schema this module builds — `schemaFromDto`
request/response bodies, a list envelope's element, the `issue #264`
fallback body/response schemas, and each `oneOf` variant (schema hints,
below) — carries the same `x-kavo-entity` (`withKavoEntity`), and the
problem-details body plus its `errors[]` entry carry an `x-kavo-error`
marker. The one exception is the `{ type: DtoClass }` fallback path, where
`@nestjs/swagger`'s own introspection builds the schema instead of this
module: there is no inline schema object to stamp. `operationId`'s value
and format are unchanged.

Unlike the rest of this list, that gate can't be applied at decoration
time (ADR-0012): whether it's on depends on `cache.etag` resolved
through the _full_ precedence chain, and the global scope only arrives
later, with `KavoModule.forRoot`/`forRootAsync` (issue #198). So
`applySwaggerMetadata` documents everything else immediately but stashes
the route (`prototype`, `methodName`, `descriptor`, `route`) under
`KAVO_CONDITIONAL_DOCS_METADATA`; `KavoModule`'s discovery binder
(`KavoBinder`, the same `onModuleInit` pass that binds each entity's
service) reads it back once `service.engine.config.settingsFor(id)`
carries the entity's fully resolved settings, and calls
`applyConditionalRequestDocs` with the true `cache.etag`. A module
graph with no `KavoModule.forRoot`/`forRootAsync` — and so no working
`@Kavo` service either — never reaches this pass, so no route is left
half-documented.

The generic syntax of `filter`/`sort`/`limit`/`offset`/`select` (doc 5),
`include`/`select[relation]`, and `If-None-Match`/`If-Match` is documented
**once**, in the exported `KAVO_API_GUIDE` string (`swagger.ts`) — not
repeated as identical boilerplate on every route of every entity. An app
splices it into its own top-level document description
(`new DocumentBuilder().setDescription(...)`); the reference apps' `main.ts`
do this. Per-route `ApiQuery`/`ApiHeader` descriptions then carry only what
the guide can't say:

- `filter`/`sort`/`select` carry the entity's actual
  `allowed.filterable`/`sortable`/`selectable` fields, when decoration
  time can tell (issue #171). An **explicit array** selector resolves to
  exactly the same value `resolveAllowed` would produce, with no ORM
  metadata involved, so reading it straight off the raw `EntityConfig` is
  not a guess. The unconfigured default and an `{ exclude }` selector both
  resolve against the entity's own columns — ORM metadata that doesn't
  exist yet at decoration time (ADR-0012) — so those params carry no
  description at all, deferring entirely to the shared guide rather than
  imply a narrower list than actually exists.
- `include` carries which relations are actually includable on the entity,
  the same way. `select[relation]` carries no description at all — its
  relation name is already the param name.
- `limit`/`offset` and `If-None-Match`/`If-Match` carry no per-route
  description at all, either way: none of the four ever varies by entity.

The success-response schema is chosen by the descriptor's cardinality
rather than by a list of operation ids, matching what `mapResponse`
actually branches on: a `"many"` operation is documented as the list
envelope, everything else as the resolved `item` DTO, and a `204` as no
body at all. That is what gives a custom operation (issue #145) a real
documented response instead of a blank one.

A `"many"` operation wraps its `list` element in `listEnvelopeSchema`, whose
`required` names `items`/`limit`/`offset`/`total` — deliberately not
`meta`, which the engine omits unless a handler contributed (doc 07 §3.1),
so a generated client must treat it as optional. `meta` is also the one
envelope field with nothing to enumerate: `items` is projected through the
`list` DTO, so `schemaFromDto` reads real fields off it, whereas
`ListMetaDto` is an open `[key: string]: unknown` bag filled at request
time by handler code Kavo never sees. It is therefore published as
`additionalProperties: true` with a prose description rather than a bare
`{ type: "object" }`, which most generators read as an object permitting
**no** keys — the opposite of an open bag. Publishing a real per-entity
`meta` shape would need a new declaration seam and a decision about
whether it is merely documentation or an enforced projection; the GraphQL
binding has the same open question (doc 13 §"Out of scope").

The `issue #264` fallback body/response schemas — synthesized at bind time
for a route with no explicit DTO, from `metadata.fields` narrowed to the
resolved `creatable`/`updatable` (bodies) or `selectable` (responses)
allowlist — also emit a `required` array off column nullability: a
non-`nullable` column is listed in `required`, a nullable column (an
opted-in ORM-derived field included) stays optional. A `generated` column is already
excluded from a body (it isn't writable), so it never reaches the body's
`required`; on the response side a non-`nullable` `generated` column (a
primary key, a `@CreateDateColumn`) _is_ in `required`, because the row
always carries it. `patchOne` is the deliberate exception: a partial
update never requires a field, so its `<Entity>Patch` carries no
`required` regardless of nullability. An empty `required` is omitted
rather than emitted as `[]`.

A `creatable`/`updatable` name that is a **relation** rather than a scalar
column has no `metadata.fields` entry, so it is picked up from
`metadata.relations` and documented as the association-by-id shape the
deserializer accepts (ADR-0014): a `{ id }` reference object for a to-one,
a nullable array of them for a to-many. `id` is typed from the target
entity's own metadata, which the binder resolves through
`infrastructure.metadataFor(relation.target())`; it stays untyped only when
that target can't be resolved (no infrastructure, or a root that can't
derive its metadata) or when the target has a composite key, where a single
scalar `id` would be wrong rather than merely vague. A relation never joins
the body's `required` (`RelationDescriptor` carries no nullability). Without
this, an entity whose entire writable projection is relations — a pure join
row associated by id — would synthesize an empty
`properties: {}` a client generator reads as "this route takes no body"
(issue #339). The description fallback ("No field is writable.") is
therefore gated on the synthesized schema ending up with zero properties,
not on the allowlist being empty.

The **response** fallback has the mirror case for `allowed.includable`
(ADR-0028, issue #349, then #356): a relation a client may `?include=` is
emitted as an **optional** property on `<Entity>Item`/`<Entity>ListItem` —
appended after the scalar columns, never in
`required`, since it is only in the body when `include=` asks for it, and
the shape is shared with the write responses, which resolve no `include=`
at all (ADR-0020). The property defers wholly to the relation target's own
config (ADR-0026 decision 4; the ADR-0044 parent-side ceiling was removed
in ADR-0045):

- `applyResponseSchemaDocs` emits an unstamped `x-kavo-includable-ref`
  marker carrying only the target entity's resolved name (bind time cannot
  name the final component — `registerKavoSchemas` owns naming and a
  cross-entity clash can bump `<Target>Item` to `<Target>Item_2`).
  `registerKavoSchemas` then rewrites each marker, in a post-pass over
  every registered component, to `{ $ref: "#/components/schemas/<Target>Item" }`
  — or, when the target published no synthesized item schema (its own read
  route registered an explicit `item` DTO, or it has no read route), to a
  plain `{ type: "object" }` with a prose description, so the document never
  carries a dangling `$ref`. Nested `include=a.b.c` types transitively this
  way, and `$ref` cycles (mutual or self relations) are valid OpenAPI 3.x
  and left as-is. A document that never runs `registerKavoSchemas` keeps
  the marker inline — still a valid object schema, just not `$ref`-composed.

A `-to-many` relation wraps that shape in `{ type: "array", items }`.
The request-side nesting bound is the existing `limits.includeDepth`;
there is no separate Swagger depth control. Driven off the resolved
`allowed.includable` names, not `RelationDescriptor.includable` (which
reflects ORM-derived metadata, not the config grant).

Two known over-statements, both narrowing documentation only — the schema
stays open (no `additionalProperties: false`, matching `allowed.md`'s
"narrows silently"), so neither lies about what the route accepts or
returns. `FieldMetadata` exposes no `hasDefault`, so a non-nullable column
with a database `default:` is reported `required` in `<Entity>Create`
even though the caller may omit it. And the response `required` describes
the unprojected row; a `select=`-narrowed read (ADR-0026) returns a
subset, so a strict client validating that response against `<Entity>Item`
would see "missing required" — expected, the same way `select=` already
diverges from the full schema's `properties`. The request side mirrors the
explicit-DTO path, where `@nestjs/swagger` + class-validator derive
`required` themselves.

### Serving the document (`setupKavoSwagger`)

Wiring `@nestjs/swagger` into a `@Kavo` app has two ordering rules that
work against each other, and neither surfaces an error when you get it
wrong:

- `SwaggerModule.setup()` registers the `/docs` + `/docs-json` routes on
  the HTTP adapter, and that has to run **before** `app.init()` /
  `app.listen()` — a `setup()` afterwards registers routes the router scan
  has already passed, and every `/docs` request then 404s silently;
- the document itself can't be built until **after** `KavoBinder.onModuleInit`
  — the `search[...]` params, the conditional-request headers, and the
  `<Entity>Query`/`Filter`/`Sort`/`Pagination`/`ValidationError` component
  schemas are all attached there, and that pass fires _inside_ `app.init()`.

The only sequence that satisfies both is: register the routes now, and
hand `setup()` a **factory** that defers `SwaggerModule.createDocument()`
to the first request for the docs. `setupKavoSwagger(app, { config })`
(`swagger-setup.ts`, exported from the barrel) is that sequence packaged as
one call — it registers the routes, wraps a memoised
`registerKavoSchemas(createDocument(...))` factory (built once, on first
`/docs` hit, by which point every `onModuleInit` pass has completed), and
passes it to `setup()`. The reference apps' `main.ts` use it; `path`
defaults to `"docs"`, and `documentOptions` / `swaggerOptions` pass
straight through to `createDocument` / `setup`.

It loads `@nestjs/swagger` through the same `createRequire` probe as
`swagger.ts`, so it stays a no-op dependency when the optional peer is
absent — except that calling it then throws a descriptive
`ConfigurationException` (`KAVO_CONFIG_INVALID`) naming the missing peer
rather than a bare module-resolution error. Called _after_ the app has
initialised (`app.isInitialized === true` — read defensively, since Nest
omits the flag from its `.d.ts`), it throws the same exception naming the
call-order rule, rather than registering dead routes.

### Named component schemas (`registerKavoSchemas`)

Everything above emits schemas **inline** on the route — the only identity
available at decoration or bind time is a `title` string, which a client
generator names anonymously. `registerKavoSchemas` (`register-schemas.ts`,
exported from the barrel, ADR-0010) is an app-invoked post-processor over
the finished document — the same "the app splices this in" shape as
`KAVO_API_GUIDE` — that walks every operation carrying `x-kavo-entity` and
lifts the inline schemas Kavo built into `components.schemas`, leaving a
`$ref`:

| Component                     | Source                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `<Entity>Create/Update/Patch` | the `createOne`/`updateOne`/`patchOne` request body                                                           |
| `<Entity>Item`                | a single-row success serving the root `item` slot                                                             |
| `<Entity>List`                | a `"many"` success serving the root `list` slot                                                               |
| `<Entity>ListItem`            | that envelope's `items[]` element                                                                             |
| `<Entity>ListMeta`            | that envelope's `meta` bag                                                                                    |
| `<Entity><Operation>`         | a single-row success with its own `dto.output`                                                                |
| `<Entity><Operation>List`     | the `many` counterpart (`…ListItem` / `…ListMeta` alongside)                                                  |
| `<Entity>Pagination`          | the page controls for the resolved `pagination.strategy` (issue #313, #319)                                   |
| `<Entity>Include`             | the includable relation paths, as `array<enum>` (issue #313)                                                  |
| `<Entity>Sort`                | the sortable keys (bare + `-`-prefixed), as `array<enum>`                                                     |
| `<Entity>Filter`              | the structured filter predicate (issue #314, ADR-0042)                                                        |
| `<Entity>Query`               | the documented-only `filter`+`sort`+`pagination`+`select`+`include`+`search` aggregate (issue #314, ADR-0042) |
| `KavoProblemDetails`          | the shared RFC 9457 body (400/404/409/412)                                                                    |
| `KavoProblemDetailError`      | one entry of its `errors[]` array                                                                             |
| `<Entity>ValidationError`     | the entity-scoped `400`                                                                                       |

Names come from the `x-kavo-*` extensions already on the document (#294)
plus position, plus one new internal marker: `successBodyFor` stamps
`x-kavo-operation-scoped` on a success schema when `descriptor.output` is
set (a per-operation override, issue #131, or a custom operation's own
`dto.output`), and `registerKavoSchemas` names those `<Entity><Operation>`
so a genuinely different shape does not race the root `<Entity>Item` /
`<Entity>List` name and lose to a positional `_2`. That marker is stripped
as the schema is hoisted (along with `title` — the component key supersedes
it); the `x-kavo-entity` / `x-kavo-error` links back to Kavo are kept. The
filter for hoisting is "the inline schema carries `x-kavo-entity` or
`x-kavo-error`"; a schema already a `$ref` (the `{ type: DtoClass }`
introspection path, where `@nestjs/swagger` names its own component) is left
untouched, so that path is a no-op here rather than a special case, and the
un-processed document stays byte-identical for an app that never calls the
helper.

`<Entity>ValidationError` retags the always-present `400`.
`applySwaggerMetadata` applies a bare `400` (the inline `PROBLEM_DETAILS_SCHEMA`)
on every route; `KavoBinder.onModuleInit` then re-applies it via
`applyValidationErrorDoc` as an `allOf` over that same shape, tagged
`x-kavo-entity`, so each entity gets its own named `400` component instead
of every route collapsing onto the shared `KavoProblemDetails`. It does
**not** enumerate the fields a validation error may reference: an `enum` on
`errors[].field` would be a lie (a validation error can name a nested path
`owner.name` or a non-column key, the same reason `applyBodySchemaDocs`
refuses `additionalProperties: false`), and a `description` listing the
resolved write/query allowlist would both disagree with the request-body
schema on the same route — projected through the resolved `create`/`update`
DTO, which _replaces_ the allowlist (`DefaultDeserializer`, ADR-0026's
precedent) — and disclose internal column names the DTO boundary exists to
hide. An app with no `KavoModule.forRoot`/`forRootAsync` never reaches that
pass, so its `400`s stay bare and hoist to `KavoProblemDetails`.

`<Entity>Pagination` / `<Entity>Include` / `<Entity>Sort` (issue #313) are
the query shapes fully derivable from an entity's _resolved_ config — the
page controls for the resolved `pagination.strategy` (`{ limit, offset }`
for `offset`, `{ page[number], page[size] }` for `page`, `{ limit, cursor }`
for `cursor`, `{ limit, since }` for `since`, issue #319), the top-level
`allowed.includable`
relation names (ADR-0028 — `IncludePath<_, 1>`, so a nested path is dotted
into one and is not enumerated), and the `allowed.sortable` keys. Like
`<Entity>ValidationError` they ride `KavoBinder.onModuleInit`, not
decoration time: the resolved allowlists and the precedence-merged
`pagination.strategy` (ADR-0030) only exist then. `applyQuerySchemaDocs`
(`swagger.ts`) builds the three shapes and stamps them, keyed by slot, as
an `x-kavo-query-schemas` extension on every enabled read route
(`pagination`/`sort` on list routes only, `include` on every read);
`registerKavoSchemas` reads that blob, names each entry
`<Entity><Slot-in-PascalCase>` off the operation's own `x-kavo-entity`,
hoists it through the same registry as the DTO schemas — structurally
identical repeats across an entity's read routes collapse onto one
component — and deletes the extension, leaving no plumbing in the published
document. A document that never runs `registerKavoSchemas` keeps the raw
blob on the route instead. `include`/`sort` are entity-scoped so they never
split; `pagination.strategy` is per-operation (`settingsFor(id)`), so an
entity with a custom list op configured `strategy: "none"` alongside a
paginating `findMany` gets `<Entity>Pagination` _and_
`<Entity>Pagination_2`, the same positional `_N` any genuine clash below
produces. None of the three is `$ref`d from anywhere — they exist only to
give a generator a name for the query shapes, so a bundler that prunes
unreferenced `components.schemas` will drop them, as intended. The wire value of `include`/`sort` is a comma-separated
_string_, so each is modelled as `array<enum>` (a bare `{ type: "string",
enum }` would reject `include=a,b`); `sort` carries every token bare and
`-`-prefixed so the sign stays inside the machine-checkable enum.
`<Entity>Include` is **omitted** when nothing is includable, matching the
flat `include` param's own "omit it" path; `<Entity>Pagination` is still
emitted under `pagination.strategy: "none"` as `{ limit, offset }`, carrying
the same `UNPAGINATED_DESCRIPTION` `applyPaginationDocs` puts on
`limit`/`offset` — annotate, don't drop. These are purely additive: the flat bracket params
and `KAVO_API_GUIDE` grammar are untouched.

`<Entity>Filter` and `<Entity>Query` (issue #314, ADR-0042) ride the same
`x-kavo-query-schemas` extension, list routes only — REST's own `filter=`
param is itself list-only (`listQueryParams`'s `isList` guard), so a shape
documenting that grammar has no single-row route to ride either.
`<Entity>Filter` carries one property per field on the resolved
`filterable` allowlist that is also one of the entity's own scalar
columns, each valued by an operator-map object
(`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`/`notIn`/`between`/`isNull`/
`isNotNull` for every kind, plus `like`/`ilike` for a string-kind field
only — doc 05 §1's one kind-specific rule); a filterable relation path
(`profile.city`) is valid on the wire but not enumerable here, the same
known gap `<Entity>Include`'s nested-path handling already accepts, so
the schema carries no `additionalProperties: false`. `and`/`or` are
arrays of `Filter`, `not` is one `Filter` — the wire parser's unary shape
(doc 05 §1), not the AST's variadic one — both `$ref`ing back to this
entity's own expected `<Entity>Filter` name, an assumption that holds
absent a genuine cross-entity name collision (the same `_2` edge case
`<Entity>Pagination` already lives with). `<Entity>Query` is the
aggregate `filter`+`sort`+`pagination`+`select`+`include`+`search` shape
a GraphQL/MCP resolver or a programmatic `QueryContext` caller reasons
about — **documented-only**: no REST parameter `$ref`s it, and REST's
flat query params are entirely unchanged (ADR-0042 explicitly rules out
a `style: deepObject` migration). `sort`/`pagination`/`include`/`filter`
on `<Entity>Query` `$ref` the entity's own other expected component
names; `select`/`search` are inlined rather than hoisted as their own
components, since only `Filter`/`Query` were asked for. `search` is
omitted from `<Entity>Query` when `search` doesn't resolve to an
object, the same gate `applySearchQueryDocs` uses for the flat
`search[...]` params.

Dedup is by name **and** shape: a schema requested under a name already
holding a byte-identical shape (five routes serving `<Entity>Item`) reuses
that component; a genuinely different shape wanting a taken name gets `_2`,
`_3`, … in `document.paths` order. That order is deterministic within one
build but shifts when an entity is added or `controllers: [...]` is
reordered, so a `_2` in the output is a prompt to disambiguate with an
explicit DTO class, not a name to rely on — and after the operation-aware
naming above a real clash needs two entities whose names collide
(`AdListItem` the entity vs `Ad`'s list element). The same shape requested
under _different_ names is emitted under each — `<Entity>Update` /
`<Entity>Patch` are identical when no `dto.patch` is configured — so every
slot keeps its own stable name.

Each hoisted schema is cloned first: `applySwaggerMetadata` hands out the
module-level `PROBLEM_DETAILS_SCHEMA` by reference on every error response,
so mutating in place would let one `createDocument` call's hoist bleed into
the next one's.

## 5. Testing

`tests/binding.e2e.spec.ts` runs a real Nest app over an in-memory fake
infrastructure (no ORM in this package): all six routes, envelope shape,
grammar wiring, problem-details mapping, disabled operations,
manual-method-wins, custom + service-only operations, the service token,
the soft-delete routes, relation includes, and the Swagger body/hint
schemas; `register-schemas.spec.ts` covers the `registerKavoSchemas`
transform in isolation (collision suffixing, idempotency, the `$ref`
skip). The full-stack paths are the reference apps'
suites: Nest → engine → TypeORM → SQLite/Postgres in
`examples/nest-typeorm`, Nest → engine → Mongoose → MongoDB in
`examples/nest-mongoose`, and Nest → engine → MikroORM → SQLite/Postgres in
`examples/nest-mikroorm`. The Mongoose one is what proves route generation
composes with a document store — string `_id`s, `populate`-loaded
includes, and config-declared soft-delete routes. The MikroORM one serves
the _same_ Pet domain as the TypeORM app, deliberately: running one domain
under two SQL adapters is what shows the seam carrying its weight rather
than the routes having been shaped around one ORM.
