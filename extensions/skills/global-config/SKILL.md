---
name: global-config
description: Reference for Kavo's global configuration — the KavoSettings precedence chain, built-in defaults table, KavoModule.forRoot/forRootAsync options, and the operations.<id> global-default caveat (ADR-0015). Use when wiring createKavo/KavoModule.forRoot, setting app-wide defaults, or answering "what can I configure globally" questions.
---

# Global config reference

Kavo has **one** configuration mechanism, `KavoSettings`, merged through a
single precedence chain (`docs/internals/architecture/08-configuration.md`):

```
built-in defaults → global (createKavo / KavoModule.forRoot) → entity (createCrud / @Kavo)
                  → operation (operations.<id>) → per-call (KavoCallOptions)
```

Global scope is the app's one place to state a default once instead of
repeating it on every entity. Nearer scopes override farther ones key by key
(scalars/objects replace; arrays replace wholesale; `undefined` is skipped;
`false` disables an inheritable feature and a nearer object re-enables it).

## Wiring it in a Nest app

```ts
KavoModule.forRootAsync({
  imports: [DatabaseModule.forRoot()],
  inject: [DATA_SOURCE],
  provideServices: true, // needed only if some class constructor-injects a CRUD service token
  useFactory: (dataSource: DataSource) => ({
    infrastructure: createInfrastructure(dataSource),
    defaults: {
      pagination: { defaultLimit: 20, maxLimit: 100 },
      errors: { exposeInternals: false },
      operations: { restoreOne: false }, // app-wide default; an entity can opt back in
    },
  }),
});
```

`KavoModuleOptions` (`packages/frameworks/nest/src/kavo-options.ts`):

```ts
interface KavoModuleOptions {
  infrastructure?: KavoInfrastructure; // e.g. createInfrastructure(dataSource)
  defaults?: DeepPartial<KavoSettings>; // passed through untouched to createKavo
  paginationStrategies?: readonly PaginationStrategy[];
}
```

`forRoot(options)` takes the object directly; `forRootAsync(options)` resolves
it via `useFactory`/`inject` (needed to wait for a `DataSource`, etc.). Both
also accept `{ provideServices: true }`, which additionally provides
`getKavoServiceToken(Entity)` for every `@Kavo` class seen so far — only
needed when some class constructor-injects its own service; a `@Kavo` class
itself should use `boundKavoService(this)` instead. In plain core (no Nest),
the same object is `createKavo(options).createCrud(Entity, config?)`.

## Built-in defaults (`BUILT_IN_DEFAULTS`, `core/src/config/defaults.ts`)

| Key                                              | Default                  | Notes                                                                  |
| ------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------- |
| `pagination.defaultLimit` / `maxLimit`           | 20 / 100                 | `defaultLimit ≤ maxLimit` enforced                                     |
| `pagination.strategy`                            | `"offset"`               | `"page"` built in; custom via `paginationStrategies`                   |
| `pagination.count`                               | `true`                   | `false` skips the count query; envelope reports `total: null`          |
| `query.maxFilterDepth` / `maxInValues`           | 3 / 100                  |                                                                        |
| `errors.exposeInternals`                         | `false`                  | leak driver detail into responses                                      |
| `relations.maxIncludeDepth` / `maxIncludedNodes` | 2 / 10                   | include depth budget and total node cap                                |
| `relations.edges.<name>`                         | `{}`                     | per-relation `includable` / `defaultInclude` / `maxDepth` / `strategy` |
| `softDelete.field` / `strategy`                  | `"deletedAt"` / `"auto"` | `auto` = soft when the entity has the marker field; `false` disables   |
| `operations.<id>`                                | `{}` (unset)             | global operation-enablement default (issue #38); see caveat below      |
| `bulk.mode` / `maxBatchSize`                     | `"atomic"` / 500         | reserved (bulk is not built)                                           |

Setting any of these under `defaults` in `createKavo`/`KavoModule.forRoot`
applies it app-wide; an entity's own `@Kavo(Entity, config)` (or
`operations.<id>` on it) still wins over the global value.

## `operations.<id>` global default — the one caveat (ADR-0015)

At global scope, `operations` is a plain boolean map
(`Partial<Record<StandardOperationId, boolean>>`) and merges like any other
key. But **route generation in `@kavo/nest` never sees it**: `@Kavo` builds
routes at class-decoration time, which always runs _before_
`KavoModule.forRootAsync`'s factory resolves `defaults` — there is nothing to
read yet. So:

- A route an entity doesn't disable itself **still generates**, even under a
  global `operations.<id>: false`.
- The bound _service_ does see the global default (resolved through
  `createKavo`'s `createCrud` at `onModuleInit`), so calling that route
  answers `405 KAVO_OPERATION_DISABLED` — never a silent success, never a
  bare 404.
- An app that wants the route itself gone still has to say so per entity
  (`operations: { restoreOne: false }` in that entity's own `@Kavo` config).

This only affects `@kavo/nest`; plain `@kavo/core` callers going through
`kavo.createCrud(...)` see the global default applied directly, with no route
layer in between.

## Debugging a resolved config

`kavo.describe(entityName)` returns the frozen, fully-merged config for one
entity — settings, allowed, relations, and every per-operation view — as a
plain printable object. Useful for confirming what actually won the
precedence chain without re-deriving it by hand.

Full detail: `docs/internals/architecture/08-configuration.md`; the
`add-config-key` skill covers adding a _new_ key to this schema rather than
using the existing ones.
