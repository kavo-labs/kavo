# GraphQL

`@kavo/graphql` builds a `GraphQLSchema` over an existing `createCrud` service. Every resolver calls straight into the same engine REST uses: the same filter, sort, and pagination validation, the same error handling, and no parallel request path.

## Zero-config mounting

Inside a Nest app, the fastest path is `KavoModule`'s `graphql` option, which mounts a default controller merging every entity that registered its GraphQL types:

```ts
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  graphql: true, // mounts POST /graphql
});

// Or choose the path:
KavoModule.forRoot({
  infrastructure: createInfrastructure(dataSource),
  graphql: { path: "api/graphql" },
});
```

Setting `graphql` implies `provideServices`, because the merged schema's resolvers need every entity's service as a DI provider to look them up.

Each entity registers its GraphQL types once, next to its other config. This is opt-in, not implied by `@Kavo` alone:

```ts
// owner.graphql-types.ts
registerKavoGraphQLTypes(Owner, {
  itemType: OwnerType, // hand-written GraphQLObjectType
  createInputType: CreateOwnerInput, // optional — omit to skip the mutation
  updateInputType: UpdateOwnerInput,
  patchInputType: PatchOwnerInput,
  deleteOne: true,
  restoreOne: true, // meaningful only if Owner declared soft delete
  purgeOne: true,
});
```

Each field is opt-in per entity. Omitting an option leaves the field out of the schema entirely:

| Field                                       | Enabled by         |
| ------------------------------------------- | ------------------ |
| `Query.owner(id)`                           | always             |
| `Query.owners(limit, offset, sort, filter)` | always             |
| `Mutation.createOwner`                      | `createInputType`  |
| `Mutation.updateOwner`                      | `updateInputType`  |
| `Mutation.patchOwner`                       | `patchInputType`   |
| `Mutation.deleteOwner: Boolean`             | `deleteOne: true`  |
| `Mutation.restoreOwner: Owner`              | `restoreOne: true` |
| `Mutation.purgeOwner: Boolean`              | `purgeOne: true`   |

`filter` and `sort` on `Query.owners` use Kavo's own grammar, not a generated per-entity input type. `sort` takes REST's `-field` string convention. `filter` takes a raw filter-AST `JSON` scalar (`{ kind: "condition", field, operator, value }`, operators in `SCREAMING_SNAKE`) rather than a typed input object.

## Mounting your own controller

For more control (a custom path, guards, interceptors) extend `BaseKavoGraphQLController` instead of using the `graphql` option:

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

::: code-group

```bash [pnpm]
pnpm add graphql
```

```bash [npm]
npm install graphql
```

```bash [yarn]
yarn add graphql
```

```bash [bun]
bun add graphql
```

:::

Outside Nest, add `@kavo/graphql` yourself too, alongside `@kavo/core` and whichever ORM adapter you use:

::: code-group

```bash [pnpm]
pnpm add @kavo/core @kavo/graphql graphql
```

```bash [npm]
npm install @kavo/core @kavo/graphql graphql
```

```bash [yarn]
yarn add @kavo/core @kavo/graphql graphql
```

```bash [bun]
bun add @kavo/core @kavo/graphql graphql
```

:::

See [Peer dependencies](/reference/peer-dependencies) for the full version table.

## What's not covered yet

- Relations and includes aren't exposed as GraphQL fields. Only scalar `itemType` fields exist today; a relation would need to be hand-added with its own resolver.
- There's no generated per-entity `FilterInput` type.
- The list envelope's `meta` bag doesn't reach GraphQL clients. The generated list type declares `items`, `total`, `limit`, and `offset` only.

See [GraphQL binding](/internals/architecture/13-graphql-binding) for the full design, including the one-directional `frameworks/* → protocols/*` package boundary ([ADR-0016](/internals/adr/0016-graphql-protocols-package)) that lets `@kavo/nest` depend on this package without the reverse ever being true.
