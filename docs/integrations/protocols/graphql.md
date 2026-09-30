# GraphQL

`@kavo/graphql` builds a `GraphQLSchema` over an existing `createCrud` service. Every resolver calls straight into the same engine REST uses: the same filter, sort, and pagination validation, the same error handling, and no parallel request path.

## Zero-config mounting

Inside a Nest app, the fastest path is `KavoModule`'s `graphql` option, which mounts a default controller merging every entity that registered its GraphQL types:

```ts
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  graphql: true, // mounts POST /graphql, unguarded: see "No auth guard by default"
});

// Or choose the path, and guard it:
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  graphql: { path: "api/graphql", guards: [GraphQLAuthGuard] },
});
```

Setting `graphql` implies `provideServices`, because the merged schema's resolvers need every entity's service as a DI provider to look them up.

**Without `guards`, the zero-config route has no auth guard.** Anyone who can reach `POST /graphql` can run every query and mutation an entity registered. See [No auth guard by default](#no-auth-guard-by-default) before you set `graphql: true`.

Each entity registers its GraphQL types once, next to its other config. This is opt-in, not implied by `@Kavo` alone:

```ts
// owner.graphql-types.ts
registerKavoGraphQLTypes(Owner, {
  itemType: OwnerType, // hand-written GraphQLObjectType
  createInputType: CreateOwnerInput, // optional — omit to skip the mutation
  updateInputType: UpdateOwnerInput,
  patchInputType: PatchOwnerInput,
  deleteOne: true,
  restoreOne: true, // a bootstrap error unless Owner declared soft delete
  purgeOne: true,
});
```

Each field is opt-in per entity. Omitting an option leaves the field out of the schema entirely:

| Field                                       | Enabled by                                            |
| ------------------------------------------- | ----------------------------------------------------- |
| `Query.owner(id)`                           | always, unless `findOne` is disabled or service-only  |
| `Query.owners(limit, offset, sort, filter)` | always, unless `findMany` is disabled or service-only |
| `Mutation.createOwner`                      | `createInputType`                                     |
| `Mutation.updateOwner`                      | `updateInputType`                                     |
| `Mutation.patchOwner`                       | `patchInputType`                                      |
| `Mutation.deleteOwner: Boolean`             | `deleteOne: true`                                     |
| `Mutation.restoreOwner: Owner`              | `restoreOne: true`                                    |
| `Mutation.purgeOwner: Boolean`              | `purgeOne: true`                                      |

An operation that is disabled, or marked service-only (`meta.routes.enabled: false`), never reaches the schema, just as it gets no REST route or MCP tool: a disabled or service-only `findOne`/`findMany` is left off `Query`, and naming one here (`deleteOne: true`, an input type, or an `operations` entry) fails at bootstrap with a `ConfigurationException`. That includes `restoreOne`/`purgeOne` on an entity that never declared soft delete.

`filter` and `sort` on `Query.owners` use Kavo's own grammar, not a generated per-entity input type. `sort` takes REST's `-field` string convention. `filter` takes a raw filter-AST `JSON` scalar (`{ kind: "condition", field, operator, value }`, operators in `SCREAMING_SNAKE`) rather than a typed input object.

## Custom operations

A [custom operation](/core/custom-operations) reaches the schema too, opt-in per id through the same `operations` option:

```ts
registerKavoGraphQLTypes(Order, {
  itemType: OrderType,
  operations: {
    markPaidOne: { type: OrderType }, // { inputType } too, for a write that takes a body
  },
});
```

Naming an id there is not enough by itself: the operation still has to be enabled and declare a matching `schema` shape (`operations.markPaidOne.schema.output`, and `schema.input` if `inputType` is given) on the entity's own config — a custom id has no entity-derived schema fallback the way the standard eight do, so there is nothing to build a typed field from otherwise. Naming an id here whose registry entry is missing, disabled, or missing the matching declared shape fails at schema-build time with a `ConfigurationException`, not a silently omitted field.

The field's placement — `Query` or `Mutation` — follows the operation's registered `kind` (`"read"`/`"write"`), the same as everywhere else the registry decides that. A cardinality-`"one"` operation takes an `id` argument the way `update`/`delete`/etc. do; a cardinality-`"many"` one does not. The field name is `<lowerName><OperationId>` (`orderMarkPaidOne`), namespaced by the entity the same way the standard fields already are.

## No auth guard by default

Unless you pass `guards`, the zero-config controller carries no guard, interceptor, or other route-level protection. To gate the route, hand the option your guards:

```ts
KavoModule.forRoot({ infrastructure, graphql: { guards: [GraphQLAuthGuard] } });
```

They go on the generated controller with `@UseGuards`, so a denial stops the request before any resolver runs, with the guard's own error (`403` when it returns `false`). A guard class is built inside `KavoModule`, so its dependencies must come from a global module or from `forRootAsync`'s `imports`, and it must stay singleton-scoped ([Guarding the zero-config routes](/guides/configuration/module-setup#guarding-the-zero-config-routes)). An app-wide `APP_GUARD` also covers the route.

A guard decides whether a request gets in. It does not tell the engine who is calling. A guard on an entity's `@Kavo`-decorated REST controller does not extend to `POST /graphql`, and neither does anything else that lives on that controller:

- An `@Override`'d or hand-written method's own authorization. Resolvers call the entity's service directly, so they never reach controller code.
- Nest's `ValidationPipe` on a class-shaped `schema.input`. It validates REST bodies only.
- The module's `app` context extractor. `context.app` is `{}` for every GraphQL call ([Wiring your own auth](/guides/wiring-your-own-auth)).

What the engine enforces does hold here: the field allowlists, write-body stripping, `policy`, `filter.apply` and `set`, but evaluated with an empty `context.app`, guards or not. So a per-caller rule (an `owner()` policy, a tenant `filter.apply`) sees no caller over GraphQL. That is true of a hand-written `BaseKavoGraphQLController` too, which has no way to pass one. Keep an entity whose rules depend on the caller off the GraphQL surface, or make those rules deny when `context.app` is empty.

## Mounting your own controller

For more control than a path and guards (interceptors, a different method or transport) extend `BaseKavoGraphQLController` instead of using the `graphql` option:

```ts
@Controller("graphql")
export class GraphQLController extends BaseKavoGraphQLController {
  constructor(moduleRef: ModuleRef) {
    super(moduleRef);
  }

  @Post()
  @HttpCode(200) // GraphQL-over-HTTP convention: 200 even for a mutation
  @UseGuards(GraphQLAuthGuard)
  handle(@Body() body: { query: string; variables?: Record<string, unknown> }) {
    return this.execute(body.query, body.variables);
  }
}
```

Pick one mounting approach per app. The zero-config option and a hand-written controller are alternatives, never both at the same path.

## Outside Nest

`@kavo/graphql` is host-framework-agnostic: it imports only `@kavo/core` and the `graphql` peer, never `@kavo/nest`. `createKavoGraphQLSchema` and `mergeKavoGraphQLSchemas` build a schema directly from one or more `createCrud` services, for any host that can serve a `GraphQLSchema` over HTTP.

## Installing it

`graphql` is an optional peer of both `@kavo/nest` and `@kavo/graphql` itself, so a REST-only install pulls in neither.

Inside a Nest app, `@kavo/nest` already depends on `@kavo/graphql`. Add just the peer:

<CodeGroup>

```bash pnpm
pnpm add graphql
```

```bash npm
npm install graphql
```

```bash yarn
yarn add graphql
```

```bash bun
bun add graphql
```

</CodeGroup>

Outside Nest, add `@kavo/graphql` yourself too, alongside `@kavo/core` and whichever ORM adapter you use:

<CodeGroup>

```bash pnpm
pnpm add @kavo/core @kavo/graphql graphql
```

```bash npm
npm install @kavo/core @kavo/graphql graphql
```

```bash yarn
yarn add @kavo/core @kavo/graphql graphql
```

```bash bun
bun add @kavo/core @kavo/graphql graphql
```

</CodeGroup>

See [Peer dependencies](/reference/peer-dependencies) for the full version table.

## What's not covered yet

- Relations and includes aren't exposed as GraphQL fields. Only scalar `itemType` fields exist today; a relation would need to be hand-added with its own resolver.
- There's no generated per-entity `FilterInput` type.
- The list envelope's `meta` bag doesn't reach GraphQL clients. The generated list type declares `items`, `total`, `limit`, and `offset` only.

See [GraphQL binding](/internals/architecture/13-graphql-binding) for the full design, including the one-directional `frameworks/* → protocols/*` package boundary ([ADR-0016](/internals/adr/0016-graphql-protocols-package)) that lets `@kavo/nest` depend on this package without the reverse ever being true.
