# Configuration

[Nest + TypeORM](/integrations/nest/typeorm), [Nest + Prisma](/integrations/nest/prisma), [Nest + Mongoose](/integrations/nest/mongoose), and [Nest + MikroORM](/integrations/nest/mikroorm) cover the zero-config path. This page is the field-by-field reference for everything you can configure once zero-config isn't enough: every `@Kavo(Entity, config)` parameter, and every global setting your `KavoModule` can set.

## How config layers

Settings resolve through one precedence chain, each scope overriding the one before it:

```
built-in defaults → global (KavoModule) → entity (@Kavo config) → operation (operations.<id>) → per-call
```

A field you don't set at a given scope just falls through to the next one down. The full merge semantics (deep-merge rules, what "unset" means per field) are in [Configuration](/internals/architecture/08-configuration) — this page only documents what each field means and where you can set it.

## Global config (`KavoModule.forRoot` / `forRootAsync`)

```ts
KavoModule.forRootAsync({
  useFactory: () => ({
    infrastructure: createInfrastructure(dataSource),
    defaults: {/* KavoSettings, see below */},
    paginationStrategies: [],
  }),
  provideServices: true,
  graphql: true,
});
```

| Field                  | Type                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure`       | `KavoInfrastructure`                    | Where entity metadata and the repository adapter come from — `createInfrastructure(dataSource)` or `createInfrastructure(client, opts)`. Required for any `@Kavo` route to actually run.                                                                                                                                                                                                                                                                                                     |
| `defaults`             | `DeepPartial<KavoSettings>`             | App-wide settings, one level below the built-in defaults and above every entity's own config. See **Settings fields** below for what's in `KavoSettings`.                                                                                                                                                                                                                                                                                                                                    |
| `paginationStrategies` | `readonly PaginationStrategy[]`         | Registers custom pagination strategies beyond the built-in `"offset"`, so `pagination.strategy` can name one of these instead.                                                                                                                                                                                                                                                                                                                                                               |
| `realtimeTransports`   | `readonly RealtimeTransport[]`          | Registers the transports (e.g. `createSseTransport(...)` from `@kavo/sse`) every entity's write events publish to — process-wide, not per entity (ADR-0023). An entity still needs its own `realtime: { enabled: true, events: {...} }` (see `realtime` below) before any of its writes publish anything; registering a transport alone does not turn realtime on for anything.                                                                                                              |
| `principal`            | `boolean \| ((request) => unknown)`     | Where a generated route finds the authenticated caller to put on `KavoContext.principal`. `true` reads `request.user`; a function reads whatever it likes. Unset (or `false`) leaves `principal` `null`. See [The principal](#the-principal) below.                                                                                                                                                                                                                                          |
| `useFactory`           | `(...args) => KavoModuleOptions`        | (`forRootAsync` only) Builds the options object, e.g. after awaiting `dataSource.initialize()`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `inject`               | `readonly (string \| symbol \| Type)[]` | (`forRootAsync` only) DI tokens injected as `useFactory`'s arguments.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `provideServices`      | `boolean`                               | Also provides `getKavoServiceToken(Entity)` as a real DI provider for every `@Kavo`-decorated class the process has seen — needed only if some other class constructor-injects a `@Kavo` entity's service directly.                                                                                                                                                                                                                                                                          |
| `graphql`              | `boolean \| { path?: string }`          | Mounts a default GraphQL controller merging every entity that called `registerKavoGraphQLTypes` onto one schema. `true` mounts at `POST /graphql`; `{ path }` mounts elsewhere. Implies `provideServices`.                                                                                                                                                                                                                                                                                   |
| `mcp`                  | `boolean \| { path?: string }`          | Mounts a default MCP controller (Streamable HTTP, stateless) exposing every `@Kavo` entity's full standard toolset — no per-entity opt-in. `true` mounts at `POST /mcp`; `{ path }` mounts elsewhere. Implies `provideServices`. Requires `@modelcontextprotocol/sdk` installed. Carries no auth guard of its own — a guard on an entity's REST controller does not extend to this route; write your own controller extending `BaseKavoMcpController` instead if the MCP surface needs auth. |

### The principal

`KavoContext.principal` is the authenticated caller. Kavo carries it and nothing more: core never reads or judges the value. Your own code does — a [computed field](#computed) that varies by viewer, or a replacement `OperationHandler`.

Two separate jobs get it there, and only the second is Kavo's. Authenticating the caller is yours: a guard, a middleware, `@nestjs/passport`, whatever already runs ahead of the route handler and leaves the caller on the request. Kavo adds no auth dependency and mounts no guard of its own. What `principal` configures is the other half, moving that caller from the request onto the context:

```ts
KavoModule.forRootAsync({
  useFactory: () => ({
    infrastructure: createInfrastructure(dataSource),
    // `request.user` — where Passport and most hand-rolled guards leave it.
    principal: true,
  }),
});

