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
    // Naming any operation makes `operations` an exclusive whitelist (see
    // [Operations](/guides/configuration/operations)) — this reshapes
    // findMany alone only if every other standard operation is also named.
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

## OpenAPI documentation

When `@nestjs/swagger` is installed, every generated route — standard, custom, and `@Override`d alike — carries an `operationId` (`Book_findOne`), a `tags: ["Book"]` entry, and `x-kavo-entity`/`x-kavo-operation` vendor extensions on the operation object. Every inline DTO schema Kavo builds for a request or response body carries the same `x-kavo-entity`, so a generated OpenAPI document lets tooling recover which Kavo entity/operation an operation or schema came from without parsing `operationId`.

A client generator that splits output by `tags` — [Orval](https://orval.dev) and `openapi-generator` both do — will produce one module per entity out of the box; point it at the app's `/docs-json` (or wherever `SwaggerModule.setup` serves the document) with no extra configuration.

### Named component schemas

By default those DTO schemas are emitted **inline** on each route, so a generator names them anonymously. Wrap the built document in `registerKavoSchemas` (exported from `@kavo/nest`) to hoist every shape Kavo generated into `components.schemas` under a stable, entity-prefixed name and leave a `$ref` behind:

```ts
import { registerKavoSchemas } from "@kavo/nest";

SwaggerModule.setup("docs", app, registerKavoSchemas(SwaggerModule.createDocument(app, config)));
```

The `nest-typeorm` example wires exactly this in its `src/main.ts`.

For an entity `Ad` you get `AdCreate` / `AdUpdate` / `AdPatch` (request bodies), `AdItem` (single-row response), `AdList` with its `items[]` element `AdListItem` and its `meta` bag `AdListMeta`, the shared `KavoProblemDetails` / `KavoProblemDetailError` error bodies, and `AdValidationError` (the entity-scoped `400`, an `allOf` over `KavoProblemDetails`). Each component keeps its `x-kavo-entity` / `x-kavo-error` extension. This holds for an entity with no `dto` block at all — the schemas synthesized from its columns (see [DTOs](/core/dtos)) are hoisted the same way. A synthesized schema also carries a `required` array derived from column nullability: a non-nullable column is `required` in `AdCreate`, `AdUpdate`, `AdItem`, and the `AdListItem` element, while a nullable column and a computed field stay optional. Database-generated columns aren't writable, so they never appear in `AdCreate` / `AdUpdate` at all; a non-nullable generated column (the primary key, a create-timestamp) _is_ `required` in `AdItem` / `AdListItem`, since every row carries it. `AdPatch` is the deliberate exception — a partial update requires no field, so it carries no `required`. Two documentation-only over-statements: a non-nullable column with a database `default:` is still reported `required` in `AdCreate` even though you may omit it, and the response `required` describes the full row — a [`select=`](/querying/field-selection)-narrowed read returns a subset. The synthesized schema stays open in both cases, so this never changes what the route accepts or returns.

Response naming is operation-aware. The standard operations that serve the entity's root `item` / `list` shape all collapse onto `AdItem` / `AdList`. An operation with its own `dto.output` — a per-operation override or a [custom operation](/core/custom-operations) — serves a different shape and gets its own `Ad<Operation>` component (`AdArchiveOne`, …) rather than racing the root name.

The query surface Kavo can derive from the entity's resolved config is hoisted too: `AdPagination` (the page controls for the resolved `pagination.strategy` — `{ limit, offset }` for `offset`, `{ page[number], page[size] }` for `page`, `{ limit, cursor }` for `cursor`, `{ limit, since }` for `since`), `AdInclude` (an array whose items enum the top-level [includable](/features/allowlists) relation names — a nested path is dotted into one and is not enumerated), and `AdSort` (an array whose items enum the sortable keys, each present bare and `-`-prefixed for descending). These are additive documentation of the existing flat `limit`/`offset`/`include`/`sort` params — the params and the [query grammar](/querying/sorting) are unchanged. `AdInclude` is omitted when nothing is includable; `AdPagination` is still emitted under `pagination.strategy: "none"`, carrying a description that says the entity does not paginate. All three carry `x-kavo-entity` and are produced at module init (resolved allowlists don't exist at decoration time), so an app with no `KavoModule.forRoot`/`forRootAsync` gets none of them.

Unlike the DTO components above, these three are deliberately not `$ref`d from anywhere — they exist purely so a client generator can name the query shapes. A bundler or generator that prunes unreferenced `components.schemas`, or a linter that flags orphans, will drop or warn on them; that is expected, not a bug.

The helper is opt-in and purely additive — it imports nothing from `@nestjs/swagger`, and a schema that is already a `$ref` (a `@ApiProperty`-decorated or declared-only DTO class, where `@nestjs/swagger` builds and names the schema itself) is left exactly as it is. The same shape requested under two names — `AdUpdate` and `AdPatch` are byte-identical when no `dto.patch` is set — is emitted under both. A genuine same-name/different-shape clash (rare after the operation-aware naming above — e.g. an entity literally named `AdListItem`) resolves first-wins, then `AdListItem_2`, `AdListItem_3`, …; that order is stable within a build but shifts if entities are added or `controllers: [...]` is reordered, so treat a `_2` as a prompt to disambiguate with an explicit DTO class, not a name to depend on.
