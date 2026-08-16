# Decorators

`@kavo/nest`'s two decorators: `@Kavo()`, which generates the CRUD surface, and `@Override()`, which replaces one operation's implementation while keeping its generated route.

## `@Kavo(Entity, config?)`

```ts
function Kavo<
  Entity extends object,
  CreateDto = EntityInput<Entity>,
  UpdateDto = EntityInput<Entity>,
  PatchDto = Partial<UpdateDto>,
  QueryDto = QueryContext<Entity>,
  ItemDto = Entity,
  ListDto = ItemDto,
  Computed extends string = never,
  Ops extends OperationsConfig<...> = OperationsConfig<...>,
>(entity: ClassRef<Entity>, config?: EntityConfig<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto, Computed, Ops>): ClassDecorator;
```

Applied to a Nest controller class, alongside `@Controller(...)`:

```ts
@Kavo(Book, { allowlists: { filterable: ["title", "author"] } })
@Controller("books")
export class BookController {}
```

Every generic parameter defaults from `Entity`, so a zero-config call needs no manual type arguments. `@Kavo(Book)` alone yields a fully typed, fully wired controller. Registering a value in `config`, like a DTO class, an allowlist, or a computed field, narrows the corresponding parameter, and everything downstream follows it: the generated routes' Swagger schemas, the bound service's method signatures, the response shape. See [Entities](/core/entities) for what this decorator does and when, [core contracts](/internals/architecture/03-core-contracts-and-type-system) for the full generic-parameter table, and [Guides/Configuration](/guides/configuration/) for every field `config` accepts.

`entity` must be resolvable to a stable class reference at decoration time: the entity class itself for TypeORM/MikroORM, the model for Mongoose, a marker class for Prisma. See your ORM's [integration page](/integrations/orms/typeorm) for the exact form.

**It runs at class-definition time** (import time), not at app bootstrap ([ADR-0012](/internals/adr/0012-decoration-time-route-generation)). That's why a config-level `handler` (see [Custom operations](/core/custom-operations)) can't close over a `DataSource` or any other value built inside `KavoModule.forRootAsync`'s factory. Nothing built there exists yet when `@Kavo` runs.

## `@Override(operationId?)`

```ts
function Override(operationId?: OperationId): MethodDecorator;
```

Applied to a method on a `@Kavo`-decorated class, in place of the generated implementation for that operation:

```ts
@Kavo(Book)
@Controller("books")
export class BookController {
  @Override()
  async findOne(id: EntityId, query: WireQuery, preconditions: RequestPreconditions | null) {
    return this.base.findOne(id, query, { preconditions: preconditions ?? undefined });
  }
}
```

`operationId` defaults to the method's own name, the same inference manual-method-wins already uses. Pass it explicitly when the method name differs from the operation id.

**Parameter layout is fixed.** Kavo supplies the route decorators (`@Param`/`@Query`/`@Body`) itself, rather than letting the method declare its own. Reads take `(id?, query, preconditions, request)`. Writes take `(id?, body?, preconditions, request)`. Declare only as many parameters as the method actually uses. Declaring your own `@Param`/`@Query`/`@Body` on an overridden method is a decoration-time error (duplicate route-argument metadata).

### What an override inherits, and what it doesn't

| Behavior                         | Inherited  | Why                                                                                                                        |
| -------------------------------- | :--------: | --------------------------------------------------------------------------------------------------------------------- |
| Route, params, Swagger docs      |    yes     | Both paths apply the same route-decoration step.                                                                       |
| `ETag` on a single-item response |    yes     | `@Kavo` hashes whatever the method returns ([ADR-0027](/internals/adr/0027-an-override-inherits-the-etag-but-not-the-precondition)); there's nothing to opt into. |
| Method decorators you add        |    yes     | `@UseGuards`, `@SetMetadata`, `@Version`, and others are copied onto the wrapper.                                       |
| `If-Match` → `412`               |   **no**   | Evaluated inside the engine. It reaches your method only if you forward `preconditions`.                               |
| `If-None-Match` → `304`          | not Kavo's | The host framework answers it off the `ETag` header already set. Express does this automatically via `req.fresh`; another adapter may not. |
| Row scoping, authorization       |    n/a     | Never Kavo's, in a generated route or an override. That's why you're overriding.                                       |

An override that only needs the tag can return the typed service's item directly and let `@Kavo` hash it. One that needs the precondition enforced must forward `preconditions`, either as `{ preconditions }` on the typed service or by calling `service.engine.execute({ ..., preconditions })` directly. That also gets you the engine's own `304` answer instead of the host framework's approximation.

One caveat: the engine evaluates `If-Match` against a **canonical read**, what `findOne` with no `fields`/`include` would return. An override serving a reshaped representation hands out a tag the check can never match, so every conditional write on it answers `412`. Serve the canonical shape, or turn `caching: { etag: false }` off for that operation and own concurrency yourself.

This is distinct from plain manual-method-wins (a method whose name matches an operation id, undecorated). That suppresses the route entirely, with none of the generated wiring. `@Override` keeps all of it and only swaps which function backs the route. See [Routes & controllers](/core/routes-and-controllers) for how the three approaches compare, and [NestJS integration §2](/internals/architecture/10-nestjs-integration) for the decoration-time mechanics.