// Or name the property yourself:
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  principal: (request) => (request["session"] as Session | undefined)?.account ?? null,
});
```

The extractor runs once per request, inside the generated route handler, and what it returns is that request's `principal`. Nothing is memoized between requests, so one caller's identity can never be served to the next. Keep it synchronous and cheap: read a property some guard already set, rather than verifying a token or querying a table. Throwing from it fails the request with a 500 problem-details document instead of quietly producing `null`.

- Leave `principal` unset and it stays `null`. Nothing is populated by assumption: an ownership predicate that quietly starts answering differently is worse than one you can see is unwired.
- It reaches standard and custom operations alike — one generated handler builds the request for every route, so a replacement handler on `POST /books/:id/claim` sees the same `context.principal` a plain `GET /books/1` does.
- It reaches the generated **REST** routes and nothing else. The GraphQL and MCP surfaces (`graphql`/`mcp` above, and controllers extending `BaseKavoGraphQLController`/`BaseKavoMcpController`) call the service directly, so `context.principal` is `null` there whatever this option says — a computed field that varies by viewer answers for an anonymous caller over `POST /graphql`.
- Programmatic callers pass their own: `crud.findOne(id, query, { principal })`. The module option is HTTP wiring, not a global; a background job has no request to extract from.
- A method Kavo does not generate passes its own too. An `@Override`'d method or a fully custom route reaches the engine itself, so nothing fills `options` for it. `boundKavoPrincipal(this, request)` runs the extractor the module configured, so the method does not restate where the caller lives:

  ```ts
  @Override()
  async findOne(
    id: EntityId,
    query: WireQuery,
    preconditions: RequestPreconditions | null,
    request: KavoPrincipalRequest,
  ) {
    const principal = boundKavoPrincipal(this, request);
    return boundKavoService<Book>(this).findOne(id, query, {
      principal,
      preconditions: preconditions ?? undefined,
    });
  }
  ```

  The request is the trailing parameter of the [fixed layout](/internals/architecture/10-nestjs-integration) Kavo wires for you; declare it only if you want it.

Authorization stays out of scope in both directions: Kavo will not scope rows to the principal, and will not refuse an operation on its behalf. A guard decides who may call the route; a replacement handler decides what they get back.

## Settings fields (`KavoSettings`)

This is the shape of `defaults` above, and also of every entity-scope, operation-scope, and per-call override — the same schema at every scope, just merged in order.

### `pagination`

| Field          | Type                                                                   | Default       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultLimit` | `number`                                                               | `20`          | Page size when a request supplies no `limit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `maxLimit`     | `number`                                                               | `100`         | Hard ceiling on `limit` — a request asking for more is clamped, not rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `strategy`     | `"offset"` \| `"page"` \| `"cursor"` \| `"since"` \| a registered name | `"offset"`    | Which pagination strategy computes the page. `offset` is flat `limit`/`offset`; `page` is `page[number]`/`page[size]`; `cursor` is keyset paging over an opaque `?cursor=` token, which requires the effective sort to end in the entity's id field — with every sort key on `allowlists.filterable` and `allowlists.selectable` as well as `sortable` — and reports the next token as `meta.nextCursor`; `since` is polling by a plain, compound `?since=<value>\|<id>` token against `since.field`, with the sort forced to `[since.field, id]`, exactly-once delivery (the id half breaks ties on `since.field`), and the next token reported as `meta.nextSince`. Pair either keyset strategy with `count: false`, and index the sort tuple; both are refused by the GraphQL and MCP bindings, which cannot page a keyset (see [Cursor pagination](/using-the-api#cursor-keyset-pagination), [Since pagination](/using-the-api#since-seek-by-timestamp-pagination), [ADR-0021](/internals/adr/0021-cursor-pagination-is-an-opaque-keyset-union), and [ADR-0022](/internals/adr/0022-since-pagination-composes-a-value-id-keyset)). See `paginationStrategies` above for adding your own. |
| `since.field`  | `string`                                                               | `"updatedAt"` | Only consulted under `strategy: "since"`: the column `?since=` seeks against. Must be a `date`- or `string`-kind column on `allowlists.filterable` and `allowlists.selectable`, checked at startup — a missing or wrong-kind column fails immediately rather than on the first request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `count`        | `boolean`                                                              | `true`        | Whether list responses compute `total` (an extra `COUNT` query per list call). Set it to `false` alongside `strategy: "cursor"`/`"since"`: the `COUNT` is `O(n)` over the whole match set and dominates the `O(limit)` keyset page it accompanies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### `query`

| Field            | Type              | Default | What it does                                                                                                                                                                                                        |
| ---------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxFilterDepth` | `number`          | `3`     | Max nesting depth of the `filter` AST (`and`/`or` groups nested inside each other).                                                                                                                                 |
| `maxInValues`    | `number`          | `100`   | Max array length for `in`, `notIn`, and `between` filter operators.                                                                                                                                                 |
| `defaultSort`    | `readonly Sort[]` | `[]`    | Sort order applied when a request supplies no `sort` of its own. A client-supplied `sort` always wins outright — it never merges with this. Validated against the sortable allowlist, same as client-supplied sort. |

