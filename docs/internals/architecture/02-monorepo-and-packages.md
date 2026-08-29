# 02 — Monorepo & Package Design

## 1. Structure

```
kavo/
├─ package.json               # root: build/check scripts, dev tooling
├─ pnpm-workspace.yaml
├─ tsconfig.base.json         # shared strict compiler options
├─ tsconfig.json              # solution file: project-reference graph
├─ .dependency-cruiser.cjs    # mechanical boundary enforcement
├─ packages/
│  ├─ core/                   # @kavo/core
│  │  ├─ src/{types,query,dto,errors,config,operations,
│  │  │       relations,context,serialization,persistence,service}/
│  │  └─ src/index.ts         # explicit named barrel
│  ├─ orms/
│  │  ├─ typeorm/             # @kavo/typeorm
│  │  │  └─ src/index.ts
│  │  ├─ prisma/              # @kavo/prisma
│  │  │  └─ src/index.ts
│  │  ├─ mongoose/            # @kavo/mongoose
│  │  │  └─ src/index.ts
│  │  └─ mikroorm/            # @kavo/mikroorm
│  │     └─ src/index.ts
│  ├─ realtime/
│  │  └─ sse/                 # @kavo/sse
│  │     └─ src/index.ts
│  ├─ frameworks/
│  │  └─ nest/                # @kavo/nest
│  │     └─ src/index.ts
│  └─ protocols/
│     ├─ graphql/             # @kavo/graphql
│     │  └─ src/index.ts
│     └─ mcp/                 # @kavo/mcp
│        └─ src/index.ts
├─ examples/                  # reference applications, one per framework+ORM pairing
│  ├─ nest-typeorm/           # @kavo/example-nest-typeorm
│  │  └─ src/index.ts
│  ├─ nest-mongoose/          # @kavo/example-nest-mongoose
│  │  └─ src/index.ts
│  └─ nest-mikroorm/          # @kavo/example-nest-mikroorm
│     └─ src/index.ts
└─ docs/                      # this documentation
```

The `orms/`, `realtime/`, `frameworks/`, and `protocols/` parent folders
keep the door open for future adapters, transports, host framework
bindings (Express, Fastify, Next.js, …), and wire protocols (gRPC, …)
without implying any get built ahead of real work landing (ADR-0002,
ADR-0016). `@kavo/prisma` and `@kavo/mongoose` are the second and third
`orms/*` adapters, alongside `@kavo/typeorm` — see ADR-0017 for the one
place Prisma's design departs from the TypeORM adapter's shape (marker
classes standing in for Prisma's lack of runtime entity classes), and
ADR-0018 for Mongoose's two (a model is already the entity identity, and
`ObjectId` converts at the adapter boundary rather than widening core's
`EntityId`). `@kavo/mikroorm` is the fourth, and needed no ADR of its own:
a decorated MikroORM entity class is already the identity, exactly as
under TypeORM, so the only decisions it makes are adapter-local and live
in doc 17.

`realtime/` is a new parent folder alongside `orms/` (issue #155,
building on the `RealtimeTransport` seam ADR-0023 added): `@kavo/sse` is
its first package, and — like an ORM adapter — an interchangeable
implementation of one seam rather than a different API surface the way
`protocols/*` is. It follows the exact `orms/*` boundary shape (own
directory, `@kavo/core` plus its own peer only) rather than the
`protocols/*`/ADR-0016 one: `@kavo/nest` may only reach it through a lazy
`import()`, the same way it lazy-loads the MCP SDK, never a static import
edge.

## 2. Responsibility statements

- **`@kavo/core`** exists to own every contract and all ORM/framework-
  independent runtime (engine, config merging, query parsing, DTO
  resolution, exceptions). It can't depend on **anything** — not TypeORM,
  not NestJS, not utility libraries. If core needs a helper, core writes it.
- **`@kavo/typeorm`** exists to translate core's persistence contracts to
  TypeORM (adapter, filter translation, error mapping, transactions). It
  can't depend on NestJS or `@kavo/nest` — an adapter must be usable from
  any future framework binding.
- **`@kavo/prisma`** exists to translate core's persistence contracts to
  Prisma Client (same shape as `@kavo/typeorm`: adapter, filter
  translation, error mapping), and is bound by the same rule — no NestJS,
  no `@kavo/nest`. See ADR-0017 for how it substitutes for the runtime
  entity classes Prisma doesn't generate.
