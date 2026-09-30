---
name: graphql-binding
description: Reference for @kavo/graphql and its Nest binding — building a schema over an existing createCrud service, the raw-AST filter/sort args, multi-entity merging, the process-wide type registry, and the zero-code KavoModule graphql option. Use when exposing an entity over GraphQL, or answering "how do I add GraphQL to this entity" questions.
---

# GraphQL binding reference

`@kavo/graphql` (`packages/protocols/graphql`) builds a `GraphQLSchema` over
an existing `createCrud` service. Every resolver calls directly into the
same `DefaultKavoService`/engine pipeline REST binds to — no parallel
request path, no second copy of filter/sort/pagination validation, no
separate error handling. Full detail:
`docs/internals/architecture/13-graphql-binding.md` (and ADR-0016 for the
package-boundary rationale).

`@kavo/graphql` is host-framework-agnostic: it imports `@kavo/core` and the
`graphql` peer only, never `@kavo/nest`. `@kavo/nest` depends on
`@kavo/graphql`, not the other way around.

## One entity

```ts
import { createKavoGraphQLSchema } from "@kavo/graphql";

const schema = createKavoGraphQLSchema({
  name: "Owner",
  service: ownerService, // whatever createCrud(Owner, ...) returned
  itemType: OwnerType, // hand-written GraphQLObjectType
  createInputType: CreateOwnerInput, // optional — omit to skip the mutation
  updateInputType: UpdateOwnerInput,
  patchInputType: PatchOwnerInput,
  deleteOne: true,
  restoreOne: true, // meaningful only if Owner declared soft delete
  purgeOne: true,
});
```

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

**These flags do not cross-check REST's `@Kavo` config.** Setting
`restoreOne: true` here for an entity whose `@Kavo` config disables
`restoreOne` still adds the field to the schema — it throws
`OperationDisabledException` at _resolve_ time instead, same as calling the
REST route would. Keeping the two declarations in sync is your job today.

### Filter and sort args on `Query.<entity>s`

- **`sort: [String!]`** — REST's own `-field` convention
  (`["-createdAt", "name"]`), translated to `Sort[]` locally.
- **`filter: JSON`** — a custom `GraphQLJSON` scalar carrying Kavo's raw
  filter AST directly, **not** REST's wire grammar:
  - leaf: `{ kind: "condition", field, operator, value }`
  - group: `{ kind: "group", operator: "AND"|"OR"|"NOT", children: [...] }`
  - operators are `SCREAMING_SNAKE` (`EQ`, `GTE`, `IN`, …) — REST's camelCase
    wire tokens (`eq`, `gte`, `in`) do **not** work here. This is the raw-AST
    escape hatch, not the REST grammar re-encoded as JSON.

## Multiple entities on one schema

```ts
import { mergeKavoGraphQLSchemas } from "@kavo/graphql";

const schema = mergeKavoGraphQLSchemas([
  { name: "Owner", service: ownerService, itemType: OwnerType, createInputType: CreateOwnerInput },
  { name: "Cat", service: catService, itemType: CatType, createInputType: CreateCatInput },
]);
```

Field names are namespaced per entity's own `name` — no collisions. An
empty binding list throws `ConfigurationException` at schema-build time
(an empty `Query` type is invalid GraphQL either way; this fails with a
message naming the actual fix instead of a deep graphql-js validation
error on first request).

## Registering types once, discovering everywhere

Hand-listing every entity doesn't scale. Register each entity's GraphQL
types once, next to its DTOs:

```ts
// owner.graphql-types.ts
registerKavoGraphQLTypes(Owner, { itemType: OwnerType, createInputType: CreateOwnerInput });
```

`resolveKavoGraphQLSchema` (host-agnostic) then takes a list of `{ entity }`
refs and a `resolveService(entity)` callback, looks up each entity's
registered types (skipping any with none — opt-in, not implied by `@Kavo`
alone), and merges the rest.

## The Nest binding

Two ways to mount it, pick one per app/path — never both:

1. **Concrete controller** (full control):

   ```ts
   @Controller("graphql")
   export class GraphQLController extends BaseKavoGraphQLController {
     constructor(moduleRef: ModuleRef) {
       super(moduleRef);
     } // must be declared
     @Post()
     @HttpCode(200) // GraphQL-over-HTTP convention: 200 even for mutations
     handle(@Body() body: { query: string; variables?: Record<string, unknown> }) {
       return this.execute(body.query, body.variables);
     }
   }
   ```

2. **Zero-code path**: `KavoModule.forRoot({ infrastructure, graphql: true })`
   mounts `POST /graphql`; `{ graphql: { path: "api/graphql" } }` mounts it
   elsewhere. Setting `graphql` implies `provideServices` (the merged
   schema's resolvers need every entity's service as a DI provider), even
   if `provideServices` itself is left unset.

   ⚠️ **The route is unguarded unless you give it guards**, mutations
   included; a guard on an entity's REST controller does not extend to it.
   `{ graphql: { guards: [GraphQLAuthGuard] } }` puts guards on it with
   `@UseGuards` (a denial stops the request before any resolver runs, `403` when the guard returns `false`). Guards must stay singleton-scoped. A guard
   class's own dependencies must come from a global module or from
   `forRootAsync({ imports })`. Either way `context.app` is `{}` over
   GraphQL, so per-caller `policy`/`filter.apply` rules see no caller.

`graphql` is an **optional peer** of `@kavo/nest` — it's lazy-loaded
(`loadGraphQL()`, dynamic `import()`) so an app that never touches GraphQL
never needs it installed, and `import { Kavo } from "@kavo/nest"` never
crashes on a missing `graphql` package regardless of whether `KavoModule`'s
`graphql` option is set.

## Out of scope today (real follow-up work, not oversights)

- Schema derivation from `EntityMetadata` — `itemType`/`createInputType`/etc.
  are hand-written per entity.
- Registry-driven mutation exposure (§ above) — no cross-check against
  `OperationRegistry`.
- Relations/includes as GraphQL fields — only scalar `itemType` fields
  exist; a relation needs a hand-added field + resolver.
- A typed `<Entity>FilterInput` per entity instead of the raw-AST `JSON`
  scalar.
- Bulk operations and subscriptions.