### `errors`

| Field             | Type      | Default | What it does                                                                                                                             |
| ----------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `exposeInternals` | `boolean` | `false` | Whether driver-level error details (raw SQL error messages, stack info) leak into problem-details responses. Keep `false` in production. |

### `relations`

| Field              | Type                                             | Default | What it does                                                                                                                                                        |
| ------------------ | ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxIncludeDepth`  | `number`                                         | `2`     | Max nesting depth for `include=` chains (`include=owner.tags` is depth 2).                                                                                          |
| `maxIncludedNodes` | `number`                                         | `10`    | Max total number of included relation nodes per request, across every branch of the include tree.                                                                   |
| `edges`            | `Readonly<Record<string, RelationEdgeSettings>>` | `{}`    | Per-relation permissions, keyed by relation property name — see **`relations.edges`** below. Inclusion is opt-in: a relation absent here cannot be included at all. |

**`relations.edges.<name>`** (`RelationEdgeSettings`):

| Field            | Type                              | Default                                | What it does                                                                                                                                                              |
| ---------------- | --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `includable`     | `boolean`                         | `false`                                | Whether clients may `include=` this relation at all.                                                                                                                      |
| `defaultInclude` | `boolean`                         | `false`                                | Include this relation even when the client doesn't ask for it.                                                                                                            |
| `maxDepth`       | `number`                          | (inherits `relations.maxIncludeDepth`) | Overrides the include-depth limit for the subtree below this relation only.                                                                                               |
| `strategy`       | `"join"` \| `"batch"` \| `"auto"` | `"auto"`                               | How the relation loads: `join` (single query, correct for to-one), `batch` (per-level `WHERE parentId IN (...)`, correct for to-many), or `auto` (picks per cardinality). |

### `caching`

| Field  | Type      | Default | What it does                                                                                                                                     |
| ------ | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `etag` | `boolean` | `true`  | Whether single-item responses carry an `ETag`, and whether `If-None-Match` (→ `304`) and `If-Match` (→ `412`) are honored. One key, both halves. |

`false` at any scope turns both halves off together — no tag is computed and `If-None-Match` is ignored. `If-Match` is the exception: it is **refused** with `412 KAVO_PRECONDITION_UNSUPPORTED`, not ignored. Answering `2xx` would tell a client its write was guarded when nothing checked it, and the per-operation scope makes that easy to arrive at by accident (`operations: { findOne: { caching: { etag: true } }, updateOne: { caching: { etag: false } } }` would serve tags on `GET` and drop the header on `PUT`).

See [ETags and conditional requests](/using-the-api#etags-and-conditional-requests) for the wire behavior, including the explicit limits: the `If-Match` check is check-then-write rather than an atomic compare-and-swap, and a token has to come from an unnarrowed read.

**Redaction belongs in the DTO, not in an interceptor.** Kavo's `KavoResponseInterceptor` is method-scoped and therefore innermost: it sets the `ETag` before any controller- or app-level interceptor runs. An outer interceptor that strips fields per role would ship a hash of the _unredacted_ representation next to a redacted body — and a client's `If-Match` built from it would never match. Shape the response with a per-operation `item` DTO, which the engine serializes through before hashing.

**An `@Override`'d method enforces `If-Match` only if it forwards it.** The check lives in the engine, so a method you wrote in place of a generated one bypasses it. `@Kavo` still hands the tokens to the method as its last parameter; pass them on with `{ preconditions }` on the typed service, or return `service.engine.execute({ …, preconditions })` to also get the `ETag` header back.

### `softDelete`

| Field      | Type                             | Default       | What it does                                                                                                                                                                                                                               |
| ---------- | -------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `field`    | `string`                         | `"deletedAt"` | Name of the delete-marker column.                                                                                                                                                                                                          |
| `strategy` | `"auto"` \| `"soft"` \| `"hard"` | `"auto"`      | `auto` resolves per entity (soft if the marker field exists, hard otherwise); `soft`/`hard` state it outright. `false` for the whole `softDelete` key (instead of an object) disables soft delete entirely, even if a marker field exists. |

See [Getting started's soft delete section](/getting-started#soft-delete) for the practical walkthrough, and [Soft delete, restore & purge](/internals/architecture/11-soft-delete) for the full behavior.

### `realtime`

| Field                | Type                                         | Default | What it does                                                                                                                                                                                             |
| -------------------- | -------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | `boolean`                                    | `false` | Whether this entity's standard writes publish a `RealtimeEventDto` to every registered transport. `false` for the whole `realtime` key (instead of an object) is the same as `enabled: false`.           |
| `events`             | `Partial<Record<RealtimeEventId, boolean>>`  | `{}`    | Per-event opt-out — `{ patched: false }` suppresses `patched` publishes while `created`/`updated`/`deleted`/`restored` still fire.                                                                       |
| `subscribableFields` | `readonly string[] \| { exclude: string[] }` | unset   | An allowlist a transport (e.g. `@kavo/sse`) can read and enforce on a subscription's outgoing payload — core carries the value but does not itself narrow anything with it (that's the transport's job). |
| `onPublishError`     | `(error, transport, event) => void`          | unset   | Called when a transport's `publish` rejects or throws. A transport failure never fails the write that produced the event; this is the only way to observe it (core has no ambient logger, ADR-0005).     |

Publishing needs both halves: `realtime.enabled` on the entity (set here or via `defaults`) _and_ at least one transport in `realtimeTransports` (global config, above). Either alone is a no-op. See [Realtime](/internals/architecture/18-realtime) for the full event/channel model, and `@kavo/sse`'s own README for the first transport implementation (collection channels, subscribe-time filtering, `subscribableFields` payload narrowing).

### `operations` (global scope only)

At global scope, `operations` is a flat map of booleans, keyed by standard operation id — coarser than the richer per-entity form below:

```ts
defaults: {
  operations: { restoreOne: false },
}
```

| Operation id | Enabled by default                                          |
| ------------ | ----------------------------------------------------------- |
| `createOne`  | Yes                                                         |
| `findOne`    | Yes                                                         |
| `findMany`   | Yes                                                         |
| `updateOne`  | Yes                                                         |
| `patchOne`   | Yes                                                         |
| `deleteOne`  | Yes                                                         |
| `restoreOne` | No, unless soft delete is declared on the entity (ADR-0013) |
| `purgeOne`   | No, until named explicitly                                  |

An entity's own `operations.<id>` (below) always wins over this global map.

## `@Kavo(Entity, config)` — entity-scope config

Every field above (`pagination`, `query`, `errors`, `relations`, `softDelete`) can also be set here, one level above global. In addition, `@Kavo`'s config carries four fields that only make sense per entity:

### `dto`

Registers DTO classes per slot — every slot is independently optional and falls back to an entity-derived default when omitted:

```ts
@Kavo(Book, {
  dto: {
    create: CreateBookDto,
    update: UpdateBookDto,
    item: BookItemDto,
    list: BookListDto,
  },
})
```

| Slot     | Default when omitted                                |
| -------- | --------------------------------------------------- |
| `create` | Entity's own shape, minus generated/relation fields |
| `update` | Same default as `create`                            |
| `patch`  | `Partial<update>` if set, else `Partial<Entity>`    |
| `query`  | Generic `QueryContext<Entity>`                      |
| `item`   | Entity, subject to field selection                  |
| `list`   | Same as `item`'s resolved type                      |

There's no `patch` DTO class to write on its own — it derives from `update`. See [DTO system](/internals/architecture/04-dto-system) for full derivation rules.

### `allowlists`

What a request may filter, sort, and select on — including relation paths. Anything outside an allowlist is rejected with a 400, never silently dropped:

```ts
@Kavo(Book, {
  allowlists: {
    filterable: ["id", "title", "author"],
    sortable: ["id", "title"],
    selectable: ["id", "title", "author"],
  },
})
```

| Field        | Type                                                          | What it does                    |
| ------------ | ------------------------------------------------------------- | ------------------------------- |
| `filterable` | `readonly FieldPath[]` \| `{ exclude: readonly FieldPath[] }` | Fields usable in `filter[...]`. |
| `sortable`   | same shape                                                    | Fields usable in `sort=`.       |
| `selectable` | same shape                                                    | Fields usable in `fields=`.     |

`{ exclude: [...] }` means "every own column (plus, for `selectable`, every selectable computed field) except these", resolved at bootstrap against exactly the base set that key's plain default uses. Omit a key entirely and it derives from the `query` DTO or entity metadata instead.

### `computed`

Response fields with no backing column, derived from an entity that has already been fetched:

```ts
@Kavo(Book, {
  computed: {
    displayTitle: { resolve: (book) => (book.title === null ? null : `${book.title} (${book.year})`) },
    canEdit: { resolve: (book, context) => book.ownerId === (context.principal as User)?.id },
  },
})
```

| Field        | Type                                        | What it does                                                                                         |
| ------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `resolve`    | `(entity, context: KavoContext) => unknown` | Derives the value. Called once per served item, **synchronously** — see the caveats below.           |
| `selectable` | `boolean` (default `true`)                  | Whether `fields=` may name the field. `false` makes naming it a 400 — read the note below carefully. |

A declared computed field is in the default `item`/`list` projection with no DTO registration, and in the `selectable` allowlist by default. It is **never** filterable, sortable, or writable — naming one in `allowlists.filterable`/`sortable` is both a type error and a bootstrap `ConfigurationException`, and so is naming one in a registered `create`/`update`/`patch` DTO. (A raw body key is still just dropped, like any other unknown key; the DTO case is a declaration, and every other computed misdeclaration fails at bootstrap too. It also has a wire consequence a silent drop cannot reach: `@ApiBody` is built from the DTO's runtime shape, so OpenAPI would advertise a property the engine unconditionally discards.)

`resolve` returning `undefined` omits the key; `null` emits it — the same distinction a column draws.

**`resolve` must be total, not merely pure.** It runs once per served item and nothing catches it, so **one** row whose resolver throws turns the whole collection endpoint into a 500 — not for that row, for every caller, until the row is fixed. Write it against everything the column can actually hold, including `null`: `resolve: (todo) => todo.title?.toLowerCase() ?? null`, never `todo.title.toLowerCase()` on a nullable column. A `POST` that sets `title: null` succeeds (computed fields are stripped from the payload; `title` is an ordinary column), and `GET /todos` is dead from then on. A throwing resolver surfaces as a 500 `KAVO_PERSISTENCE_FAILED` with the cause attached and the message not leaked.

A resolver reading `context.principal`, like `canEdit` above, needs the module's [`principal`](#the-principal) option set — over HTTP that option is the only thing that fills the field, and without it the caller is `null` on every request, so `canEdit` is uniformly `false` and its inverse uniformly `true`.

Keep it a pure function of the entity as well (plus `context.principal` where a field has to vary by caller). It runs per row, so a resolver that queries the database or calls out over the network reintroduces exactly the N+1 that batched includes exist to avoid. Declaring it `async` is a bootstrap error rather than a slow success: the serializer never awaits, so the promise would be emitted as-is and serialize to `{}`.

**`resolve` receives the full fetched row**, not the projected object — selection is "kept internally, stripped late", so every column is present regardless of `fields=` or the registered `item` DTO. A computed field can therefore surface a value a narrowed DTO or `selectable` list deliberately hides. That is deliberate (`resolve` is server-authored code, the same trust level as `exposeInternals`), but it makes the resolver part of the exposure decision: narrowing the DTO does not narrow what the resolver can see.

**What `selectable: false` does and does not mean.** It removes the name from the allowlist, so `?fields=auditNote` is a 400. It does **not** pin the field into every response: selection narrows the projection uniformly, so any request that sends `fields=` at all still drops it, and the client has no way to ask for it back. Read it as "not individually selectable", not "always present". An explicit `allowlists.selectable` list naming the field overrides the flag — an explicit list is always the deliberate answer.

On an **included relation target**, `resolve` receives the _root_ request's `KavoContext` — serving `GET /posts/1?include=author` hands an `Author` computed field a context whose `entityName`, `operation`, `config` and `query` describe Post. Only `principal`, `correlationId`, `transaction` and `state` mean what they say from a relation target — `principal` being whatever the module's [`principal`](#the-principal) option extracted for the root request, or `null` when no option is set.

**The generated OpenAPI response schema does not mention a computed field** when no `item`/`list` DTO is registered: the schema falls back to the entity class, whose columns are all the reflection can see, while the runtime response carries the computed key. Registering an `item`/`list` DTO naming the field fixes the document and the static response type in one move — the same escape hatch, for both consequences.

Let the computed-key type parameter be inferred at the call site: pass the config inline to `@Kavo(...)` (or use `satisfies`), and pin neither an `EntityConfig<Book>` annotation on the config nor explicit type arguments on the call (`@Kavo<Todo, CreateTodoDto>(...)`, `createCrud<Book, CreateBookDto>(...)` — the likelier spelling once an entity has custom DTOs). Either fixes `Computed` to `never`, which erases `computed`'s value types and leaves `resolve`'s parameter implicitly `any`.

See [ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated) for the reasoning and [DTO system §7](/internals/architecture/04-dto-system) for how it interacts with DTO narrowing and field selection.

### `operations`

Per-operation overrides, keyed by standard operation id. Each entry is either a boolean shorthand or a full `OperationConfig` object:

```ts
@Kavo(Book, {
  operations: {
    patchOne: false, // shorthand: disable outright
    restoreOne: { enabled: true, meta: { routes: { path: ":id/undelete" } } },
  },
})
```

| Field                | Type                                | What it does                                                                                                                                  |
| -------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | `boolean`                           | Turns the operation on or off explicitly — the long form of the `true`/`false` shorthand, for when the entry also carries settings or `meta`. |
| `handler`            | `OperationHandler<Entity>`          | Replacement handler function, keeping the default DTO/serialization scaffolding around it.                                                    |
| `meta`               | `OperationMetadata`                 | Opaque bag consumed by the framework layer — in `@kavo/nest`, this is `{ routes: KavoRouteOptions }`.                                         |
| `dto`                | `{ input?, output?, query? }`       | Overrides the entity's root `dto` slot for this operation only — see below.                                                                   |
| _(any settings key)_ | same shape as global `KavoSettings` | Overrides that apply to this operation only, one level above the entity's own settings.                                                       |

**`operations.<id>.dto`** narrows one operation's request body, response, or query contract independently of the entity's root `dto` slots (§`dto` above). Only the fields a given operation actually has are accepted — `input`/`output` on a write, `output`/`query` on a read, neither on `deleteOne`/`purgeOne` (void results):

```ts
@Kavo(Book, {
  dto: { item: BookItemDto }, // entity-wide default for every read
  operations: {
    findOne: { dto: { output: BookDetailDto } }, // findOne only
    createOne: { dto: { input: CreateBookRequestDto, output: BookCreatedDto } },
  },
})
```

Fallback order per field: `operations.<id>.dto.<field>` → the entity's root `dto.<slot>` → the entity-derived default. Setting a field an operation doesn't have (`dto.query` on `createOne`, say) is both a type error and a bootstrap `ConfigurationException`. See [DTO system §8](/internals/architecture/04-dto-system#8-per-operation-override-issue-131) for the full applicability table and the fallback chain in the engine.

**`operations.<id>.meta.routes`** (`@kavo/nest`'s `KavoRouteOptions`):

| Field           | Type                                                      | Default                                     | What it does                                                                                                               |
| --------------- | --------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `method`        | `"GET"` \| `"POST"` \| `"PUT"` \| `"PATCH"` \| `"DELETE"` | the operation's standard verb               | Overrides which HTTP verb the generated route uses.                                                                        |
| `path`          | `string`                                                  | the operation's standard path               | Route path relative to the controller (e.g. `":id/activate"`).                                                             |
| `enabled`       | `boolean`                                                 | `true`                                      | `false` makes the operation service-only: still callable through `service.engine.execute(...)`, but no route is generated. |
| `successStatus` | `number`                                                  | `201` create, `204` delete, `200` otherwise | Overrides the response status code on success.                                                                             |

See [NestJS integration](/internals/architecture/10-nestjs-integration) for how route generation reads this, and [Registry-driven operations](/internals/adr/0006-registry-driven-operations) for why routes always come from the same registry the engine uses.

### Custom list metadata

The list envelope's `meta` bag (`ListResultDto.meta`) is the place for anything about the list that isn't a row — facet counts, a freshness stamp, a cursor — and it does not need a DTO or a config key: whatever the `findMany` handler returns as `meta` is what the client receives.

It is the envelope's one optional field. Until a handler fills it the key is **absent** from the response, not `{}`, so the common zero-config list doesn't carry an empty bag on every request; a contributor that returns `{}` leaves it absent too. Type it and read it accordingly — `body.meta?.inStock`.

> `ListResultDto.meta` on the **response** and `operations.<id>.meta` above are unrelated. The first is an open bag on the list envelope; the second is `OperationMetadata` — route options the framework layer reads, which never reach a response body.

`withListMeta` wraps an existing handler so a contributor function's keys land on the bag, which saves rewriting the built-in `findMany` just to add one number:

```ts
// data-source.ts — the same infrastructure app.module.ts hands KavoModule
export const infrastructure = createInfrastructure(dataSource);
```

```ts
// book.controller.ts
import { builtInHandlers, withListMeta } from "@kavo/core";
import { infrastructure } from "./data-source.js";

