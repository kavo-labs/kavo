---
name: add-operation
description: The end-to-end procedure for adding, overriding, or disabling a Kavo operation — registry entry, DTO slots, handler, route metadata, and tests. Use when a change introduces a new CRUD operation or a custom per-entity operation.
---

# Adding an operation

The whole point of Kavo's design is that **adding an operation is adding a
registry entry** (ADR-0006). The engine loops over registry entries and
`@kavo/nest` generates one route per enabled entry from the same registry. If
your change needs a new `if` in the engine or in the route generator, the design
is wrong — stop and reconsider.

## Decide which of the four you are doing

The first three are the same mechanism (`EntityConfig` in
`packages/core/src/config/entity-config.ts`); the fourth is `@kavo/nest`-only
and doesn't touch `EntityConfig` at all:

| Intent                                   | How                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Disable** a standard operation         | `operations: { deleteOne: false }` — the entry stays in the registry so tooling can report it, but calling it raises `OperationDisabledException` and no route is generated.                                                 |
| **Override** a standard operation (data) | `operations: { findOne: { handler } }` — a plain `OperationHandler` object replaces the handler; keeps the default DTO and serialization scaffolding.                                                                        |
| **Add a custom** operation               | `operations: { markPaidOne: { handler, meta: { routes } } }` (issue #145): any key outside the standard eight. `handler` is required; `kind`/`cardinality` default to a single-row write; `dto` gives it a shape of its own. |
| **Override** a standard operation (code) | `@Override(operationId?)` (issue #23) — a controller method is the implementation; `@Kavo` still generates the route from the registry. See below.                                                                           |

Standard operations that are off by default (`purgeOne`, `restoreOne`) are
turned on with `operations: { purgeOne: true }`.

## `@Override`: a controller method instead of a handler object

`operations.<id>.handler` and `@Override` both replace a standard
operation's behavior; they differ in _where_ the replacement lives and what
it can reach:

- `operations.<id>.handler` is a plain `OperationHandler` object — no `this`,
  no DI, just `execute(input, context)`. Use it when the override is pure
  logic against the adapter/context Kavo already hands you.
- `@Override` is a real controller method, decorated so `@Kavo` still emits
  that operation's route (method, path, status, params, Swagger) — only the
  function backing the route changes. Use it when the override needs
  constructor-injected dependencies (most commonly the entity's own
  `DefaultKavoService`, via `getKavoServiceToken`, to delegate to default
  behavior — `this.base.createOne(dto)`), or reads more naturally as a method
  than a config value.

```ts
@Kavo(Address)
@Controller("addresses")
class AddressController {
  constructor(@Inject(getKavoServiceToken(Address)) private readonly base: DefaultKavoService<Address>) {}

  @Override()
  async createOne(dto: CreateAddressDto): Promise<AddressItemDto> {
    return this.base.createOne({ ...dto, postalCode: normalize(dto.postalCode) });
  }
}
```

Constraints, because `@Kavo` still owns the route:

- `operationId` defaults to the method's own name (same inference
  manual-method-wins uses); pass it explicitly when the method name differs.
- The method's parameters must be in the same fixed position a generated
  route would use — reads: `(id?, query, preconditions)`; writes:
  `(id?, body?, preconditions)`, declaring only as many as the method
  actually uses — and must **not** carry their own `@Param`/`@Query`/`@Body`.
  `@Kavo` applies those itself; a method that also declares its own throws at
  decoration time.
- **An override enforces no `If-Match` by itself.** The check lives in the
  engine, so a method that replaces the handler must pass the trailing
  `preconditions` on (`this.base.updateOne(id, data, { preconditions })`)
  for the guard to still apply (ADR-0020).
- Overriding an operation that's absent, disabled, or service-only
  (`meta.routes.enabled: false`) throws at decoration time too — there is no
  route for `@Override` to attach to.
- Distinct from plain manual-method-wins (an _undecorated_ method whose name
  happens to match an operation id): that suppresses the route entirely, with
  none of `@Kavo`'s wiring applied. `@Override` keeps all of it.
- **A read override's `query` is Nest's raw `@Query()` object, not
  normalized.** A generated route always wraps it — `new
WireQuery(flattenQuery(query))` (`WireQuery` from `@kavo/core`,
  `flattenQuery` from `@kavo/nest`) — before it reaches
  `DefaultKavoService`. Skip that and wire-format params (`?fields=`,
  `?include=`) reach the engine unparsed and 400.

## The descriptor

Every entry is an `OperationDescriptor`
(`packages/core/src/operations/operation-registry.ts`):

- `id` — camelCase, **always naming cardinality**: `<verb>One` / `<verb>Many`.
  "Bulk" is a feature term, never a method prefix.
- `kind` — `"read" | "write"`. This drives lifecycle branching: reads run query
  resolution, writes do not.
- `cardinality` — `"one" | "many"`, matching the id.
- `enabled` — disabled entries stay registered but never execute.
- `handler` — an `OperationHandler`: `execute(input, context)`. One contract for
  built-in, overridden and custom operations alike.
- `input` / `output` — explicit DTO classes, or `null` to take the slot default.
- `meta` — the opaque, module-augmentable metadata bag.

## Route metadata

Core knows nothing about HTTP. Routes are expressed through `meta`, which
`@kavo/nest` augments:

```ts
meta: {
  routes: { method: "POST", path: ":id/complete", enabled: true },
}
```

- A custom operation with no `meta.routes` falls back to `POST /<operation id>`;
  give it one whenever the route should read like anything else.
- Custom entries are registered, and so routed, **ahead** of the standard
  table, so a custom `GET /orders/pending` is not swallowed by `GET /orders/:id`.
- `meta.routes.enabled: false` keeps an operation service-only — callable in
  code (`service.run(id, …)`), no HTTP route.
- Routes are generated at **decoration time** (ADR-0012), the only moment Nest's
  router scan sees the methods. Nothing may defer registration.
- **Manual-method-wins**: a hand-written controller method whose name matches an
  operation id suppresses the generated route.
- **`@Override`**: the same route still generates, backed by the decorated
  method instead — see above.

## Naming (normative — get this right the first time)

- Operation ids: `<verb>One` / `<verb>Many`, camelCase. Config keys under
  `operations` use the same names.
- DTO slots are bare verbs — `create`, `update`, `patch`, `query`, `item`,
  `list` — because `createOne` and `createMany` share the `create` DTO.
- DTO classes: request bodies `<Verb><Entity>Dto`; query/response shapes
  `<Entity><Slot>Dto`. Every wire-crossing shape carries `Dto`; behavioral
  contracts never do.
- New exceptions are `*Exception` with a stable `KAVO_SNAKE_CASE` code.

## Where the work lands

1. **`packages/core`** — the descriptor and its handler. If it is a new standard
   operation, add the id to `StandardOperationId`
   (`packages/core/src/operations/operation.ts`) and a default entry in
   `default-operation-registry.ts`; add a handler in `engine/built-in-handlers.ts`.
2. **The barrel** — `packages/core/src/index.ts` is an explicit named list
   (ADR-0010). Export new public types there deliberately; nothing leaks in by
   `export *`.
3. **`packages/orms/typeorm`** — only if the operation needs new adapter
   capability. Keep every TypeORM type inside this package; core takes
   adapter-owned values as `unknown` behind a named contract.
4. **`packages/frameworks/nest`** — usually **nothing**. Route generation reads
   the registry, so a new enabled entry with `meta.routes` becomes a route with
   no generator changes. Touching the generator is a signal you special-cased.

## Tests

Follow the `write-tests` skill, and cover at minimum:

- the operation executes and returns the right shape;
- disabled → `OperationDisabledException` with its code;
- the registry reports the entry via `all()` whether enabled or not;
- the generated route exists with the expected method and path, and is absent
  when disabled or `meta.routes.enabled: false`;
- manual-method-wins suppression, if a controller method could collide;
- for `@Override`: the route/param/Swagger shape matches what generation would
  produce, and the decoration-time errors (duplicate target, absent/disabled/
  service-only target, a method with its own `@Param`/`@Body`) all fire.

Finish with `pnpm check`.
