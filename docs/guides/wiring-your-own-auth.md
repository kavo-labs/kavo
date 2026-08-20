# Wiring your own auth

`KavoContext.principal` is the authenticated caller. Kavo carries it and nothing more: core never reads or judges the value. Your own code does, whether that's a [computed field](/features/computed-fields#computed) that varies by viewer, or a replacement `OperationHandler`.

Getting `principal` in place is two separate jobs, and only the second is Kavo's. Authenticating the caller is yours: a guard, a middleware, `@nestjs/passport`, whatever already runs ahead of the route handler and leaves the caller on the request. Kavo adds no auth dependency and mounts no guard of its own. What `principal` configures is the other half: moving that caller from the request onto the context.

```ts
KavoModule.forRootAsync({
  useFactory: () => ({
    infrastructure: createInfrastructure(dataSource),
    // `request.user`: where Passport and most hand-rolled guards leave it.
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
- It reaches standard and custom operations alike. One generated handler builds the request for every route, so a replacement handler on `POST /books/:id/claim` sees the same `context.principal` a plain `GET /books/1` does.
- It reaches the generated **REST** routes and nothing else. The GraphQL and MCP surfaces (`graphql`/`mcp` above, and controllers extending `BaseKavoGraphQLController`/`BaseKavoMcpController`) call the service directly, so `context.principal` is `null` there no matter what this option says. A computed field that varies by viewer answers for an anonymous caller over `POST /graphql`.
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

Row-scoping is still out of scope: Kavo will not filter `findMany`'s match set to the principal on its own. Refusing an operation on the principal's behalf is not — `@Kavo(Entity, { operations: { updateOne: { policy: permission('post:update') } } })` denies a request before it reaches its handler, evaluated against `context.principal` cast to the small `permissions`/`roles`/`userId` shape the built-in `permission`/`role`/`owner`/`authenticated` nodes read (compose with `and`/`or`/`not`, or drop to a `when(({ context, entity }) => …)` predicate for anything else). A guard still decides who may call the route at all; `policy` decides who may perform _this_ operation once they're in, and a replacement handler still decides what they get back. See [Policy](/features/policy) for the node reference and how the stage behaves.
