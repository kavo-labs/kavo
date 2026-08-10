# 13 — GraphQL Binding

`@kavo/graphql` (`packages/protocols/graphql`) builds a `GraphQLSchema`
over an existing `createCrud` service. Every resolver is a direct call
into the same `DefaultKavoService`/engine pipeline REST binds to — there
is no parallel request path, no second copy of filter/sort/pagination
validation, and no separate error handling. `@kavo/nest` (`packages/frameworks/nest`)
depends on `@kavo/graphql` to provide a ready-made Nest controller; the
package topology and the one-directional dependency this implies are
ADR-0016's subject — this doc covers what the binding actually does.

## 1. Package boundary

`@kavo/graphql` is host-framework-agnostic: it imports `@kavo/core` and
the `graphql` peer only, never `@kavo/nest` or any other framework
package (`protocol-bindings-only-import-core` in `.dependency-cruiser.cjs`). It has
no idea Nest, Express, or any other host exists. This is what makes its
discovery helper (§4) reusable by a future host binding with zero changes
to `@kavo/graphql` itself.

## 2. Building one entity's schema

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

Every field this produces:

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

Each mutation is opt-in per entity — omit the option and the field never
reaches the schema. This does **not** read the entity's `OperationRegistry`
to check what REST actually has enabled: setting `restoreOne: true` here
for an entity whose `@Kavo` config disables `restoreOne` still puts the
field in the schema, and it throws `OperationDisabledException` at resolve
time, the same way calling the REST route would. Keeping the two in sync
is the caller's job today — reading the registry directly is real,
scoped follow-up work (tracked as a GraphQL issue), not implemented here.

**Filter and sort** (`Query.<entity>s` args, always present):

- `sort: [String!]` — REST's own `-field` convention (`["-createdAt",
"name"]`), translated into `Sort[]` objects locally; this binding calls
  the programmatic `QueryContext` surface, which takes `Sort[]` directly,
  never REST's wire-string form.
- `filter: JSON` — a custom scalar (`GraphQLJSON`, built on graphql-js's
  own `valueFromASTUntyped`) carrying Kavo's raw filter AST directly:
  `{ kind: "condition", field, operator, value }` for a leaf, or `{ kind:
"group", operator: "AND"|"OR"|"NOT", children: [...] }` to combine.
  Operators are the AST's own `SCREAMING_SNAKE` spelling (`EQ`, `GTE`,
  `IN`, ...), not REST's camelCase wire tokens (`eq`, `gte`, `in`). This is
  the pragmatic version: a generated `<Entity>FilterInput` type per entity
  (real introspection, no raw AST in the schema) is schema-derivation work,
  scoped out for the same reason `itemType`/`createInputType` are still
  hand-written rather than derived from `EntityMetadata`.

## 3. Multiple entities on one schema

```ts
import { mergeKavoGraphQLSchemas } from "@kavo/graphql";

