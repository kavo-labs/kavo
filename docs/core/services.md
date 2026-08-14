# Services

`@Kavo(Entity, config)` and `createCrud(Entity, config)` both return the same thing: a `DefaultKavoService<Entity, ...>` instance, typed from the entity and whatever DTOs you registered. It's the programmatic front door — every generated HTTP route is this service's method, called for you; nothing about it is HTTP-specific.

```ts
const books = createCrud(Book);

await books.createOne({ title: "Dune", author: "Herbert" });
await books.findOne(1);
await books.findMany({ filter: { author: { eq: "Herbert" } } });
await books.updateOne(1, { title: "Dune (Deluxe)" });
await books.patchOne(1, { title: "Dune" });
await books.deleteOne(1);
```

## The eight methods

`createOne`, `findOne`, `findMany`, `updateOne`, `patchOne`, `deleteOne`, `restoreOne`, `purgeOne` — one per standard operation, named and shaped after it. Each takes the operation's input (a body, an id, a query, or nothing), an optional `KavoCallOptions`, and returns the operation's output (an item, a list envelope, or `void`):

```ts
findOne(id: Id, query?: QueryDto, options?: KavoCallOptions): Promise<ItemDto>;
findMany(query?: QueryDto, options?: KavoCallOptions): Promise<ListResultDto<ListDto>>;
```

Every generic parameter defaults from the entity, so the zero-config path needs no manual type arguments — `createCrud(Book)` alone yields a fully typed service. Registering a DTO class narrows exactly the corresponding parameter, and everything downstream (the envelope, every method's return type) follows from that one change. See [DTOs](/core/dtos) for how a slot is registered, and [core contracts](/internals/architecture/03-core-contracts-and-type-system) for the full generic-parameter table.

## `KavoCallOptions`

The second argument every method accepts, for anything that isn't part of the entity's own shape:

```ts
await books.findOne(1, undefined, { principal: currentUser });
```

- **`principal`** — the authenticated caller, opaque to Kavo. See [Wiring your own auth](/guides/wiring-your-own-auth).
- **`preconditions`** — `If-Match`/`If-None-Match` tokens for [conditional writes](/features/caching-and-etags).
- **`transaction`** — an opaque adapter-supplied handle, for a caller that already has one open.

A generated HTTP route passes the same options object the engine would build from the request — the service is not a different code path from the routes, just a typed wrapper over the same one.

## Calling a custom operation: `run`

An operation outside the standard eight — see [Custom operations](/core/custom-operations) — has no named method, because Kavo doesn't know its name until you declare it. Call it through `run`:

```ts
await service.run("markPaidOne", { id: 7, body: { reference: "INV-42" } });
```

`run`'s result and argument types come from the operation's own `dto` override, or, failing that, from its handler's own signature — the same type inference the eight named methods get.

## Reaching the engine directly

`DefaultKavoService` wraps one `KavoEngine`, exposed as `service.engine`. Every method above is `engine.execute(...)` plus an unwrap to the item/list half of the response envelope; the raw `execute` call is what you reach for when you need the envelope itself — its `etag`/`notModified` flags, for instance, the way `@kavo/nest`'s generated routes do. Most application code never needs this; it exists for framework bindings and for an `@Override`'d method that wants engine-level control (see [Routes & controllers](/core/routes-and-controllers)).

## Inside a Nest controller

`boundKavoService(this)` reaches the service `KavoModule`'s discovery binder already attached to a `@Kavo`-decorated controller instance — the pattern both `@Override`'d methods and fully custom routes use:

```ts
@Controller("books")
@Kavo(Book)
export class BookController {
  private get base(): DefaultKavoService<Book> {
    return boundKavoService<Book>(this);
  }

  @Get(":id/summary")
  async summary(@Param("id") id: string) {
    const book = await this.base.findOne(id as never);
    return { headline: `${book.title} — ${book.author}` };
  }
}
```

If some other class needs the service through constructor injection instead, `getKavoServiceToken(Entity)` is the DI token — see [Module setup](/guides/configuration/module-setup) for `provideServices`/`forFeature`.
