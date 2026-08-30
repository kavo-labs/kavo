# Wiring your own auth

`KavoContext.app` is the application's request-scoped context — the authenticated caller, the tenant, a request id, whatever your app needs to carry. Kavo carries it and nothing more: core never reads, judges or shapes the value. Your own code does, whether that's a [computed field](/features/computed-fields#computed) that varies by viewer, a [policy](/features/policy), or a replacement `OperationHandler`.

## Type it

`KavoAppContext` ships empty. Declare its shape once, and every `context.app` read is typed with no cast:

```ts
declare module "@kavo/core" {
  interface KavoAppContext {
    userId: string;
    roles: string[];
    tenantId: string;
  }
}
```

One shape per process — `@Kavo` is a decorator and can't infer a per-entity type, so the augmented interface is what types `context.app` everywhere. Until you declare a field, reading it is a compile error: an unwired ownership check should not silently type-check.

## Populate it

Getting `app` in place is two separate jobs, and only the second is Kavo's. Authenticating the caller is yours: a guard, a middleware, `@nestjs/passport`, whatever already runs ahead of the route handler and leaves the caller on the request. Kavo adds no auth dependency and mounts no guard of its own. The `app` option is the other half: building the context object from that request.

```ts
KavoModule.forRootAsync({
  useFactory: () => ({
    infrastructure: createInfrastructure(dataSource),
    // `request.user`: where Passport and most hand-rolled guards leave it.
    app: (request) => (request.user ?? {}) as KavoAppContext,
  }),
});

// Read from wherever your guard actually leaves things:
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  app: (request) => {
    const session = request["session"] as Session | undefined;
    return { userId: session?.account } as KavoAppContext;
  },
});
```

The extractor runs once per request, inside the generated route handler, and what it returns is that request's `context.app`. Nothing is memoized between requests, so one caller's context can never be served to the next. Keep it synchronous and cheap: read a property some guard already set, rather than verifying a token or querying a table. Throwing from it fails the request with a 500 problem-details document instead of quietly producing an empty context.

- Leave `app` unset and `context.app` stays `{}`. Nothing is populated by assumption: an ownership predicate that quietly starts answering differently is worse than one you can see is unwired.
- It reaches standard and custom operations alike. One generated handler builds the request for every route, so a replacement handler on `POST /books/:id/claim` sees the same `context.app` a plain `GET /books/1` does.
- It reaches the generated **REST** routes and nothing else. The GraphQL and MCP surfaces (`graphql`/`mcp` above, and controllers extending `BaseKavoGraphQLController`/`BaseKavoMcpController`) call the service directly, so `context.app` is `{}` there no matter what this option says. A computed field that varies by viewer answers for an empty context over `POST /graphql`.
- Programmatic callers pass their own: `crud.findOne(id, query, { app })`. The module option is HTTP wiring, not a global; a background job has no request to extract from.
- When the [result cache](/features/result-cache) is on, `KavoAppContext` must be JSON-canonicalizable — no reference cycles. The cache key includes `context.app`, so a request object or a logger stuffed into it would recurse forever. Put only plain data there, or keep the cache off.
- A method Kavo does not generate passes its own too. An `@Override`'d method or a fully custom route reaches the engine itself, so nothing fills `options` for it. `boundKavoAppContext(this, request)` runs the extractor the module configured, so the method does not restate where the caller lives:

  ```ts
  @Override()
  async findOne(
    id: EntityId,
    query: WireQuery,
    preconditions: RequestPreconditions | null,
    request: KavoAppContextRequest,
  ) {
    const app = boundKavoAppContext(this, request);
    return boundKavoService<Book>(this).findOne(id, query, {
      app,
      preconditions: preconditions ?? undefined,
    });
  }
  ```

  The request is the trailing parameter of the [fixed layout](/internals/architecture/10-nestjs-integration) Kavo wires for you; declare it only if you want it.

Row-scoping is still out of scope: Kavo will not filter `findMany`'s match set to the caller on its own. Refusing an operation on the caller's behalf is not — `@Kavo(Entity, { operations: { updateOne: { policy: hasPermission('post:update') } } })` denies a request before it reaches its handler, where `hasPermission` is a one-line `Policy<Entity>` reading `context.app`. `policy` is a single function — `({ context, entity, resource, operation, params }) => boolean | Promise<boolean>` — so composition (role bypasses, ownership checks, anything else) is ordinary `&&`/`||`/`!` inside it, not a combinator DSL to learn, and it can also default at entity or global scope (`EntityConfig.policy`, `createKavo({ policy })`) rather than repeating itself per operation. A guard still decides who may call the route at all; `policy` decides who may perform _this_ operation once they're in, and a replacement handler still decides what they get back. See [Policy](/features/policy) for the full shape and how the stage behaves.
