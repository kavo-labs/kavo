# Routes & controllers

`@Kavo(Entity, config?)` generates one route per **enabled** entry in the entity's [operation registry](/core/crud-operations), at class-definition time. That's the only moment Nest's router scan can see the methods it installs ([ADR-0012](/internals/adr/0012-decoration-time-route-generation)). Every generated route calls into the same [`DefaultKavoService`](/core/services)/engine pipeline the programmatic surface uses, and returns the same envelope.

```ts
@Kavo(Book)
@Controller("books")
export class BookController {}
```

produces the standard table from [CRUD operations](/core/crud-operations) with no other code. A route's shape (method, path, success status) is overridable per operation through `meta.routes`, and `meta.routes.enabled: false` keeps an operation service-only (callable, no route):

```ts
@Kavo(Book, {
  operations: {
    findMany: { meta: { routes: { path: "search" } } },
  },
})
```

## Custom operations get routes too

An `operations` key outside the standard eight is an ordinary registry entry, so the same generator loop routes it from its own `meta.routes`. See [Custom operations](/core/custom-operations) for declaring one. Custom entries are registered **ahead of** the standard table, so a custom `GET /books/featured` is matched before it could be swallowed by `GET /books/:id`.

## Three ways to change what a route does

**Manual-method-wins.** A hand-written controller method whose name matches an operation id suppresses that generated route entirely: no route, no Swagger metadata, nothing generated for it.

```ts
@Kavo(Book)
@Controller("books")
export class BookController {
  // No route is generated for findOne; this method is the whole story.
  @Get(":id")
  async findOne(@Param("id") id: string) {
    return { custom: true, id };
  }
}
```

**`@Override(operationId?)`.** The middle path: the method keeps everything a generated route would have given it (method, path, status, `@Param`/`@Query`/`@Body` wiring, and Swagger metadata). Only the function backing it is your own, not the generated one. `operationId` defaults to the method's name.

```ts
@Kavo(Book)
@Controller("books")
export class BookController {
  private get base() {
    return boundKavoService<Book>(this);
  }

  @Override()
  async createOne(body: EntityInput<Book>) {
    // Custom behavior, then delegate to the default pipeline.
    return this.base.createOne({ ...body, title: body.title?.trim() });
  }
}
```

The decorated method must accept parameters in the fixed position Kavo would apply. Reads: `(id?, query, preconditions, request)`. Writes: `(id?, body?, preconditions, request)`. It must not declare its own `@Param`/`@Query`/`@Body`. See [Reference/Decorators](/reference/decorators#override) for what an override inherits and what it doesn't (the `ETag` is automatic; `If-Match` enforcement is not, unless you forward `preconditions`).

**A fully custom, registry-independent route.** For an action with no operation identity at all, Kavo never inspects it. It's just an ordinary Nest method on a `@Kavo`-decorated class, reaching the service through `boundKavoService(this)`:

```ts
@Controller("books")
@Kavo(Book)
export class BookController {
  private get base() {
    return boundKavoService<Book>(this);
  }

  @Get(":id/summary")
  async summary(@Param("id") id: string) {
    const book = await this.base.findOne(id as never);
    return { headline: `${book.title} — ${book.author}` };
  }
}
```

Reach for `@Override` when the action _is_ one of the standard operations and should keep its generated route/Swagger/param wiring while only the implementation changes. Reach for a plain method when the action has no operation identity of its own. Reach for a [custom operation](/core/custom-operations) when it does have one: an action you want service-callable, config-scoped, and consistent with the rest of the registry.

## Wiring the app

A `@Kavo`-decorated controller needs a `KavoModule` in the app that hands it infrastructure:

```ts
@Module({
  imports: [
    KavoModule.forRoot({
      infrastructure: createInfrastructure(dataSource),
    }),
  ],
  controllers: [BookController],
})
export class AppModule {}
```

`KavoModule`'s discovery binder finds every `@Kavo`-decorated controller in the module graph's `controllers: [...]` array and binds its service. There's no per-entity registration step. See [Module setup](/guides/configuration/module-setup) for the full options surface, and [NestJS integration](/internals/architecture/10-nestjs-integration) for how the binder, route generation, and Swagger metadata fit together underneath.
