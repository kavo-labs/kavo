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
  The resolved `principal` extractor rides the same pass onto
  `this[KAVO_PRINCIPAL_PROPERTY]`, for the same reason and with the same
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
per-request concern (principal, transaction, query, correlation id,
state) through `KavoContext`, so request-scoped providers would buy
nothing and cost per-request instantiation of the whole graph.

### 1a. The principal (a per-request value under a decoration-time route)

`KavoContext.principal` reaches core one way only —
`KavoRequest.options.principal`, which the engine copies onto the context
(`KavoCallOptions` is per-call scope, so this is a parameter, never a
config write). A programmatic caller fills it directly. A generated route
has to fill it from the incoming request, and that is the awkward part:
routes are generated at decoration time (ADR-0012), while both the value
and the rule for finding it are things decoration time cannot see.

The two halves split along that seam:

- **The rule** is a `KavoModule` option, `principal`: `true` for
  `request.user`, or a `(request) => unknown` extractor. It is resolved
  once, in `KavoBinder`, and bound onto the controller **instance** beside
  the service. Instance-scoped rather than on the prototype for the reason
  the service already is — the class is process-wide, so a second app in
  the same process would otherwise inherit the first one's options, which
  is every `@kavo/nest` test file.
- **The value** is resolved per request, inside `makeHandler`'s generated
  function, from the raw request that `applyParamDecorators` now wires as
  the layout's trailing `@Req()` parameter. Nothing is memoized between
  requests; nothing is read at decoration time.

Absent the option, the extractor is `undefined` and the handler sends
`options: null`, byte for byte the request an unconfigured route has
always sent, so `principal` stays `null` for an app that never opts in.
Kavo does not authenticate and does not judge: whatever the extractor
returns is carried opaquely (doc 01 §8), and a throwing extractor fails
the request rather than degrading to `null`.

Methods Kavo does not generate reach the engine themselves, so nothing
fills `options` for them; `boundKavoPrincipal(controller, request)` runs
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
simpler path that needs no `@Kavo` involvement at all — the only way to
add an action with no operation identity of its own, since `EntityConfig`
has no surface for registering a new operation id. The decoration-time
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
machinery. `examples/nest-typeorm/src/address/address.controller.ts`'s
`normalizePostalCode` and `validatePostalCode` both take the plain
native-decorated path.

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
  ever sees the envelope. It acts only on an engine envelope, so an
  override returning its own value is untouched; an override returning
  `service.engine.execute(...)` gets the identical treatment rather
  than silently losing the header.

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
(`User_findMany`), the `:id` param, the query params documented on list
routes (doc 5), registered DTO classes as body schemas (`ApiBody`),
problem-details response schemas for 400/404, and the conditional-request
surface (ADR-0020) — the `ETag` response header, `If-None-Match` + `304`
on single-item reads, `If-Match` + `412` on single-row writes, gated on
as much of `caching.etag` as decoration time can see (entity and
operation scope; the global scope arrives later, with
`KavoModule.forRoot`). Allowlist-derived
per-field query documentation needs ORM metadata, which doesn't exist at
decoration time — revisited in a future DX pass.

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

## 5. Testing

`tests/binding.e2e.spec.ts` runs a real Nest app over an in-memory fake
infrastructure (no ORM in this package): all six routes, envelope shape,
grammar wiring, problem-details mapping, disabled operations,
manual-method-wins, custom + service-only operations, the service token,
the soft-delete routes, relation includes, and the
Swagger body/hint schemas. The full-stack paths are the reference apps'
suites: Nest → engine → TypeORM → SQLite/Postgres in
`examples/nest-typeorm`, Nest → engine → Mongoose → MongoDB in
`examples/nest-mongoose`, and Nest → engine → MikroORM → SQLite/Postgres in
`examples/nest-mikroorm`. The Mongoose one is what proves route generation
composes with a document store — string `_id`s, `populate`-loaded
includes, and config-declared soft-delete routes. The MikroORM one serves
the _same_ Pet domain as the TypeORM app, deliberately: running one domain
under two SQL adapters is what shows the seam carrying its weight rather
than the routes having been shaped around one ORM.
