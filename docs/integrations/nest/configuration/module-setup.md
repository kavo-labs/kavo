# Module setup

How your app hands Kavo its infrastructure and app-wide options: `KavoModule.forRoot`/`forRootAsync`, and moving the authenticated caller onto `KavoContext.principal`.

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
| `realtimeTransports`   | `readonly RealtimeTransport[]`          | Registers the transports (e.g. `createTransport(...)` from `@kavo/sse`) every entity's write events publish to — process-wide, not per entity (ADR-0023). An entity still needs its own `realtime: { enabled: true, events: {...} }` (see `realtime` below) before any of its writes publish anything; registering a transport alone does not turn realtime on for anything.                                                                                                                 |
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