const findMany = builtInHandlers(infrastructure.adapterFor(Book))("findMany");

@Kavo(Book, {
  operations: {
    findMany: {
      handler: withListMeta(findMany, (result) => ({
        inStock: result.entities.filter((book) => book.stock > 0).length,
        countedAt: new Date().toISOString(),
      })),
    },
  },
})
@Controller("books")
export class BookController {}
```

```json
{ "items": [...], "limit": 20, "offset": 0, "total": 2, "meta": { "inStock": 1, "countedAt": "2026-01-01T00:00:00.000Z" } }
```

The adapter has to exist when the class is **declared**, because `@Kavo`'s config object is evaluated at decoration time ([ADR-0012](/internals/adr/0012-decoration-time-route-generation)) — the module-scope `DataSource` the [wiring guide](/integrations/nest/typeorm#zero-config-wiring) already builds is exactly that. If yours is created by a DI factory (`KavoModule.forRootAsync`) instead, it isn't available yet: contribute from a handler that doesn't need the adapter, or configure the entity through `createCrud` where the infrastructure is already resolved.

| Point                | Behavior                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contributor input    | The wrapped handler's whole result (`entities`, `total`, and any `meta` it already set) plus the request `KavoContext`. It may be `async`.                                             |
| Merge precedence     | The contributor's keys win. The inner handler's `meta` is the base and the contributor merges over it, so the outermost wrap owns any key it names; keys it doesn't name pass through. |
| Overriding that      | The inner bag is in hand — return `{ ...mine, ...result.meta }` to let the inner handler win instead.                                                                                  |
| Serialization        | None. `meta` is your data, not entity data: no DTO projection, no `fields=` selection, no renaming. It must be JSON-serializable.                                                      |
| Nothing contributed  | The key is left off the response entirely. Judged on the merged bag, so `{}` from a contributor is the same as no contributor at all.                                                  |
| Wrong-shaped handler | Wrapping a handler that doesn't return `{ entities, total }` raises `ConfigurationException` (`KAVO_CONFIG_INVALID`) naming the operation, rather than serving a malformed envelope.   |

The wrapper is a convenience, not a requirement — the engine reads `meta` off whatever the `findMany` handler returns, so a hand-written one works the same way:

```ts
import type { FindManyResult, KavoContext } from "@kavo/core";

const handler = {
  async execute(_input: null, context: KavoContext<Book>) {
    // `builtInHandlers(...)` hands back `OperationHandler<Book>`, whose
    // output type is `unknown` — the same erasure `withListMeta` works
    // around with its runtime shape check. Hand-rolling the wrap means
    // narrowing it yourself.
    const inner = (await findMany.execute(null, context)) as FindManyResult<Book>;
    return { ...inner, meta: { inStock: 1 } };
  },
};
```

**Transport support.** `meta` rides the same envelope everywhere, so it reaches REST responses and [MCP](/internals/architecture/16-mcp-binding) tool results unchanged. It is **not** exposed by the [GraphQL binding](/internals/architecture/13-graphql-binding) — that binding's generated list type declares `items`/`total`/`limit`/`offset` only, so a GraphQL client cannot select `meta` today.
