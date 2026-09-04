---
name: kavo-decorator
description: Reference for what @Kavo(Entity, config?) generates and how to configure/override it — routes table, EntityConfig shape (dto/allowed/operations), manual-method-wins, @Override, and fully custom routes. Use when writing or reviewing a @Kavo-decorated controller, or answering "how do I configure/override this route" questions.
---

# `@Kavo()` reference

`@Kavo(Entity, config?)` (`packages/frameworks/nest/src/kavo.decorator.ts`) is a
class decorator that builds the entity's operation registry at
class-decoration time and generates one Nest route per **enabled** entry:

```ts
@Kavo(UserEntity)
@Controller("users")
export class UserController {}
```

The bound `DefaultKavoService<Entity>` arrives later, via property injection
at `onModuleInit` (`KavoBinder`) — not through the constructor. Reach it
with `boundKavoService(this)`, never constructor injection, inside a
`@Kavo`-decorated class.

Full detail: `docs/internals/architecture/10-nestjs-integration.md`.

## Generated routes

| Operation    | Route                | Status |
| ------------ | -------------------- | ------ |
| `createOne`  | `POST /`             | 201    |
| `findMany`   | `GET /`              | 200    |
| `findOne`    | `GET /:id`           | 200    |
| `updateOne`  | `PUT /:id`           | 200    |
| `patchOne`   | `PATCH /:id`         | 200    |
| `deleteOne`  | `DELETE /:id`        | 204    |
| `restoreOne` | `PATCH /:id/restore` | 200    |
| `purgeOne`   | `DELETE /:id/purge`  | 204    |

`restoreOne`/`purgeOne` are off by default and turned on by config
(`softDelete: { strategy: "soft" }` enables restore; `operations: { purgeOne: true }`
enables purge) — decoration time has no ORM metadata to auto-detect them from.

## `config` — the second argument (`EntityConfig<Entity>`)

```ts
interface EntityConfig<Entity, CreateDto, UpdateDto, PatchDto, QueryDto, ItemDto, ListDto>
  extends Omit<DeepPartial<KavoSettings>, "operations"> {
  dto?: OperationDtoMap<...>;          // per-slot DTO overrides: create/update/patch/query/item/list
  allowed?: QueryAllowed<Entity>; // filterable/sortable/selectable field allowlists
  operations?: Partial<Record<StandardOperationId, OperationConfig<Entity> | boolean>>;
}
```

- **`dto`** — override any of the bare-verb DTO slots (`create`, `update`,
  `patch`, `query`, `item`, `list`). Omitted slots derive from the entity.
- **`allowed`** — see below.
- **`operations.<id>`** — `false` disables the operation (no route, no
  service method reachable); `true` enables one that is off by default
  (`purgeOne`, `restoreOne`). The long form,
  `{ enabled?, handler?, meta? }`, additionally lets you swap the
  `OperationHandler` or supply route `meta` (`method`, `path`, `successStatus`,
  or `enabled: false` to keep it service-only).
- **Settings keys** (`pagination`, `limits`, `search`, `errors`, `relations`, `softDelete`,
  `bulk`) inherited from `DeepPartial<KavoSettings>` override the global
  default for this entity only — see the `global-config` skill for the
  precedence chain these merge through, and the sections below for what
  `relations` configures.

## `allowed` — `filterable` / `sortable` / `selectable`

Security allowlists: what a request may filter, sort, and select on,
**including relation paths**. Anything outside the allowlist is a 400
(`QueryValidationException`), never silently dropped — programmatic callers
(`findMany({ filter })`) go through the same checks as HTTP, so typed input
skips coercion, not security.

```ts
@Kavo(User, {
  allowed: {
    filterable: ["email", "status", "profile.city"],
    sortable: ["createdAt", "email"],
    selectable: { exclude: ["passwordHash"] },
  },
})
```

- Each of the three keys accepts either an explicit array of field paths, or
  `{ exclude: [...] }` — resolved at bootstrap to every own scalar column
  except the ones named, so hiding one sensitive column doesn't require
  re-listing every other one. Both forms are fail-closed: `exclude`
  resolution still starts from the entity's own columns, relation paths are
  **never** allowlisted implicitly.
- Omitted allowlists default to the entity's own scalar columns (derived
  from the `query` DTO or entity metadata at bootstrap) — relation paths
  need an explicit `filterable`/`sortable` entry naming the dot-path
  (`profile.city`), or `include`'s own `allowed.selectable` on the
  _target_ entity for `fields[<path>]`.
- Relation-path **filters** restrict root rows via a non-selecting join —
  they never load or filter the included collection itself.
- Full request-side grammar (operators, sort syntax, pagination, fieldsets,
  JSON filter escape hatch, security/coercion rules) is in the
  `query-grammar` skill.

