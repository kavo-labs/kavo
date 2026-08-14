# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Kavo is

A production-grade CRUD framework for TypeScript: define an entity once (via TypeORM, Prisma, Mongoose, or MikroORM) and get the full REST CRUD surface — filtering, sorting, pagination, nested includes, field selection, optional per-operation DTOs, transactions, and problem-details errors — behind generated NestJS routes, configurable at global → entity → operation → per-call scope.

The authoritative sources are `docs/` (architecture notes and ADRs) and the **Conventions** section below, which is normative — naming deviations are review findings. Consult the governing ADR before changing behavior it covers, rather than inventing behavior.

## Commands

```bash
pnpm install
pnpm check        # the full gate: generate (Prisma client + fixture schema) + build + typecheck + depcruise + lint + test (run before considering work done)
pnpm build        # tsc -b (project references across the workspace — src only)
pnpm typecheck    # tsc --noEmit over the root tests/ plus every package's and example's tests/ (tsconfig.tests.json)
pnpm test         # vitest run (whole monorepo)
pnpm test:coverage # the same suite under v8 coverage, failing on the thresholds in vitest.coverage.config.ts — its own CI job, deliberately not part of `check`
pnpm depcruise    # enforce package-boundary rules (.dependency-cruiser.cjs)
pnpm lint         # oxlint over packages/*, examples/*, tests/ and .github/scripts/
pnpm prettify     # prettier --write . (printWidth 120)
pnpm format:check # prettier --check . — the separate formatting job CI runs alongside the gate
pnpm docs:build   # vitepress build docs — a second CI gate that `check` does NOT run
pnpm docs:links   # every `docs/**.md` reference and sidebar link resolves (a third; also not in `check`)
```

Run a single test file or test by name:

```bash
pnpm vitest run packages/core/tests/filter-parser.spec.ts
pnpm vitest run -t "coerces JavaScript number syntax"
```

Tests live in each package's `tests/` directory (never in `src/`, so they are not shipped in `dist/`). The one exception is the repo-level `tests/` directory, for tests whose subject is the repo's own wiring rather than any package — `tests/release-workflow.spec.ts` gates `.github/workflows/publish.yml`, and `tests/check-doc-links.spec.ts` gates `scripts/check-doc-links.sh`. Put a test there only when it belongs to no package; it is type-checked by the root `tsconfig.tests.json`. Vitest aliases `@kavo/*` to package `src/` directly (see `vitest.config.ts`), so tests exercise sources with no stale-`dist` hazard. The SWC vitest plugin is required — TypeORM entities and Nest DI need decorator metadata that esbuild cannot emit.

Because the build compiles `src` only, each package also has a `tsconfig.tests.json` (`noEmit`, `include: ["tests"]`, `paths` mirroring the vitest aliases) that `pnpm typecheck` runs. That is what makes the type-level acceptance tests in `packages/**/tests/types/*.test-d.ts` real: `vitest.config.ts` collects only `*.spec.ts`, so nothing in them ever executes — `expectTypeOf` assertions and `@ts-expect-error` directives are checked by `tsc` alone. An unused `@ts-expect-error` is itself an error, so those tests fail in both directions.

## Architecture

Nine published packages in a hub-and-spoke topology (`pnpm-workspace.yaml`, which globs in the three `examples/*` apps as well), plus one sanctioned sideways edge:

```
@kavo/nest ──▶ @kavo/core ◀── @kavo/typeorm
   │            ▲ ▲ ▲ ▲ ▲ ▲
   │            │ │ │ │ │ └─── @kavo/prisma
   │            │ │ │ │ └───── @kavo/mongoose
   │            │ │ │ └─────── @kavo/mikroorm
   │            │ │ └───────── @kavo/sse
   │            │ └─────────── @kavo/mcp     ◀─┐
   │            └───────────── @kavo/graphql ◀─┤
   └────── the one sanctioned sideways edge ───┘
          (frameworks/* → protocols/*, ADR-0016; never the reverse)
```

- **`@kavo/core`** (`packages/core`) — all contracts, the type system, and the request engine. **Zero runtime dependencies** and imports nothing (ADR-0005). It has no knowledge of TypeORM or Nest.
- **`@kavo/typeorm`** (`packages/orms/typeorm`) — implements core's `RepositoryAdapter` and feeds core's entity-metadata seam from TypeORM metadata. `typeorm` is a peer dependency.
- **`@kavo/prisma`** (`packages/orms/prisma`) — the same seams over a Prisma Client delegate, fed from Prisma's DMMF. Needs caller-declared marker classes as entity identities (ADR-0017). `@prisma/client` is a peer dependency.
- **`@kavo/mongoose`** (`packages/orms/mongoose`) — the same seams over a Mongoose model, fed from `schema.paths`. A Mongoose model _is_ the entity identity, so nothing is declared twice, and `ObjectId` converts to a hex string at the adapter boundary (ADR-0018). `mongoose` is a peer dependency.
- **`@kavo/mikroorm`** (`packages/orms/mikroorm`) — the same seams over a MikroORM `EntityManager`, fed from MikroORM's `MetadataStorage`. A decorated entity class _is_ the identity, as with TypeORM, so it needs no marker classes; the query surface is declarative like Prisma's, so the filter translator nests relation paths rather than building joins. Every operation forks its own `EntityManager`, and soft delete must name its column explicitly (MikroORM declares none). `@mikro-orm/core` is a peer dependency.
- **`@kavo/sse`** (`packages/realtime/sse`) — the first `RealtimeTransport` implementation (ADR-0023, issue #155): plain HTTP `text/event-stream`, no peer dependency at all. A sibling of `packages/orms/*` — an interchangeable implementation of one seam, not a `protocols/*` API surface — so it gets no ADR-0016 exception; `@kavo/nest` may only reach it through a lazy `import()`.
- **`@kavo/nest`** (`packages/frameworks/nest`) — the `@Kavo` decorator and NestJS route generation.
- **`@kavo/graphql`** (`packages/protocols/graphql`) — host-framework-agnostic GraphQL schema binding: builds a schema over a `createCrud` service, delegating every resolver to the same engine REST uses. Depends only on `@kavo/core` and the `graphql` peer, never on `@kavo/nest` — the `frameworks/* → protocols/*` edge is one-directional (ADR-0016). `@kavo/nest` is the side that imports it, to provide `BaseKavoGraphQLController`; it does so through a lazy `import("@kavo/graphql")` so the peer stays genuinely optional.
- **`@kavo/mcp`** (`packages/protocols/mcp`) — host-framework-agnostic MCP binding: exposes a `createCrud` service's standard operations as MCP tools, every tool handler a direct call into the same engine REST uses. Same `protocols/*` constraint as `@kavo/graphql` — `@kavo/core` plus the `@modelcontextprotocol/sdk` peer, which it consumes for **types only**, never at runtime. That is why `@kavo/nest` imports it directly rather than lazily, to provide `BaseKavoMcpController`; the one place `@kavo/nest` actually runs the SDK is its zero-config default MCP controller, which lazy-loads it (`load-mcp-sdk.ts`).

Spokes mostly never meet: an ORM adapter never imports another ORM adapter, a framework binding, or a protocol binding; a protocol binding never imports an ORM adapter or a framework binding; and adapters reach Nest's container through DI rather than through an import. The exception is the sideways edge in the diagram — `frameworks/* → protocols/*` (ADR-0016) — so `@kavo/nest` really does import `@kavo/graphql` and `@kavo/mcp`, and that edge is one-directional: a protocol binding never imports `@kavo/nest` back, which is what keeps it host-framework-agnostic.

All of that is **mechanically enforced** by `.dependency-cruiser.cjs`, not by convention. Core's `src` may import nothing — not at runtime and not type-only, because core owns its contracts (ADR-0001). Every other package's `src` may import the `@kavo/core` barrel and its own peer dependency, and nothing else in the workspace: not a sibling adapter, not a protocol binding, not a framework binding. `@kavo/nest` is the single exception, and only for the two protocol barrels the sideways edge exists for (ADR-0016) — at the barrel, never a subpath. Nothing deep-imports through another package's barrel, in either direction. Those fail `pnpm depcruise` (part of `pnpm check`), not code review. Three more rules are easy to forget because they constrain tests and cycles rather than package edges: `tests/` is cruised too — a test file may import its own package's source and the `@kavo/*` barrels, never another package's `src` or `tests`, and core's tests additionally may not reach an adapter, a protocol binding, or a framework package — and runtime import cycles are forbidden (type-only cycles are exempt, because core's contracts are mutually referential by design). `docs/internals/architecture/02-monorepo-and-packages.md` §3 covers the same rule set at more length.

The per-tier rules are written against the directory layout and back-reference the package they came from, rather than listing package names, so a new adapter or protocol binding is constrained the day its directory exists. `framework-bindings-import-core-and-protocol-barrels` is the one exception and the only hand-maintained list left: it spells out `@kavo/(core|graphql|mcp)`, so a new `protocols/*` package that `@kavo/nest` glues has to be added there. That is deliberate — a sanctioned sideways edge should be an explicit reviewed decision rather than something the layout confers. One public-API invariant is not an import edge and so lives in a test instead: `tests/core-barrel.spec.ts` fails if the core barrel grows an `export *` (ADR-0010).

What the gate does **not** cover is npm edges. The rules match `@kavo/*` and `packages/*`, so an ordinary node_modules dependency is outside them — `only-framework-bindings-import-a-host-framework` blocks `@nestjs/*` in an adapter or protocol binding, but importing some other package's peer (`typeorm` inside `@kavo/prisma`) is still review's job. So is what an import graph cannot show at all: an ORM or Nest type leaking into a core signature, and whether a newly _named_ barrel export was meant to be public.

### The request pipeline (the spine)

`KavoEngine.execute` (`packages/core/src/engine/kavo-engine.ts`) is a Template Method over one lifecycle, and nearly every stage is a swappable seam:

```
operation resolution → config resolution → DTO resolution → deserialization →
query resolution (reads) → handler execution → response mapping → serialization
```

Nothing is special-cased per verb. Operations come from an **operation registry** (`createOperationRegistry`), and the engine loops over registry entries — this is why adding an operation is adding a registry entry, and why the same registry drives both the engine and route generation. Handlers, serializer/deserializer, query normalizer, pagination strategies, and error handler are all constructor-injected.

### Composition root

`createKavo(options).createCrud(Entity, config?, runtime?)` (`packages/core/src/kavo.ts`) is the **only** way entities enter the system. All resolution (config precedence merge, DTO derivation, registry construction) happens at that call — bootstrap — and the result is frozen after. Core needs an explicit `infrastructure` (adapter + metadata); `@kavo/typeorm`'s `createInfrastructure(dataSource)` / `createTypeOrmKavo` is the sugar that derives both from a `DataSource`.

### Route generation is registry-driven and happens at decoration time

`@Kavo(Entity, config?)` (`packages/frameworks/nest/src/kavo.decorator.ts`) builds the same operation registry the engine uses and generates one route per **enabled** entry at class-definition time (the only moment Nest's router scan can see the methods). Notable rules:

- Disabled operations get no route; custom operations get their route from `meta.routes`; `meta.routes.enabled: false` keeps an operation service-only.
- **Manual-method-wins**: a hand-written controller method whose name matches an operation id suppresses that generated route.
- The bound service arrives later via property injection (`forFeature` provider), not through the constructor.

Every generated route — standard or custom — goes through `service.engine.execute(...)` and returns the `KavoResponse` envelope, which a method-scoped `KavoResponseInterceptor` unwraps after applying the `ETag`/`304` (ADR-0020); the typed `DefaultKavoService` surface is the same pipeline plus that unwrap, and stays the programmatic front door. HTTP query strings arrive as flat bracket keys wrapped in a `WireQuery` marker so the full parse-and-coerce pipeline runs; programmatic callers pass a typed `QueryContext` (normalized without coercion).

### Wiring an app

See `examples/nest-typeorm/src/app.module.ts`: `KavoModule.forRootAsync({ provideServices: true, useFactory: () => ({ infrastructure: createInfrastructure(dataSource), defaults: {...} }) })` is the app's only Kavo import — the `@Kavo` controllers just go in `AppModule`'s own `controllers: [...]` array. `KavoModule`'s discovery binder (`DiscoveryService`, `onModuleInit`) finds them there and binds each entity's service, no registration needed; `provideServices: true` additionally provides `getKavoServiceToken(Entity)` as a real DI provider for every `@Kavo`-decorated class the process has seen, which `AddressController` needs for its constructor-injected `base` (a fully custom route wants it typed as an ordinary constructor param). That's the same thing the standalone no-arg `KavoModule.forFeature()` does, folded into one call; `forFeature([...])` with an explicit array also still exists. Both no-arg forms are process-wide, so `@kavo/nest`'s own tests (many differently-configured `@Kavo` classes over one entity in one file) always pass `forFeature` an explicit array instead. The app is what hands Nest its infrastructure — `@kavo/nest` and the ORM adapter never import each other.

## Conventions (normative)

- **DTO slots** are bare verbs: `create`, `update`, `patch`, `query`, `item`, `list` (because `createOne`/`createMany` share the `create` DTO).
- **DTO classes**: request bodies are `<Verb><Entity>Dto` (`CreateUserDto`); query/response shapes are `<Entity><Slot>Dto` (`UserItemDto`, `UserListDto`). Every wire-crossing shape carries the `Dto` suffix; behavioral contracts (services, adapters, registries) never do.
- **Operations** are camelCase and always name cardinality: `<verb>One` / `<verb>Many`. "Bulk" is the feature term (config key `bulk`, `/bulk` routes, `BulkResultDto`), never a method prefix.
- **Filter operators**: AST enum in `SCREAMING_SNAKE` (`EQ`…`IS_NOT_NULL`); wire tokens in camelCase (`eq`…`isNotNull`), exact-case matched. The mapping table in `docs/internals/architecture/05-query-grammar.md` is the single source of truth.
- **Envelope fields**: `items`, `limit`, `offset`, `total`, `meta` — the default pagination wire params use the same `limit`/`offset` names, so request and response mirror each other.
- **Factories** are `create*` (`createKavo`, `createCrud`). **Data access**: `EntityReader` (reads) + `EntityWriter` (writes); `RepositoryAdapter` is both, and adapters are named for what they adapt (`TypeOrmRepositoryAdapter`). A `RepositoryAdapter`-typed **member** is named for its audience: `adapter` on a wiring seam an integrator fills (`KavoRuntime.adapter`, `infrastructure.adapterFor`, `builtInHandlers(adapter)`), `repository` on the handle application code reads and writes through (`KavoContext.repository`, ADR-0025).
- **Higher-order wrappers** — a function that takes a handler (or other behavior) and returns a decorated one of the same shape — are `with<Thing>` (`withListMeta`). Never `wrap*`, never `*Wrapper`; a `create*` name is for a factory that builds something from scratch, not for one that decorates what it is handed.
- **Exceptions**: `*Exception` classes with stable `KAVO_SNAKE_CASE` codes.
- **Config keys**: camelCase, booleans phrased positively (`exposeInternals`, never `hideInternals`).
- **No `I` prefix** on interfaces.
- The core barrel (`packages/core/src/index.ts`) is a **deliberate explicit named list** (no `export *`) — the public surface changes only on purpose. Add exports there intentionally.

## The development workflow

Work moves one issue at a time, on one branch, through slash commands in `.claude/commands/`:

```
/issue "rough idea"   →  a plannable GitHub issue (acceptance criteria, affected packages, constraints)
/implement <n>        →  branch created off main  →  code + tests written directly, in the main thread
                          →  left uncommitted
/review               →  pnpm check ‖ the reviewer fan-out (see below), consolidated  →  local mode
/commit               →  working tree split into logical commits
/pr                   →  pnpm check  →  push  →  PR opened/updated, "Closes #n"
/review [pr#]         →  same reviewer fan-out, run against the open PR  →  PR mode
/merge                →  CI + /review verified  →  squash merge  →  branch deleted  →  back on green main
```

`/commit` splits the working tree into logical commits at any point. `/review`
gates a change **before** it's committed when there's uncommitted work (local
mode), and re-runs the same reviewer fan-out **after** it's pushed, against
the actual PR (PR mode) — use it any time on any open PR, not just the one
you just opened. The fan-out itself (`kavo-reviewer`, `kavo-test-auditor`,
`kavo-security-auditor`, `kavo-perf-auditor`) is defined in
`.claude/commands/review.md`, which only runs the security and perf auditors
when the diff touches their area — read it there rather than here, so this
file doesn't drift when the fan-out changes.

`/list` reads existing GitHub issues without changing anything; `/publish` bumps and tags a release once `main` is green — neither is part of the per-issue loop above. (Reading one issue is just `gh issue view <n>`, which needs no command of its own.)

Two rules make this work:

- **Review is delegated; implementation is not.** Every agent in `.claude/agents/` — the four review auditors above — is read-only. Review benefits from independent fresh eyes, but implementation needs the conversation's full context (the issue, the seams it touches, decisions made along the way), so `/implement` reads the issue and writes the code in the main thread directly, with no separate planning hand-off.
- **`pnpm check` is the gate, and it is never worked around.** `/implement`, `/review`, `/pr`, and `/merge` each run it and report the real result. A red gate is not shipped, and a test is never weakened to make it pass.

## Where to read more

`docs/getting-started/`, `docs/using-the-api.md`, `docs/querying/`, `docs/features/`, `docs/integrations/orms/` (per-ORM wiring), and `docs/guides/` (the full `@Kavo`/`KavoModule` configuration reference) are the adopter-facing front door; `docs/internals/` holds the design docs and ADRs ([`adr/`](docs/internals/adr/), numbered sequentially) — one ADR per load-bearing decision. `docs/internals/architecture/` mirrors the packages: one document per adapter, per protocol binding, and per engine concern (query grammar, error handling, soft delete, relations). ADRs are referenced by name in code comments; read the referenced ADR before changing the behavior it governs.