- **`@kavo/mongoose`** exists to translate core's persistence contracts to
  Mongoose (same shape again: adapter, filter translation, error mapping),
  under the same no-framework rule. See ADR-0018 and doc 15 for the two
  places a document store diverges from a relational one.
- **`@kavo/mikroorm`** exists to translate core's persistence contracts to
  MikroORM (same shape again: adapter, filter translation, error mapping),
  under the same no-framework rule. See doc 17 for the two places it splits
  the difference between its siblings — TypeORM's decorated-class metadata
  seam, Prisma's declarative query surface.
- **`@kavo/sse`** (`packages/realtime/sse`, issue #155) exists to
  implement core's `RealtimeTransport` seam over Server-Sent Events —
  plain HTTP `text/event-stream`, no peer dependency at all, since SSE
  needs no client/server library the way WebSocket needs `ws`. Same
  no-framework rule as an ORM adapter: `@kavo/core` only, never
  `@kavo/nest`. See `packages/realtime/sse/README.md`.
- **`@kavo/nest`** exists to bind Kavo to NestJS (module, decorator,
  route generation, exception filter, Swagger). It can't depend on TypeORM
  or `@kavo/typeorm` — it sees persistence only as an injected
  `RepositoryAdapter`. It may depend on a `protocols/*` package
  (`@kavo/graphql`, `@kavo/mcp`) to offer that protocol's glue as an
  add-on — see ADR-0016 — but never another `frameworks/*` package.
- **`@kavo/graphql`** (`packages/protocols/graphql`, ADR-0016) exists to
  build a `GraphQLSchema` over a `createCrud` service — host-framework-
  agnostic, same constraint as an ORM adapter: it depends on `@kavo/core`
  and the `graphql` peer only, never `@kavo/nest` or any other framework
  package. See `docs/internals/architecture/13-graphql-binding.md`.
- **`@kavo/mcp`** (`packages/protocols/mcp`, ADR-0016) exists to expose a
  `createCrud` service's standard operations as MCP tools — the same
  `protocols/*` shape and constraint as `@kavo/graphql`: `@kavo/core`
  only, plus the `@modelcontextprotocol/sdk` peer for types (never
  imported at runtime by `@kavo/mcp` itself — `@kavo/nest`'s zero-config
  default controller is the one place the SDK actually runs, lazily — see
  doc 16, §5). See `docs/internals/architecture/16-mcp-binding.md`.

Every package earns its place: core is the hub, and every other package
adapts exactly one external technology or protocol — an ORM, a host
framework, or a wire protocol.

## 3. Dependency rules — mechanically enforced

Two independent enforcement layers:

1. **TS project references** (`tsconfig.json` solution + per-package
   `references`) make build order correct and make an undeclared
   cross-package import a compile error.
2. **dependency-cruiser** (`.dependency-cruiser.cjs`, run in `pnpm check`)
   forbids: core importing anything, adapter↔framework imports in either
   direction, cross-package deep imports past a barrel, an adapter or
   protocol binding importing `@nestjs/*`, and runtime import
   cycles (type-only cycles are exempt — core's contracts are mutually
   referential by design and erase at compile time). One exception to
   "no cross-edge imports": a `frameworks/*` package may depend on a
   `protocols/*` package (`@kavo/nest` → `@kavo/graphql`/`@kavo/mcp`), never
   the reverse — ADR-0016.

   Three properties of that rule set are load-bearing and easy to lose:
   - **Every workspace edge is checked, and stays checked without edits.**
     That includes the four that were review-only for most of
     this repo's life: an ORM adapter importing a protocol package, one ORM
     adapter importing another, one protocol importing another, and one edge's
     `src` deep-importing another edge's. `core-imports-nothing` covers
     type-only edges too — core owning its contracts (ADR-0001) does not stop
     at what survives compilation. The three per-tier rules capture the
     package directory in `from` and refer back to it as `$1` in
     `to.pathNot`, so they are written against the _layout_ rather than
     against a list of package names: a new adapter or protocol binding is
     constrained the day its directory exists. The previous spelling was
     one rule per package, which meant every new package had to hand-edit
     every other package's rule, and the prose describing the set drifted out
     of sync with it twice.

     Two limits are part of the design rather than oversights.
     `framework-bindings-import-core-and-protocol-barrels` still names
     `@kavo/(core|graphql|mcp)` explicitly, because it is an _allowlist_ of
     sanctioned sideways edges — a new `protocols/*` package that `@kavo/nest`
     glues must be added to it, and that edit is the architectural decision
     being reviewed. And the rules match `@kavo/*` and `packages/*` only, so
     npm edges are outside them: `only-framework-bindings-import-a-host-`
     `framework` blocks `@nestjs/*` in an adapter or protocol binding, but a
     wrong _peer_ (`typeorm` inside `@kavo/prisma`) is review's job. So is
     the part no import graph can see — an ORM or Nest type leaking into a
     core signature, and whether a newly named barrel export was meant to be
     public.

   - **Both spellings are matched.** A workspace package specifier does not
     resolve to a path for dependency-cruiser, so a path-only rule silently
     misses `from "@kavo/nest"` — the spelling anyone would actually write.
     The rules match the bare specifier as well as the relative path.
     `examples/*` is in scope too: those are the reference apps.
   - **`tests/` is cruised, not exempt.** Test files were once excluded
     entirely, which left the boundary convention-only exactly where fixture
     sharing tempts a shortcut. A test file may import its own package's
     source and the `@kavo/*` barrels, never another package's `src` or
     `tests`; core's tests additionally may not reach an adapter, a protocol
     binding, or a framework package, because core's ignorance of all three is
     what its suite exists to prove.

## 4. Workspace tooling: pnpm + plain scripts (ADR-0003)

pnpm workspaces with **plain root scripts**, no
task runner. The entire build graph is nine packages and three example apps,
whose ordering is already fully expressed by TS project references — `tsc -b`
performs incremental, dependency-ordered, cached builds natively. A task runner
(turborepo/nx) would add a second place where the graph is declared, a
cache layer duplicating `.tsbuildinfo`, and config to keep honest, while
buying nothing at this scale. Revisit only if the workspace gains many
packages or expensive non-tsc pipelines (a future e2e suite is the
natural checkpoint).

Root scripts: `generate`, `build` (`tsc -b`), `clean`, `typecheck`,
`depcruise`, `lint`, `test`, `test:coverage`, `prettify`, `format:check`,
`docs:build`, `docs:links`, and `check` — the last runs `generate → build →
typecheck → depcruise → lint → test` and is the verification gate. Four
checks sit outside it, each as its own CI job: `test:coverage` (the same
suite under v8 instrumentation, failing on the thresholds in
`vitest.coverage.config.ts` — kept out of the gate because instrumenting a
second full run doubles the command developers run all day),
`format:check`, `docs:build` (VitePress, which resolves the links inside the
pages it renders), and `docs:links` (`scripts/check-doc-links.sh`). The last
two are complements, not overlaps —
the docs build never sees a `docs/**.md` reference written from `packages/`
or `extensions/`, because those are not pages, and it never reads
`docs/.vitepress/config.mts`, because that is config rather than content. So
a renamed doc can still leave a dead link in a package README that ships to
npm, or a silent 404 in the published sidebar, and `docs:links` is what
catches both. The `/implement`, `/review`, `/pr` and `/merge` commands run
these alongside `pnpm check` locally, so none of them is a gate you only hear
about from CI.

## 5. Public vs. internal API surface

Each package's `exports` map exposes **only the barrel**:

```jsonc
"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }
```

No subpath exports; deep imports are not API and Node will refuse them at
runtime once published. Core's barrel is an explicit named list
(ADR-0010) so the public surface only changes on purpose — it is the
input to a future api-extractor gate. The current build ships ESM only;
dual ESM+CJS output is a future deliverable.

## 6. Build strategy

`tsc -b` against the solution file: incremental (`.tsbuildinfo`),
project-reference-ordered (core → typeorm/prisma/mongoose/mikroorm/sse/graphql/mcp → nest),
each package emitting
`dist/` with declarations + declaration maps. Consumers inside the
workspace resolve `@kavo/*` via pnpm workspace links to the built
`dist`, exactly as external consumers will.

## 7. Versioning: lockstep (ADR-0004)

All `@kavo/*` packages share one version number and release together.
The packages form one tightly coupled contract surface — a core contract
change almost always touches an edge package, and a single version answers
"which adapter works with which core" permanently. Cost: occasional no-op
version bumps for an untouched package — accepted as trivially cheap next
to cross-package version-matrix support.

Release mechanics live in `.github/workflows/publish.yml`, which runs on a
published GitHub Release (and still on a manually pushed `vX.Y.Z` tag, as a
fallback). `PACKAGE_DIRS` there is the explicit list of what gets released,
ordered so every package publishes after the packages it depends on
(`@kavo/nest` last), which keeps the registry internally consistent if a
run fails partway. Lockstep itself is checked rather than assumed: a gate
ahead of packing fails the release unless every listed package is already at
the tag's version.

Those mechanics are _triggered_ by release-please (ADR-0041), not run by
hand: a single release PR on `main` carries the computed lockstep bump
(every `package.json` via `extra-files`) and the generated root
`CHANGELOG.md`, and merging it creates the `vX.Y.Z` tag and GitHub Release.
`.claude/commands/publish.md` is now only the procedure for bootstrapping a
brand-new package's first publish.

The artifact is checked too, between packing and publishing: no packed
tarball may carry a `workspace:` range in any dependency field a consumer
installs, and each must contain the entry point its own manifest declares.
Only `pnpm pack` rewrites `workspace:^` into a real semver range and it runs
no build, so those are the two ways a tarball reaches the registry
uninstallable — and npm does not allow republishing a version to correct it.

## 8. Dependency classification (decided now, executed later)

| Package          | `dependencies`                             | `peerDependencies`                                                                                                                                  |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kavo/core`     | — (none, ever)                             | —                                                                                                                                                   |
| `@kavo/typeorm`  | `@kavo/core`                               | `typeorm`                                                                                                                                           |
| `@kavo/prisma`   | `@kavo/core`                               | `@prisma/client`                                                                                                                                    |
| `@kavo/mongoose` | `@kavo/core`                               | `mongoose`                                                                                                                                          |
| `@kavo/mikroorm` | `@kavo/core`                               | `@mikro-orm/core`                                                                                                                                   |
| `@kavo/sse`      | `@kavo/core`                               | — (none)                                                                                                                                            |
| `@kavo/graphql`  | `@kavo/core`                               | `graphql` (optional)                                                                                                                                |
| `@kavo/mcp`      | `@kavo/core`                               | `@modelcontextprotocol/sdk` (optional)                                                                                                              |
| `@kavo/nest`     | `@kavo/core`, `@kavo/graphql`, `@kavo/mcp` | `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs`; plus `graphql`, `@modelcontextprotocol/sdk` and `@nestjs/swagger`, all three optional |

Peers, not dependencies, because the consumer's app owns the TypeORM/Prisma/
Mongoose/MikroORM/Nest instance — a second copy via a nested dependency would fracture
`instanceof` checks and DI tokens.

**Optional where the package is somebody's transitive dependency.** The rule
is topological, not about how badly the package needs its peer — every peer
here is required to _use_ the package that declares it, `graphql` and
`typeorm` alike.

What separates them is who ends up installing it. An ORM adapter is nobody's
dependency: `@kavo/typeorm` only ever reaches a tree because someone asked
for it, so a required peer is a clear install-time error for a user who
already opted in. A protocol binding is a hard `dependency` of `@kavo/nest`
(ADR-0016's sanctioned sideways edge), so a required peer there is
force-installed on every user who never opted into the protocol at all —
which is #148: `graphql`, the MCP SDK and its `zod` subtree in every
REST-only install.

Both hops have to say optional, because a package manager resolves the
binding and then the binding's own peer; marking only `@kavo/nest`'s copy
changed nothing. `tests/release-workflow.spec.ts` asserts both, since the
failure is silent — the manifest still installs, the tree is just bigger.

The two bindings sit at different points on the trade. `@kavo/mcp` is free:
it references the SDK as a type only, so it runs without it. `@kavo/graphql`
value-imports `graphql` at module scope, so installing that package alone
without its peer throws `ERR_MODULE_NOT_FOUND` on first import — a runtime
error where a required peer would have given an install-time one. That is
the deliberate half of the trade, and it is acceptable because the person
who installed `@kavo/graphql` is by definition someone who opted in; the
person it protects is the REST-only adopter who never touched it.
