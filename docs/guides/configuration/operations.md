# Operations

Per-operation overrides and fully custom operations on `@Kavo(Entity, config)`, plus how to add data to a list response's `meta` bag.

## operations

Per-operation overrides, keyed by operation id. A key that names one of the eight standard operations configures it; any other key [declares a custom operation](#custom-operations).

**`operations` is an explicit whitelist once it's declared at all.** An entity with no `operations` key gets every standard operation at its global/built-in default (`createOne`/`findOne`/`findMany`/`updateOne`/`patchOne`/`deleteOne` on, `restoreOne`/`purgeOne` off unless soft delete is declared). The moment `operations` is present, every standard id it doesn't name is off. `true`/`false` names one explicitly, in either direction, with no settings attached; an object carrying settings enables by being named — there's no `enabled` field, since a settings object's own presence already says so.

```ts
@Kavo(Book, {
  operations: {
    createOne: true,
    findOne: true,
    findMany: true,
    updateOne: true,
    deleteOne: true,
    restoreOne: { meta: { routes: { path: ":id/undelete" } } },
    // patchOne isn't named, so it's off.
  },
})
```

An `OperationConfig` object accepts:

- **`handler`** (`OperationHandler<Entity>`): a replacement handler function, keeping the default DTO/serialization scaffolding around it.
- **`meta`** (`OperationMetadata`): an opaque bag consumed by the framework layer; in `@kavo/nest` this is `{ routes: KavoRouteOptions }`.
- **`dto`** (`{ input?, output?, query? }`): overrides the entity's root `dto` slot for this operation only, see below.
- **any settings key** (same shape as global `KavoSettings`): overrides that apply to this operation only, one level above the entity's own settings — merged with, not replacing, the entity/global settings it doesn't mention.

**`operations.<id>.dto`** narrows one operation's request body, response, or query contract independently of the entity's root `dto` slots (§`dto` on [Entity config](/guides/configuration/entity-config#dto)). Only the fields a given operation actually has are accepted: `input`/`output` on a write, `output`/`query` on a read, neither on `deleteOne`/`purgeOne` (void results).

```ts
@Kavo(Book, {
  dto: { item: BookItemDto }, // entity-wide default for every read
  operations: {
    findOne: { dto: { output: BookDetailDto } }, // findOne only
    createOne: { dto: { input: CreateBookRequestDto, output: BookCreatedDto } },
  },
})
```

Fallback order per field: `operations.<id>.dto.<field>`, then the entity's root `dto.<slot>`, then the entity-derived default. Setting a field an operation doesn't have (`dto.query` on `createOne`, say) is both a type error and a bootstrap `ConfigurationException`. See [DTO system §8](/internals/architecture/04-dto-system#8-per-operation-override-issue-131) for the full applicability table and the fallback chain in the engine.

**`operations.<id>.meta.routes`** (`@kavo/nest`'s `KavoRouteOptions`) accepts:

- **`method`** (`"GET"` | `"POST"` | `"PUT"` | `"PATCH"` | `"DELETE"`, default: the operation's standard verb): overrides which HTTP verb the generated route uses.
- **`path`** (`string`, default: the operation's standard path): route path relative to the controller (e.g. `":id/activate"`).
- **`enabled`** (`boolean`, default: `true`): `false` makes the operation service-only: still callable through `service.engine.execute(...)`, but no route is generated.
- **`successStatus`** (`number`, default: `201` create, `204` delete, `200` otherwise): overrides the response status code on success.

See [NestJS integration](/internals/architecture/10-nestjs-integration) for how route generation reads this, and [Registry-driven operations](/internals/adr/0006-registry-driven-operations) for why routes always come from the same registry the engine uses.

## Custom operations

An `operations` key that is not one of the eight standard ids declares an operation of your own. It's an ordinary registry entry, so it gets the same pipeline every built-in route gets: DTO resolution, deserialization, serialization, the `ETag`, problem-details errors, and the module's `app` context.

A custom id is exempt from the whitelist rule above — it's always registered when present — but declaring one still counts as declaring `operations`, so it still silences every standard operation you don't also name. The example below is deliberately CRUD-only-plus-one: if `Order` also needs `findOne`/`findMany`/etc., they need naming here too.

```ts
@Kavo(Order, {
  operations: {
    markPaidOne: {
      dto: { input: MarkPaidDto },
      handler: {
        async execute({ id, body }: { id: number; body: MarkPaidDto }, context) {
          // `context.repository` is this entity's own repository adapter.
          const order = await context.repository.findOneById(id, null, context);
          if (order === null) {
            throw new NotFoundException({ messageParams: { entity: context.entityName, id: String(id) } });
          }
          return context.repository.patch(id, { paidAt: new Date(), reference: body.reference }, context);
        },
      },
      meta: { routes: { method: "POST", path: ":id/mark-paid" } },
    },
  },
})
@Controller("orders")
export class OrderController {}
```

A custom-operation entry accepts:

- **`handler`** (`OperationHandler<Entity>`, required): the operation's behavior. There's no built-in to fall back to, so an entry without one fails at bootstrap.
- **`kind`** (`"read"` | `"write"`, default: `"write"`): a read runs query resolution and takes no request body; the generated route binds `@Query` instead of `@Body`.
- **`cardinality`** (`"one"` | `"many"`, default: `"one"`): `"many"` returns the list envelope, so the handler must return `{ entities, total }` the way a `findMany` handler does.
- **`enabled`** (`boolean`, default: `true`): `false` registers the entry inert: no route, and calling it answers `405 KAVO_OPERATION_DISABLED`.
- **`dto`** (`{ input?, output?, query? }`): `input`/`output` on a write, `output`/`query` on a read. A custom operation has no root DTO slot of its own, so this is where it gets a shape.
- **`meta`** (`OperationMetadata`, default: `{}`): the route, as above. Without it the operation is routed `POST /<operation id>`.
- **any settings key** (same shape as global `KavoSettings`): the operation scope of the precedence chain, exactly as for a standard id.

Naming follows the same convention the built-ins do: camelCase, always spelling out cardinality (`markPaidOne`, `findPendingMany`). An id that differs from a standard one only by case is refused at bootstrap, since `deleteone` is a slip rather than a name.

### Reaching the database from a handler

`context.repository` is the entity's [`RepositoryAdapter`](/internals/architecture/03-core-contracts-and-type-system), reads and writes both, and it's how a handler gets at data ([ADR-0025](/internals/adr/0025-handlers-reach-persistence-through-the-context)). Nothing is closed over, which is what makes the example above work at all: a `@Kavo` config literal is evaluated when the class is defined ([ADR-0012](/internals/adr/0012-decoration-time-route-generation)), so a `DataSource` built inside `KavoModule.forRootAsync`'s factory doesn't exist yet, and neither does the adapter derived from it.

Adapter methods take a context of their own, so pass the one you were given back: `context.repository.patch(id, data, context)`. That puts the call inside the request's transaction, applies the resolved soft-delete strategy, and gives it the settings view in force for this call. Two things it deliberately is not:

- **It is this entity's adapter only.** A write to another entity is yours to make, through whatever you already use to reach it (an injected service on the controller, the ORM directly). Kavo doesn't hand out a registry of every entity's adapter.
- **It is not narrowed by `kind`.** A `kind: "read"` handler is handed the writer half too. `kind` decides the request's shape, not what your code is allowed to do.

A handler that needs an injected application service, rather than the database, is still a case for `@Override` or a hand-written route: a config-level handler is a plain object, with no `this` and no constructor to inject into.

In code, a custom operation is called through `run`, which takes the id and returns the same envelope-unwrapped result the named methods do:

```ts
await service.run("markPaidOne", { id: 7, body: { reference: "INV-42" } });
```

Worth knowing before you reach for one:

- **Custom routes are matched first.** Custom entries are registered ahead of the standard table, so `GET /orders/pending` reaches its own handler rather than `GET /orders/:id`. The flip side is that a custom entry whose `meta.routes` reproduces a standard route's shape takes that route.
- **The handler is built at decoration time** ([ADR-0012](/internals/adr/0012-decoration-time-route-generation)), like everything else in a `@Kavo` config, so it's a plain object with nothing in scope but its arguments. Data access comes from `context.repository` (above), and anything else it needs has to be reachable from module scope.
- **`If-Match` is refused, not ignored.** Nothing in the schema says which row a custom operation targets, so a conditional request against one answers `412 KAVO_PRECONDITION_UNSUPPORTED` rather than writing unguarded ([ADR-0020](/internals/adr/0020-content-hash-etags-and-the-engine-read-seam)).
- **The result is projected through the entity, unless you say otherwise.** A custom operation goes through the whole pipeline, and that includes serialization: with no `dto.output`, the handler's return value is filtered to the entity's own columns (plus any opted-in virtual field), exactly as a `findOne` response would be. A result that is a narrower entity shape is served as-is. A result with its own shape needs a DTO:

  ```ts
  class ImportOutcomeDto {
    applied = 0;
    skus: string[] = [];
  }

  operations: {
    // `One`, not `Many`: cardinality names the *response*, and this one
    // answers with a single outcome however many rows it wrote.
    importPricesOne: { handler, dto: { output: ImportOutcomeDto } },
  }
  ```

  Every field needs a runtime initializer, since an uninitialized class field erases and the class then narrows nothing.

  A result the projection empties raises, rather than serving `{}`. `KAVO_CONFIG_INVALID` names the operation and says which of three mistakes it is: no DTO and no field in common with the entity, a registered DTO the handler's keys don't match, or a registered DTO with no runtime fields. It fires on a plain object, on a class instance whose values are accessors, and on an array (the last being what a handler that meant `cardinality: "many"` and left it at the default returns). It does not fire under an explicit `select=`, which can empty a projection on its own.

  Two things follow from it being a request-time refusal. The handler has already run, so a write it made through `context.repository` stands. And a partial strip, a result mixing entity fields with its own, is still silent, because that's what a projection is for.

- **The route defaults to `POST` and `201`.** A custom id is absent from the standard route table, so it falls back to `POST /<controller>/<operation id>` with a `201`: a custom operation is a write against the collection until its `meta.routes` says otherwise. A read that returns an existing row almost certainly wants `meta: { routes: { method: "GET", path: ":id/summary", successStatus: 200 } }`.

Custom operations are a REST and programmatic feature only: the GraphQL and MCP bindings expose the standard operations.

## Custom list metadata

The list envelope's `meta` bag (`ListResultDto.meta`) is the place for anything about the list that isn't a row: facet counts, a freshness stamp, a cursor. It doesn't need a DTO or a config key. Whatever the `findMany` handler returns as `meta` is what the client receives.

It's the envelope's one optional field. Until a handler fills it, the key is absent from the response, not `{}`, so the common zero-config list doesn't carry an empty bag on every request; a contributor that returns `{}` leaves it absent too. Type it and read it accordingly: `body.meta?.inStock`.

> `ListResultDto.meta` on the response and `operations.<id>.meta` above are unrelated. The first is an open bag on the list envelope; the second is `OperationMetadata`, route options the framework layer reads, which never reach a response body.

`withListMeta` wraps an existing handler so a contributor function's keys land on the bag, which saves rewriting the built-in `findMany` just to add one number:

```ts
// book.controller.ts
import { builtInHandlers, withListMeta } from "@kavo/core";

const findMany = builtInHandlers<Book>()("findMany");

@Kavo(Book, {
  operations: {
    // Every other standard operation, named to keep it at its own default —
    // declaring `operations` at all makes it a whitelist (see above).
    createOne: true,
    findOne: true,
    updateOne: true,
    patchOne: true,
    deleteOne: true,
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

`builtInHandlers<Book>()` takes no adapter: the handlers it returns read the request's own `context.repository` ([ADR-0025](/internals/adr/0025-handlers-reach-persistence-through-the-context)), which is what lets this wrap be written inside a `@Kavo` config, evaluated when the class is defined and before any `DataSource` exists. Pass one (`builtInHandlers(replica)`) only to point those handlers somewhere other than the entity's own adapter.

`withListMeta` behaves as follows:

- **Contributor input**: the wrapped handler's whole result (`entities`, `total`, and any `meta` it already set) plus the request `KavoContext`. It may be `async`.
- **Merge precedence**: the contributor's keys win. The inner handler's `meta` is the base and the contributor merges over it, so the outermost wrap owns any key it names; keys it doesn't name pass through.
- **Overriding that**: the inner bag is in hand, so return `{ ...mine, ...result.meta }` to let the inner handler win instead.
- **Serialization**: none. `meta` is your data, not entity data: no DTO projection, no `select=` selection, no renaming. It must be JSON-serializable.
- **Nothing contributed**: the key is left off the response entirely. Judged on the merged bag, so `{}` from a contributor is the same as no contributor at all.
- **Wrong-shaped handler**: wrapping a handler that doesn't return `{ entities, total }` raises `ConfigurationException` (`KAVO_CONFIG_INVALID`) naming the operation, rather than serving a malformed envelope.

The wrapper is a convenience, not a requirement. The engine reads `meta` off whatever the `findMany` handler returns, so a hand-written one works the same way:

```ts
import type { FindManyResult, KavoContext } from "@kavo/core";

const handler = {
  async execute(_input: null, context: KavoContext<Book>) {
    // `builtInHandlers(...)` hands back `OperationHandler<Book>`, whose
    // output type is `unknown`, the same erasure `withListMeta` works
    // around with its runtime shape check. Hand-rolling the wrap means
    // narrowing it yourself.
    const inner = (await findMany.execute(null, context)) as FindManyResult<Book>;
    return { ...inner, meta: { inStock: 1 } };
  },
};
```

**Transport support.** `meta` rides the same envelope everywhere, so it reaches REST responses and [MCP](/internals/architecture/16-mcp-binding) tool results unchanged. It is not exposed by the [GraphQL binding](/internals/architecture/13-graphql-binding): that binding's generated list type declares `items`/`total`/`limit`/`offset` only, so a GraphQL client can't select `meta` today.
