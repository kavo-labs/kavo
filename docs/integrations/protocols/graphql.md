# GraphQL

`@kavo/graphql` builds a `GraphQLSchema` over an existing `createCrud` service. Every resolver calls straight into the same engine REST uses — same filter/sort/pagination validation, same error handling, no parallel request path.

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

Setting `graphql` implies `provideServices` — the merged schema's resolvers need every entity's service as a DI provider to look them up.

Each entity registers its GraphQL types once, next to its other config — this is opt-in, not implied by `@Kavo` alone:

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

Each field is opt-in per entity — omitting an option leaves the field out of the schema entirely:

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

`filter`/`sort` on `Query.owners` use Kavo's own grammar, not a generated per-entity input type: `sort` takes REST's `-field` string convention, and `filter` takes a raw filter-AST `JSON` scalar (`{ kind: "condition", field, operator, value }`, operators in `SCREAMING_SNAKE`) rather than a typed input object.

## Mounting your own controller

For more control — a custom path, guards, interceptors — extend `BaseKavoGraphQLController` instead of using the `graphql` option:

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

Pick one mounting approach per app — the zero-config option and a hand-written controller are alternatives, never both at the same path.

## Outside Nest

`@kavo/graphql` is host-framework-agnostic — it imports only `@kavo/core` and the `graphql` peer, never `@kavo/nest`. `createKavoGraphQLSchema`/`mergeKavoGraphQLSchemas` build a schema directly from one or more `createCrud` services, for any host that can serve a `GraphQLSchema` over HTTP.

## Installing it

`graphql` is an optional peer of both `@kavo/nest` and `@kavo/graphql` itself, so a REST-only install pulls in neither:

::: code-group

```bash [pnpm]
pnpm add graphql
```

```bash [npm]
npm install graphql
```

:::

See [Installation](/getting-started/installation#graphql-and-mcp) for the full peer-dependency picture.

## What's not covered yet

Relations/includes aren't exposed as GraphQL fields (only scalar `itemType` fields exist today — a relation would need to be hand-added with its own resolver), there's no generated per-entity `FilterInput` type, and the list envelope's `meta` bag doesn't reach GraphQL clients (the generated list type declares `items`/`total`/`limit`/`offset` only). See [GraphQL binding](/internals/architecture/13-graphql-binding) for the full design, including the one-directional `frameworks/* → protocols/*` package boundary ([ADR-0016](/internals/adr/0016-graphql-protocols-package)) that lets `@kavo/nest` depend on this package without the reverse ever being true.