const schema = mergeKavoGraphQLSchemas([
  { name: "Owner", service: ownerService, itemType: OwnerType, createInputType: CreateOwnerInput },
  { name: "Cat", service: catService, itemType: CatType, createInputType: CreateCatInput },
]);
```

Field names are namespaced by each entity's own `name`, so entries never
collide. `mergeKavoGraphQLSchemas` throws `ConfigurationException` if the
result would have zero `Query` fields (an empty binding list) — an empty
`Query` type is invalid GraphQL, and graphql-js would otherwise only
report that on the first request, deep inside `graphql()`'s own schema
validation; this fails at schema-build time instead, with a message that
names the actual fix.

## 4. Registering types once, discovering everywhere

Hand-listing every entity at the call site (as in §3) works, but doesn't
scale past a couple of entities and needs updating every time one is
added. `registerKavoGraphQLTypes`/`getKavoGraphQLTypes` is a small,
process-wide registry — the GraphQL counterpart of `@kavo/nest`'s `@Kavo`
registry — so an entity declares its GraphQL types once, next to its
DTOs:

```ts
// owner.graphql-types.ts
registerKavoGraphQLTypes(Owner, { itemType: OwnerType, createInputType: CreateOwnerInput });
```

`resolveKavoGraphQLSchema` (`discovery.ts`) is the host-agnostic pipeline
that ties this together: given a list of `{ entity }` refs and a
`resolveService(entity)` callback, it looks up each entity's registered
types, skips any entity with none (opt-in, not implied by `@Kavo` alone),
and merges the rest. Two things are deliberately left to the caller,
supplied per host:

- **How to enumerate `@Kavo` entities** — `@kavo/nest`'s
  `getKavoEntities()`, a plain array a future Express/Fastify/Next.js app
  builds by hand, or any other host's own registry.
- **How to resolve one entity's bound service** — `@kavo/nest`'s
  `ModuleRef` + `getKavoServiceToken`, a plain `Map`, or whatever DI
  container that host uses.

This is what makes the exact same `resolveKavoGraphQLSchema` call work
from `@kavo/nest`'s `BaseKavoGraphQLController` today and from a future
host binding without either package importing the other (ADR-0016).

## 5. The Nest binding

`@kavo/nest` (`packages/frameworks/nest/src/graphql/`) supplies the two
Nest-specific pieces `resolveKavoGraphQLSchema` needs and nothing else:

- **`BaseKavoGraphQLController`** (abstract): `onModuleInit` calls
  `resolveKavoGraphQLSchema(getKavoEntities(), (entity) =>
this.moduleRef.get(getKavoServiceToken(entity), { strict: false }))`
  and stores the result; `execute(query, variables)` runs one operation
  against it. A concrete controller adds `@Controller`/`@Post` and calls
  `execute`:

  ```ts
  @Controller("graphql")
  export class GraphQLController extends BaseKavoGraphQLController {
    // Nest reads constructor-injection metadata off the concrete class,
    // not an inherited one — this constructor must be declared even
    // though it only forwards to `super`.
    constructor(moduleRef: ModuleRef) {
      super(moduleRef);
    }

    @Post()
    @HttpCode(200) // GraphQL-over-HTTP convention: 200 even for a mutation
    handle(@Body() body: { query: string; variables?: Record<string, unknown> }) {
      return this.execute(body.query, body.variables);
    }
  }
  ```

- **`createDefaultGraphQLController(path)`** + `KavoModule`'s `graphql`
  option: the zero-code path. `KavoModule.forRoot({ infrastructure,
graphql: true })` mounts `POST /graphql`; `{ graphql: { path: "api/graphql"
} }` mounts it there instead. Setting `graphql` implies `provideServices`
  (the merged schema's resolvers need every entity's service as a DI
  provider to look up via `ModuleRef`), even if `provideServices` itself is
  left unset. A concrete controller (previous bullet) and this flag are
  alternatives — pick one per app, never both at the same path.

  `createDefaultGraphQLController` builds a **fresh class per call**, with
  real `@Controller`/`@Post`/`@HttpCode` decorator syntax closing over
  `path` — not a shared singleton, and not decorators applied as plain
  function calls after the class body. Both alternatives matter:
  a shared singleton would make two independently-configured `KavoModule`
  calls in one process (two apps, or two test files sharing a module
  cache) fight over one `@Controller` path metadata; and TypeScript's
  `emitDecoratorMetadata` only emits `design:paramtypes` for a class it
  sees an actual `@decorator` applied to at compile time — calling the
  same decorator function afterward compiles fine but silently drops the
  constructor's `ModuleRef` injection.

## 6. Lazy-loading an optional protocol dependency

`graphql` is an _optional_ peer of `@kavo/nest` **and of `@kavo/graphql`
itself** (`peerDependenciesMeta.graphql.optional: true` on both) — an app
that never touches GraphQL shouldn't need it installed. Both hops matter:
`@kavo/nest` depends on `@kavo/graphql` outright, so npm resolves the
binding and then the binding's peer, and marking only the outer one left
`graphql` in every REST-only install (#148). That
guarantee only holds if nothing `@kavo/nest`'s always-loaded module graph
(`index.ts`, `kavo.module.ts`) reaches at import time ever statically
imports `@kavo/graphql` or `graphql`. A static top-level `import` is
resolved eagerly, so a single one anywhere in that graph — even several
files deep — makes `import { Kavo } from "@kavo/nest"` itself crash with
a raw `ERR_MODULE_NOT_FOUND` whenever `graphql` isn't installed, for
every app, whether or not it ever sets `KavoModule`'s `graphql` option.
This was a real bug in this package's first version, caught by asking
"what error shows if graphql isn't installed" rather than by a test —
`load-graphql.spec.ts`'s first test (`import("@kavo/nest")` must not
throw even when `@kavo/graphql` is mocked to explode) is what pins the
fix now.

`@kavo/nest/src/graphql/load-graphql.ts` is the fix, and the pattern to
copy for any future optional dependency (a future `@kavo/grpc` glue
package, or a second protocol binding for `@kavo/express`/`@kavo/fastify`):

- `loadGraphQL()` dynamically `import()`s the optional package(s) inside
  a function body — never a top-level `import` — caches the result
  (`null` on failure, so a second call doesn't retry), and throws a clear
  `ConfigurationException` on failure instead of leaking the raw
  module-resolution error.
- Only `import type { ... } from "graphql"` appears at the top of
  `base-kavo-graphql.controller.ts` — type-only imports are fully erased
  by `tsc` (`isolatedModules`/`verbatimModuleSyntax`, `tsconfig.base.json`),
  so they cost nothing at runtime and never require the package to be
  installed, only present at _compile_ time (always true for a workspace
  package like `@kavo/graphql`).
- `loadGraphQL()` is only ever called from code a consumer reaches by
  opting in — `BaseKavoGraphQLController.onModuleInit`/`execute` — never
  from `index.ts` or `kavo.module.ts` directly. Those two files only
  reference the _types_ and the plain functions/classes around GraphQL
  (`createDefaultGraphQLController`, `DEFAULT_GRAPHQL_PATH`), none of
  which themselves import `@kavo/graphql` or `graphql` at the top level.

One wrinkle worth remembering if a future binding copies this: `@kavo/nest`
already had exactly this problem solved once, for `@nestjs/swagger`
(`swagger.ts`'s `loadSwagger()`) — but that one uses a **synchronous**
`createRequire(...).require(...)`, because `@nestjs/swagger` ships as
CommonJS. `@kavo/graphql` is Kavo's own package, built as ESM
(`tsconfig.base.json`'s `"module": "Node16"` + `"type": "module"`), and
Node cannot `require()` an ES module synchronously — only a dynamic
`import()` (necessarily async) works for lazily loading an ESM package.
`BaseKavoGraphQLController.onModuleInit`/`execute` are `async` for
exactly this reason; a future binding lazily loading another first-party
ESM package should expect the same.

**The lazy path is `@kavo/nest`'s, not `@kavo/graphql`'s.** Now that
`graphql` is optional on `@kavo/graphql` too, installing that package alone
without `graphql` is a reachable state, and it does not get the friendly
`ConfigurationException`: `json-scalar.ts` and `schema.ts` import
`GraphQLScalarType`/`Kind`/`valueFromASTUntyped` as **values** at the top
level, so the first import throws a raw `ERR_MODULE_NOT_FOUND`. That is the
honest outcome — a package whose whole job is building a GraphQL schema
cannot run without `graphql`, and "optional" here means optional to
_install_, required to _use_. The friendly error exists on the `@kavo/nest`
path because that is the one where an app can plausibly have never asked for
GraphQL at all.

## 7. What's out of scope (by design, for now)

- Schema derivation from `EntityMetadata` — `itemType`/`createInputType`/etc.
  are hand-written per entity, the same status core's DTOs were before
  derivation existed for those.
- Registry-driven mutation exposure (§2) — this binding trusts the caller's
  `restoreOne: true`/etc. flags rather than cross-checking `OperationRegistry`.
- Relations/includes as GraphQL fields — only scalar `itemType` fields exist
  today; a relation would need to be hand-added to `itemType` with its own
  resolver.
- A typed `<Entity>FilterInput` per entity, instead of the raw-AST `JSON`
  scalar (§2).
- The list envelope's `meta` bag (doc 07 §3.1). The generated `<Entity>List`
  type declares `items`/`total`/`limit`/`offset` only, so what a `findMany`
  handler contributes to `meta` reaches REST and MCP but is invisible to a
  GraphQL client. Exposing it needs a decision the other fields did not: a
  `JSON` scalar (the open bag as-is, opaque to the schema) or a per-entity
  metadata type (typed, but a second thing to declare per entity).
- Bulk operations and subscriptions.

Each of these is real, valuable follow-up work, not an oversight — the
proof-of-concept status this package started at is still visible in what
it does _not_ attempt.
