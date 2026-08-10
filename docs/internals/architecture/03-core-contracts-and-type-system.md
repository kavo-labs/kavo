# 03 — Core Contracts & Type System

All contracts live in `packages/core/src` and are exported through the
explicit barrel. **Types only** — no classes, no implementations; runtime
code is layered in separately. Contracts whose implementations land later
(relations, transactions, bulk, operation control) are declared now so
later work never needs to mutate `@kavo/core` types.

## 1. Generic parameters

| Parameter    | Purpose                                                        | Default                                                                           | Override example                                               |
| ------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `TEntity`    | The ORM-mapped entity class everything is typed against        | — (always inferred from `createCrud(Entity)`)                                     | `KavoService<User>`                                            |
| `TId`        | Primary-key type; appears in `findOne(id)`, `deleteOne(id)`, … | `EntityId` (`string \| number`)                                                   | `KavoService<User, string>` for UUID keys                      |
| `TCreateDto` | `POST` request body                                            | `EntityInput<TEntity>` (the entity's scalar properties, all optional — see below) | `dto: { create: CreateUserDto }`                               |
| `TUpdateDto` | `PUT` full-replace body                                        | `EntityInput<TEntity>`                                                            | `dto: { update: UpdateUserDto }`                               |
| `TPatchDto`  | `PATCH` partial body                                           | `Partial<TUpdateDto>` — follows `update` when that is overridden                  | `dto: { patch: PatchUserDto }`                                 |
| `TQueryDto`  | `GET` list query shape                                         | `QueryContext<TEntity>`                                                           | `dto: { query: UserQueryDto }`                                 |
| `TItemDto`   | Any single-resource response                                   | `TEntity`                                                                         | `dto: { item: UserItemDto }`                                   |
| `TListDto`   | Element type inside `ListResultDto.items`                      | `TItemDto` (follows `item`)                                                       | `dto: { list: UserListDto }` — leaner list projection          |
| `TOps`       | The `operations` config's inferred literal type (issue #131)   | `OperationsConfig<...>` — no operation overrides anything                         | `operations: { findOne: { dto: { output: UserProfileDto } } }` |

`TOps` is unlike the rest of the table: it is not a DTO type itself, and no
one ever writes it by hand. It exists only so `KavoService`'s per-method
positions (`DtoInputOf<TOps, "createOne", TCreateDto>`, and the `output`/
`query` equivalents, doc 4 §8) can read back the literal DTO classes a
caller registered under `operations.<id>.dto`, falling back to the slot
generic above when that operation declares no override of its own — the
same "constrain, don't fix" shape `EntityConfig.allowlists.selectable`
already uses for `NoInfer<Computed>`.

It carries a second job since issue #145. `run`'s typed positions
(`CustomOperationId`/`CustomOperationBody`/`CustomOperationResult`,
`service/custom-operation.ts`) read the same literal for the operations
`TOps` declares that Kavo has no name for, taking their shapes from the
registered handler's own signature when no `dto` override narrows them.
Its constraint is `OperationsConfig` rather than `StandardOperationsConfig`
so that a key outside the standard eight is a permitted custom operation
rather than an excess property; the extra requirement that such a key carry
a `CustomOperationConfig` is intersected into `EntityConfig.operations`'
declared type (`CustomOperationsOf`) rather than folded into the
constraint, because a constraint that named `TOps` inside itself would stop
TypeScript keeping the caller's literal at all.

Design rule: **every parameter defaults from the ones before it**, so type
inference is a feature — a consumer rarely writes a generic argument by
hand. `createCrud(UserEntity)` yields a fully typed service with zero
manual arguments; registering a DTO class narrows exactly one slot and
everything downstream (envelope, service returns) follows.

The chain `TEntity → TUpdateDto → TPatchDto` and `TItemDto → TListDto`
mirrors the runtime DTO resolution rules (doc 4), so static defaults and
runtime derivation never disagree about _which slot follows which_.

### `EntityInput` — the write-shape default

`EntityInput<TEntity>` is `Partial<Pick<TEntity, ScalarKeys<TEntity>>>`:
the entity's **scalar** properties, **all optional**.

- **Relation-shaped properties and methods are excluded** (`ScalarKeys`).
  Excluding relations is not convenience — ADR-0014 makes association by
  id the only write path, so a relation _object_ — or an array of them, a
  to-many relation — is never a valid body. `Date` and other `Primitive`
  members are kept, and so is a primitive-element array (`tags: string[]`,
  a TypeORM `simple-array` column): it is a column, not a relation, and
  carries none of a to-many relation's ambiguity. A `json`/`jsonb` column
  (`Record<string, unknown>`) stays excluded — at the type level it is
  indistinguishable from a to-one relation, so admitting one would admit
  the other; a registered `create` DTO is the escape hatch for either.
- **Every key is optional** because only ORM metadata knows which columns
  are generated, defaulted or nullable, and the type system cannot see it.
  Requiring every key made the zero-config write path unusable:
  `createCrud(User).createOne({ name })` demanded `id` and every relation.
- The looseness is the _static_ default only. The runtime derivation
  (doc 4) still drops generated columns, and registering a `create` DTO
  restores full strictness — which is what a configured setup does.

The generic parameters are also inferred by `@Kavo(Entity, config)`, whose
chain mirrors this one exactly. Until then its config was typed
`EntityConfig<object>`, so nothing inside a controller's config was
checked against its entity.

## 2. `FieldPath` implementation notes

`FieldPath<TEntity, TMaxDepth = 3>` (`types/field-path.ts`) produces the
union of dot-paths into an entity — `'name' | 'profile.city' |
'posts.comments.text'` — used by filter, sort, and selection typings so
relation paths are spell-checked at compile time.

- **Recursion cap:** default depth 3, hard maximum 5 (`FieldPathDepth`),
  decremented through a tuple table (`Prev`). The cap exists because the
  union grows combinatorially with depth — entities with many relations
  would otherwise produce unions large enough to slow or crash the
  compiler (ADR-0008).
- **`any` / `unknown`:** degrade to `string` (detected via the `0 extends
1 & T` probe) — untyped entities get no spell-checking but stay usable;
  the runtime allowlist remains the actual gate.
- **Index signatures:** `string extends keyof T` → degrade to `string`;
  keys are unknowable.
- **Methods** are excluded (`Function`-valued properties map to `never`).
- **Arrays** traverse through their element type: a path into a to-many
  relation (`posts.comments`) reads identically to a to-one.
- **`Date`, `bigint`, primitives** are leaves — no recursion into their
  methods.
- `FieldPath` is a _typing aid_, not a security boundary: the runtime
  allowlists (doc 5) decide what a request may actually do.

### `IncludePath` — the relation-only sibling

`IncludePath<TEntity, TMaxDepth = 3>` (`types/include-path.ts`) types
`QueryContext.include`, so `include: ['posts.commentz']` is a compile
error rather than a runtime 400.

It reuses `FieldPath`'s `Prev` counter, cap, and every degradation rule
above — ADR-0008's cap is one policy, not a pattern each path type
re-implements. The single difference: **scalars map to `never`**, because
`include` addresses relations and `'name'` being rejected is the point.
With `QueryContext`'s default `Entity = unknown` it degrades to `string`,
so untyped callers keep the previous `readonly string[]` contract.

The runtime gates are unchanged and still authoritative: the relation
registry's `includable` flag and the include-depth budget.

### `FieldSelectionInput` — three spellings, one normalized form

`QueryContext.fields` accepts three shapes, all collapsing in
`QueryNormalizer.normalizeInput`:

| Spelling                                       | Mirrors             |
| ---------------------------------------------- | ------------------- |
| `['id', 'name']`                               | `?fields=id,name`   |
| `{ root: [...], relations: { posts: [...] } }` | the structured form |
| `{ posts: ['id', 'title'] }`                   | `?fields[posts]=…`  |

`root` and `relations` are therefore **reserved keys**: a relation
genuinely named `root` or `relations` must use the structured form. This is
enforced at both levels. At the type level, the third (relation-keyed)
member of the union excludes `root`/`relations` (`& { root?: never;
relations?: never }`) — without that exclusion it structurally satisfies
`Partial<FieldSelection<Entity>>` too, which silently defeats the
structured form's own spell-checking (`{ root: ['nope'] }` would typecheck).
At runtime, `QueryNormalizer`'s collapse step rejects — rather than
silently drops — any relation-keyed key mixed into a structured literal, so
a caller who blends the two spellings gets a `KAVO_QUERY_INVALID_VALUE`
issue naming the stray key, not a quietly ignored fieldset. A malformed
`fields` value (not an array, not an object) is also an issue, never a
thrown error. The same guarantee holds one level down: a per-relation
fieldset value that is not an array (reachable only by a programmatic
caller bypassing `FieldSelectionInput`'s type, never through the wire path,
which always produces an array of strings) is rejected by
`DefaultIncludeResolver.fieldsFor` the same way, rather than reaching the
loop that walks it. A malformed shape anywhere in this parameter has no
later gate to catch it, so each level guards itself.

The normalized `FieldSelection` is deliberately _not_ widened — adapters
and the engine still see exactly one shape, and all three spellings face
the same allowlist validation.

## 3. Module augmentation of `OperationMetadata`

`OperationMetadata` is an intentionally empty interface on every
operation registry entry. Core stores it, merges it per the configuration
precedence chain (doc 8), and hands it to the framework layer — it never
reads it. A consumer types its keys via declaration merging; `@kavo/nest`
declares a `routes` key:

```ts
// packages/frameworks/nest/src/operation-metadata.ts
declare module "@kavo/core" {
  interface OperationMetadata {
    routes?: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path?: string;
      /** `false` = service-only operation: callable in code, no route. */
      enabled?: boolean;
      /** Success status override (defaults: 201 create, 204 delete, 200 else). */
      successStatus?: number;
    };
  }
}
```

With that augmentation in a consumer's compilation, this type-checks
end-to-end while core remains route-ignorant:

```ts
createCrud(UserEntity, {
  operations: {
    findMany: { meta: { routes: { path: "search" } } },
  },
});
```

This pattern requires a stable augmentation target — one reason the barrel
is an explicit named list (ADR-0010) and the `exports` map exposes exactly
one module id, `@kavo/core`.

## 4. Why zero runtime dependencies (ADR-0005)

`@kavo/core` is imported by every Kavo package and every consumer app.
Any dependency it carried would be forced on all of them — version
conflicts, install weight, supply-chain surface — and utility libraries in
particular tend to leak types into public signatures, making third-party
types part of Kavo's API contract. Framework/ORM independence is the same
rule at its extreme: core not importing TypeORM or NestJS (directly or
transitively) is what makes the adapter seam real rather than aspirational.
Enforced by dependency-cruiser (`core-imports-nothing`), not convention —
and type-only edges are inside the rule, not exempt from it. A type reached
for from outside is a contract core does not own (ADR-0001) whether or not it
survives compilation, and "utility libraries leak types into public
signatures" is precisely the failure an exemption would have allowed.

## 5. Contract inventory

| Area          | Contracts                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service       | `KavoService`, `KavoCallOptions`, `IdentifiedInput`                                                                                                                                                                                  |
| Persistence   | `EntityReader`, `EntityWriter`, `RepositoryAdapter`                                                                                                                                                                                  |
| Transactions  | `TransactionManager`, `TransactionContext`, `TransactionOptions` — not implemented, see below                                                                                                                                        |
| Query         | `Filter*`, `FilterExpression`, `Sort`, `Pagination`, `OffsetPagination`, `CursorPagination`, `isCursorPagination`, `PaginationStrategy`, `FieldSelection`, `QueryContext`, `NormalizedQueryContext`, `FilterParser`, `FilterBuilder` |
| DTO           | `Dto`, `DtoClass`, `OperationDtoMap`, `DtoResolver`, `ListResultDto`, `ListMetaDto`, `BulkResultDto` (bulk reserved)                                                                                                                 |
| Errors        | `KavoExceptionShape`, `KavoErrorCode`, `ErrorHandler`, `ProblemDetailsDto`                                                                                                                                                           |
| Config        | `KavoSettings` (+ per-area settings), `GlobalConfig`, `EntityConfig`, `OperationConfig`, `ResolvedEntityConfig`                                                                                                                      |
| Operations    | `OperationId`, `OperationHandler`, `OperationMetadata`, `OperationDescriptor`, `OperationRegistry`                                                                                                                                   |
| Relations     | `RelationDescriptor`, `RelationRegistry`, `IncludeTree`, `IncludeNode`, `IncludeResolver`, `EntityCatalog`                                                                                                                           |
| Context       | `KavoContext`, `KavoContextState`, `StateKey`, `KavoRequest`, `KavoResponse`                                                                                                                                                         |
| Serialization | `Serializer`, `Deserializer`                                                                                                                                                                                                         |

`TransactionManager` / `TransactionOptions` / `TransactionPropagation` are
declared but **intentionally unimplemented**, and no adapter provides them.
This build has no transaction support: the only consumer of multi-write
atomicity is bulk `atomic` mode, whose binder is the adapter-level
`runInTransaction` hook, and bulk was dropped from this build. They stay
because this doc fixes core's type system once and later work never mutates
it — the `@remarks` at `core/src/persistence/transaction-manager.ts` is the
definition-site record.
`TransactionContext` is the exception: it is live, threaded through
`KavoContext` and `KavoCallOptions` as an opaque adapter handle.

`Pagination` is a **union**, `OffsetPagination | CursorPagination<Entity>`,
not a single scalar shape (ADR-0021). The discriminant is the _presence of
`cursor`_, exposed as the guard `isCursorPagination`, rather than a `kind`
tag — that keeps `OffsetPagination` structurally identical to the
pre-union shape, so every existing producer (including a third-party
`PaginationStrategy`) stays assignable untouched. `CursorPagination` is
`{ limit, cursor, keyset }` and deliberately carries **no** `offset`: a
keyset page has no absolute position in the match set, and a `0` there
would hand every adapter a number that means nothing and that a future
reader would reasonably `skip()` by. A consumer that reads `.offset` —
an adapter, a custom `EntityReader`, a test fixture — must narrow with
`isCursorPagination` first.