## `relations` — nested includes (`GET /owners?include=pets`)

Inclusion is its own allowlist, resolved per-edge under `relations.edges`:

```ts
@Kavo(Owner, {
  relations: {
    edges: {
      pets: { includable: true },
      address: { includable: true, strategy: "join" },
    },
  },
  limits: {
    includeDepth: 3,   // default 2 — budget spent per level
    includedNodes: 20, // default 10 — cap across the whole include tree
  },
})
```

Per-edge options (`relations.edges.<name>`), each defaulting from the table
below if omitted:

| Key              | Default                        | Meaning                                                                                                                                    |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `includable`     | `false`                        | naming the edge at all is what opts it in; omitted = not includable                                                                        |
| `defaultInclude` | `false`                        | `true` includes it even without an explicit `include=` param                                                                               |
| `maxDepth`       | inherits `limits.includeDepth` | replaces the depth budget for this edge's own subtree                                                                                      |
| `strategy`       | `"auto"`                       | `"join"` (`leftJoinAndSelect`) or `"batch"` (one query per level, stitched in memory); `auto` picks `join` for to-one, `batch` for to-many |

- An edge name that doesn't exist on the entity is a bootstrap
  `ConfigurationException` — a typo can't silently permit nothing.
- Force `strategy: "join"` on a to-many edge to fold it into a detail
  route's main query (single round trip); leave a **list** route on `auto`
  so a paginated query keeps batching instead of multiplying joined rows.
  Since `strategy` is entity-wide, a detail route and a list route over the
  same relation need two separate `createCrud`/`@Kavo` registrations if they
  want different strategies (see `blogs`/`joinedBlogs` in
  `packages/orms/typeorm/tests/includes.spec.ts`).
- Nested levels read the **target** entity's own resolved allowlists/DTOs —
  a relation never widens what its target exposes on its own.
- `fields[<relation path>]=id,name` narrows an included node, validated
  against the target entity's `selectable` allowlist.

Full detail (cycle guard, pagination-correctness guarantee, soft-delete
interplay, write semantics for relations): `docs/internals/architecture/12-relations-and-includes.md`.
The wire-side `include=`/`fields[<relation>]=` grammar is in the
`query-grammar` skill.

## Overriding one operation's behavior

Three escalating options, from least to most custom:

1. **Config-level `operations.<id>.handler`** — replace only the handler,
   keep the generated route/DTO/serialization scaffolding.
2. **`@Override(operationId?)`** — decorate a method to back the operation
   with hand-written code while keeping the registry's route, param wiring,
   and Swagger metadata identical to a generated route. `operationId`
   defaults to the method's own name. Fixed parameter shape: reads take
   `(id?, query)`, writes take `(id?, body)`, and the method must not declare
   its own `@Param`/`@Query`/`@Body` — `@Kavo` fails fast at decoration time
   if it does.

   ```ts
   @Override()
   async findOne(id: EntityId, query: WireQuery) {
     return this.base.findOne(id, query);
   }
   ```

   A read override's `query` arrives pre-wrapped in `WireQuery` — don't call
   `flattenQuery`/`WireQuery` yourself.

3. **Manual-method-wins** — a hand-written method whose name matches an
   operation id (no `@Override`) suppresses the generated route entirely,
   detected via `hasOwnProperty` on the prototype. No config needed, but you
   own all param wiring and Swagger metadata yourself.

Resolution order in the `@Kavo` loop: override map → manual-method-wins →
generate. A decorated method never falls through to plain name-matching.

## Fully custom, registry-independent routes

For an action with no operation identity of its own, skip `@Kavo` machinery
entirely — write an ordinary Nest method with its own `@Get`/`@Post`/etc. and its own
`@Param`/`@Query`/`@Body` on the same class. `@Kavo` never inspects it (name
matches neither the registry nor an `@Override`). Reach the bound service the
same way:

```ts
@Controller("users")
@Kavo(User)
export class UserController {
  private get base(): DefaultKavoService<User> {
    return boundKavoService<User>(this);
  }

  @Get(":id/summary")
  async summary(@Param("id") id: string) {
    const user = await this.base.findOne(id as never);
    return { headline: `${user.name} <${user.email}>` };
  }
}
```

See `examples/nest-typeorm/src/address/address.controller.ts` for a worked
example (`validatePostalCode`).

**Rule of thumb:** reach for `@Override` when the action _is_ one of the
standard operations and should keep its generated route/Swagger/param
metadata; declare a **custom operation** (an `operations` key outside the
standard eight, with its own `handler` and `meta.routes`) when the action has
an operation identity of its own and wants that same generated machinery —
its handler reads and writes through `context.repository`, so it needs
nothing in scope where it is declared; reach for a plain native-decorated
method for anything else.
