# Contributing to Kavo

Thanks for considering a contribution. This document covers getting a working
checkout, the one gate every change has to pass, and the invariants that will
get a PR sent back if a change breaks them.

If something here is wrong or out of date, that is a bug — please open an issue.

## Prerequisites

| Requirement | Version            | Notes                                            |
| ----------- | ------------------ | ------------------------------------------------ |
| Node        | `>=20`             | Matches `engines` in the root `package.json`     |
| pnpm        | `9.15.0`           | Pinned by `packageManager`; easiest via Corepack |
| Docker      | Any recent version | Must be **running** — see below                  |

pnpm is pinned, so let Corepack pick the right version rather than installing it
globally:

```bash
corepack enable
```

Docker is not optional. Four test suites provision a real database with
[Testcontainers](https://testcontainers.com/) rather than mocking one:

- `examples/nest-typeorm/tests/app-postgres.e2e.spec.ts` — Postgres
- `examples/nest-typeorm/tests/app-mariadb.e2e.spec.ts` — MariaDB
- `examples/nest-mongoose/tests/app-mongo.e2e.spec.ts` — MongoDB
- `examples/nest-mikroorm/tests/app-postgres.e2e.spec.ts` — Postgres

They start their own containers and need no manual database setup, but they do
need a Docker daemon the current user can talk to. Without one, `pnpm check`
fails in those suites.

Network access matters too, at least on a cold checkout: `@kavo/mongoose`'s unit
tests and the `nest-mongoose` example use `mongodb-memory-server`, which
downloads a `mongod` binary on first use and caches it. On a restricted network
that download fails with an error that has nothing to do with Docker.

One native module is pinned rather than resolved. `@kavo/mikroorm`'s tests run
on SQLite through `@mikro-orm/better-sqlite`, which depends on
`better-sqlite3@^11` — a range whose prebuilt binaries stop before current Node,
so on a newer runtime it falls back to `node-gyp` and fails to compile. The root
`package.json` therefore carries a `pnpm.overrides` entry raising _that
dependency alone_ to `better-sqlite3@^13`, which ships prebuilds. It is scoped
(`"@mikro-orm/better-sqlite>better-sqlite3"`) on purpose, so `@kavo/typeorm`'s
own SQLite resolution is untouched.

## Getting set up

```bash
pnpm install
pnpm generate   # generates Prisma Client + pushes the test-fixture schema
pnpm build
```

`pnpm generate` builds `@kavo/prisma`'s **test fixtures** — it runs
`prisma generate` and `prisma db push` against
`packages/orms/prisma/prisma/schema.prisma`. It needs no configuration: the
fixture schema is SQLite, and `packages/orms/prisma/prisma/.env` is committed
with a working `DATABASE_URL`.

What it pushes is a **template**, `prisma/template.db`, which no test opens.
`tests/support/client.ts` copies it per client, so each spec file writes to a
database of its own — SQLite admits one writer at a time, and one shared file
made the suite flaky under CI load. The copies live in a scratch directory
that `tests/support/global-setup.ts` creates per vitest run and deletes when
the run ends.

Note what it is _not_ for. `@kavo/prisma`'s own `src` never imports
`@prisma/client` — it models the client structurally in
`prisma-client-like.ts`, precisely so a library package does not assume the
consumer has run `prisma generate`. So `pnpm build` works without it; it is
`pnpm typecheck` and `pnpm test` that need it, because the test fixtures import
a real generated `PrismaClient` and read the pushed SQLite file. That is why
`generate` runs first in `pnpm check`.

## The gate

One command decides whether a change is shippable:

```bash
pnpm check
```

It runs, in order:

| Step        | Command                        | What it enforces                                    |
| ----------- | ------------------------------ | --------------------------------------------------- |
| `generate`  | Prisma client + fixture schema | `@kavo/prisma`'s test fixtures exist                |
| `build`     | `tsc -b`                       | Every package's `src` compiles (project references) |
| `typecheck` | one `tsc -p` per project       | Tests compile, including the type-level tests       |
| `depcruise` | `dependency-cruiser`           | Package boundaries (see [Invariants](#invariants))  |
| `lint`      | `oxlint`                       | Lint rules over `packages` and `examples`           |
| `test`      | `vitest run`                   | The whole suite                                     |

`pnpm test:coverage` is not in that list on purpose. It runs the same suite
under v8 instrumentation and fails on the thresholds in
`vitest.coverage.config.ts`, which would roughly double the command you run
all day for a signal that only matters per push — so it gets its own CI job
instead. Run it locally when you want to see what a change left untested;
`.coverage/index.html` is the browsable report.

The thresholds are a ratchet, not a target, and they are deliberately not set
at 100. Some of what remains uncovered is unreachable by construction —
`assertNever` arms over closed unions, `??` fallbacks the calling layer has
already collapsed, guards behind a precondition that makes them dead — and a
test that forces its way into one of those asserts the shape of the code
rather than any behavior. Raise the numbers when real coverage rises; don't
chase the gap.

Note that `typecheck` is a hand-maintained list — the root script names each
project's `tsconfig.tests.json` explicitly, with no glob and no discovery. **If
you add a package, or add a first `tests/` directory to one, append it to the
root `typecheck` script yourself**, or its tests are silently never typechecked
and the `*.test-d.ts` guarantee below does not hold for it.

**The gate is never worked around.** A red `pnpm check` is not shipped, and a
test is never weakened, skipped, or narrowed to make it pass. If a change makes
a test fail, either the change is wrong or the test encoded a behavior that is
being deliberately changed — and the second case belongs in the PR description.

CI runs the identical gate on three Node versions (`lts/-1`, `lts/*`,
`current`), plus three separate jobs — formatting, a docs build, and a
doc-link check. Before pushing:

```bash
pnpm prettify      # writes formatting fixes
pnpm format:check  # what CI actually runs
pnpm docs:build    # a separate CI job gates it — see "Working on the docs"
pnpm docs:links    # every `docs/**.md` reference and sidebar link resolves
```

`docs:links` sits outside `pnpm check` because it needs no toolchain at all —
it is `git grep` plus a file test (`scripts/check-doc-links.sh`), so CI can run
it as a dependency-free job that skips `pnpm install` entirely. That is a
reason to keep it out of the _aggregate_ command, not out of your loop: the
`/implement`, `/review`, `/pr` and `/merge` commands all run it alongside
`pnpm check`, because a red CI job is an expensive way to learn about a
one-second check.

It exists because a docs move leaves every mention of the old path behind, in
skills, agent prompts, package READMEs, and `src/` doc comments — and several
of those ship to npm, so a dead reference is one an adopter follows. The
`docs` job does not overlap with it: VitePress only resolves links inside the
pages it renders, so it never sees a reference written from `packages/`, and
it never reads `docs/.vitepress/config.mts` — an extensionless sidebar entry
left behind by a renamed page builds perfectly clean and ships a 404. Links
written _inside_ docs prose are the docs build's job, and this script leaves
them to it.

Two rules keep it honest. If a reference is a deliberate template placeholder
rather than a link, teach the script about it instead of deleting the check.
And every pass must match something in this repo, so the script fails loud when
a pass matches nothing rather than reporting success — a scanner that quietly
stops scanning is worse than no scanner, because it still looks green.

One thing the gate does **not** cover: CI installs with
`pnpm install --frozen-lockfile` _before_ running it, and neither `pnpm check`
nor `pnpm format:check` validates `pnpm-lock.yaml`. If you add, remove, or bump
a dependency, commit the regenerated lockfile — otherwise CI fails at the install
step, before the gate you verified locally ever runs.

## Running tests

The full suite is `pnpm test`. While iterating, narrow it:

```bash
pnpm vitest run packages/core/tests/filter-parser.spec.ts          # one file
pnpm vitest run -t "coerces JavaScript number syntax"              # one test by name
```

`-t` takes a **regular expression** (`--testNamePattern`), matched unanchored
against the full test name. A plain string therefore behaves like a substring
search, but a title copied verbatim from a spec file that contains `(`, `)`,
`[`, `.`, `+`, or `|` will not match itself — escape those or pick a plainer
fragment.

Either way, a filter that matches nothing **skips every test and still exits 0**.
A green run is only meaningful if the summary line shows tests actually ran —
check the passed count, not the exit code.

A few things about the test setup that are easy to trip over:

- **Tests live in each package's `tests/` directory, never in `src/`.** The
  build compiles `src` only, which is what keeps tests out of the published
  `dist/`.
- **Tests import package sources, not build output.** `vitest.config.ts` aliases
  every `@kavo/*` specifier to that package's `src/index.ts`, so there is no
  stale-`dist` hazard and no need to rebuild between test runs.
- **The SWC transform is required.** TypeORM entities and Nest DI rely on
  decorator metadata, which vitest's default esbuild transform cannot emit. That
  is why `unplugin-swc` is in the vitest config — don't remove it.
- **`@kavo/prisma`'s specs need the `globalSetup` in the vitest config.** It
  creates the scratch directory their database copies are written into and
  deletes it when the run ends. Remove it, or run those specs under a config
  that omits it, and every `newTestPrismaClient()` throws
  `KAVO_PRISMA_SCRATCH_ROOT is unset` — the fixture provisioner refuses to fall
  back to the OS temp directory, because a copy made outside that root is one
  nothing ever deletes.
- **An e2e spec binds its app with `listen(app)`, never `app.init()`.** The
  helper lives in each package's `tests/support/listen.ts`. `init()` leaves
  `getHttpServer()` unbound, so supertest binds it per request — `listen(0)` on
  the _wildcard_, then a connect to a hardcoded `127.0.0.1` — and that
  asymmetry lets your request reach an unrelated local process that already
  holds the port. It shows up as a parse error, a foreign 400/404/405, a socket
  hang up, or a timeout, in roughly one run in ten. Read the request through the
  suite's `server()` accessor rather than `app.getHttpServer()`, and never
  "fix" a port collision with a retry, a fixed port, or a longer timeout.
- **`*.test-d.ts` files are type-level tests and never execute.** Vitest does not
  collect them; `pnpm typecheck` is what verifies them, via each package's
  `tsconfig.tests.json`. They assert with `expectTypeOf` and `@ts-expect-error`,
  and because an _unused_ `@ts-expect-error` is itself a compile error, they fail
  in both directions. Adding one without running `pnpm typecheck` proves nothing.

## How the repo is laid out

Eight published packages in a strict hub-and-spoke topology:

| Package                                       | Path                         | Role                                       |
| --------------------------------------------- | ---------------------------- | ------------------------------------------ |
| [`@kavo/core`](packages/core)                 | `packages/core`              | Contracts, type system, request engine     |
| [`@kavo/typeorm`](packages/orms/typeorm)      | `packages/orms/typeorm`      | TypeORM adapter                            |
| [`@kavo/prisma`](packages/orms/prisma)        | `packages/orms/prisma`       | Prisma adapter                             |
| [`@kavo/mongoose`](packages/orms/mongoose)    | `packages/orms/mongoose`     | Mongoose adapter                           |
| [`@kavo/mikroorm`](packages/orms/mikroorm)    | `packages/orms/mikroorm`     | MikroORM adapter                           |
| [`@kavo/nest`](packages/frameworks/nest)      | `packages/frameworks/nest`   | NestJS binding — `@Kavo`, route generation |
| [`@kavo/graphql`](packages/protocols/graphql) | `packages/protocols/graphql` | GraphQL schema binding                     |
| [`@kavo/mcp`](packages/protocols/mcp)         | `packages/protocols/mcp`     | MCP binding — entities as MCP tools        |

Plus, not published:

- `examples/` — runnable reference apps (`nest-typeorm`, `nest-mongoose`,
  `nest-mikroorm`) that
  double as the e2e suites.
- `extensions/` — Claude Code skills shipped as a plugin via this repo's own
  marketplace.
- `docs/` — the VitePress site, and the internal design docs and ADRs.

`@kavo/core` is the hub: it depends on nothing, and everything else depends on
it. The edges are not all equivalent, though — ORM adapters and protocol
bindings are leaves, while a framework binding is allowed one sideways edge. See
[Invariants](#invariants) for the exact directions.

## Invariants

These are enforced, not merely encouraged. Each links to the decision record
that explains why.

- **Core imports nothing and has zero runtime dependencies** —
  [ADR-0005](docs/internals/adr/0005-core-zero-runtime-dependencies.md). Core has
  no knowledge of TypeORM, Prisma, Mongoose, MikroORM, or Nest.
- **Dependency inversion is strict: core never depends on an edge** —
  [ADR-0001](docs/internals/adr/0001-clean-architecture-core-owns-contracts.md).
  Beyond that, the allowed directions are specific, and it is worth learning them
  precisely rather than as "nothing imports anything":

  | Package kind                        | May import                             | Never imports                                | Blocked by                                            |
  | ----------------------------------- | -------------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
  | `@kavo/core`                        | nothing, type-only included            | anything                                     | `core-imports-nothing`                                |
  | ORM adapters (`orms/*`)             | the `@kavo/core` barrel + its ORM peer | a framework, a protocol, **another adapter** | `orm-adapters-only-import-core`                       |
  | Protocol bindings (`protocols/*`)   | the `@kavo/core` barrel + its own peer | a framework, an ORM, **another protocol**    | `protocol-bindings-only-import-core`                  |
  | Framework bindings (`frameworks/*`) | core **and the two protocol barrels**  | an ORM adapter, any barrel _subpath_         | `framework-bindings-import-core-and-protocol-barrels` |

  Every row's **"never imports"** column is machine-checked; none of it is
  review-only. The forbidding rules are written against the directory layout
  and back-reference the package they came from, so a new adapter or protocol
  binding is constrained the day its directory exists rather than when someone
  remembers to extend a list.

  Two things that column does **not** say, both worth knowing before you trust
  a green gate:

  - **The "may import" column is looser than it reads.** The rules forbid
    reaching another _workspace_ package; they say nothing about npm. The one
    exception is `only-framework-bindings-import-a-host-framework`, which
    stops an adapter or a protocol binding importing `@nestjs/*`. Pulling in
    some _other_ package's peer — `typeorm` inside `@kavo/prisma`, say — is
    still caught by review, not by the gate.
  - **The frameworks row's allowlist is the one hand-maintained list left.**
    `@kavo/(core|graphql|mcp)` is spelled out, so a new `protocols/*` package
    that `@kavo/nest` is meant to glue has to be added there or the sanctioned
    edge fails the gate. That is deliberate — a sideways edge should be an
    explicit reviewed decision — but it does mean this rule, unlike the
    others, needs an edit when a protocol package lands.

  So `@kavo/nest` really does import `@kavo/graphql` and `@kavo/mcp` directly —
  that is the sanctioned `frameworks/* → protocols/*` edge from
  [ADR-0016](docs/internals/adr/0016-graphql-protocols-package.md), and it is
  one-directional: a protocol binding never imports `@kavo/nest` back, which is
  what keeps it host-framework-agnostic. What is genuinely forbidden is a
  framework binding importing an **ORM adapter** — adapters reach Nest's
  container through DI, never through an import.

  Packages meet at the `@kavo/core` barrel rather than reaching into each
  other's `src/`. Three rules enforce that: `no-cross-package-deep-imports-core`
  (an edge deep-importing core), `no-cross-package-deep-imports-adapters` (core
  deep-importing an edge), and `no-deep-imports-through-a-barrel`, which
  generalizes both to every remaining pair — including one edge deep-importing
  another, and `@kavo/nest` reaching past a protocol barrel it is otherwise
  allowed to import. (Where packages live on disk is
  [ADR-0002](docs/internals/adr/0002-package-topology.md) for `orms/` and
  `frameworks/`, and ADR-0016 for `protocols/`.)

- **The core barrel is an explicit named list** —
  [ADR-0010](docs/internals/adr/0010-explicit-named-barrel.md).
  `packages/core/src/index.ts` uses no `export *`, so the public surface changes
  only on purpose. `tests/core-barrel.spec.ts` fails if one appears. Adding an
  export there is still a deliberate API decision that no test can judge for
  you, and belongs in the PR's "Public API impact" section.
- **Operations are registry-driven** —
  [ADR-0006](docs/internals/adr/0006-registry-driven-operations.md). The engine
  loops over registry entries and special-cases no verb. Adding an operation
  means adding a registry entry, not adding a branch.
- **Nest routes are generated at decoration time** —
  [ADR-0012](docs/internals/adr/0012-decoration-time-route-generation.md).
  Class-definition time is the only moment Nest's router scan can see generated
  methods.

The first two are checked by `.dependency-cruiser.cjs` — an illegal import fails
`pnpm depcruise`, which is part of `pnpm check`, and the error names the violated
rule. The third is checked by `tests/core-barrel.spec.ts`. What a green gate
does **not** prove is the part no import graph can see: an ORM or Nest type
leaking into a core signature, and whether a newly named barrel export was
meant to be public. Those two are review's job.

The rest are checked in review. Before changing behavior an ADR governs, read
that ADR — several are referenced by name from code comments.

## When to write an ADR

Write one when a change makes a load-bearing decision: a new seam, a new
invariant, a boundary rule, a rule about how packages relate. Do not write one
for a change that merely implements a decision already on record.

ADRs live in [`docs/internals/adr/`](docs/internals/adr/), numbered sequentially.
Read a couple of neighbours before writing one — they argue a decision once, so
it does not get re-argued in every later review.

## Naming conventions

Kavo's naming rules are normative and reviewed. Rather than restate them here in
a second place that can drift, read them at the source:

- The **Conventions** section of [`CLAUDE.md`](CLAUDE.md) — DTO slots and class
  names, operation naming (`<verb>One` / `<verb>Many`), envelope fields, factory
  and data-access naming, exception naming, config keys, and the no-`I`-prefix
  rule.
- [`docs/internals/architecture/05-query-grammar.md`](docs/internals/architecture/05-query-grammar.md)
  — the single source of truth for filter operators, including the mapping
  between the `SCREAMING_SNAKE` AST enum and the camelCase wire tokens.

## Branches and commits

One `type` vocabulary is shared across an issue's label, its branch prefix, and
its commit messages:

| Type       | Meaning                                | Issue label     |
| ---------- | -------------------------------------- | --------------- |
| `feat`     | New capability                         | `type:feat`     |
| `fix`      | Bug fix                                | `type:fix`      |
| `chore`    | Tooling, deps, housekeeping            | `type:chore`    |
| `test`     | Test coverage work                     | `type:test`     |
| `docs`     | Documentation                          | `type:docs`     |
| `refactor` | Code restructuring, no behavior change | `type:refactor` |
| `perf`     | Performance improvements               | `type:perf`     |
| `ci`       | CI/build pipeline changes              | `type:ci`       |

Branch off an up-to-date `main`, naming the branch
`<type>/<issue-number>-<short-slug>`:

```bash
git checkout main && git pull --ff-only
git checkout -b feat/123-cursor-pagination
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
using the same vocabulary: `<type>(<scope>): <subject>`, e.g.
`feat(core): add cursor pagination`. Scope is optional but preferred when the
change is package-scoped. Keep the subject under about 72 characters and in the
imperative mood; add a body only when the "why" isn't obvious from the subject.

## Pull requests

1. **Open or claim an issue first.** It is where the acceptance criteria get
   agreed, and it keeps a PR from being reviewed against a guess at its goal.
2. **Branch off `main`** using the naming above.
3. **Write tests alongside the code**, not after. Cover the error and edge
   paths, and assert exception _codes_ rather than only messages. A bugfix
   should come with a regression test that fails without the fix.
4. **Run `pnpm check` and `pnpm format:check`** and make them genuinely pass.
5. **Fill in the PR template.** The "Public API impact" section is not deleted
   when there is nothing to report — write `None`. Reviewers rely on it to spot
   unintended changes to `packages/core/src/index.ts`.
6. **Reference the issue** with `Closes #<n>`.
7. **Green CI, then squash merge.**

Update the docs in the same PR when a change alters behavior that an ADR or a
`docs/internals/architecture/` document describes. Docs drifting from code is a
review finding, not a follow-up.

## Working on the docs

The site is [VitePress](https://vitepress.dev/):

```bash
pnpm docs:dev      # local dev server with hot reload
pnpm docs:build    # production build
pnpm docs:preview  # serve the production build
```

`pnpm check` does not build the site, but CI does: a separate `docs` job runs
`pnpm docs:build` on every pull request and every push to `main`. VitePress fails
that build on dead links _between pages under `docs/`_, so a broken
cross-reference there fails the PR rather than the Pages deploy on `main`. The
job is deliberately not path-filtered — `docs/.vitepress/config.mts` reads
`packages/core/package.json` at build time — so run it locally before pushing,
docs change or not.

The gate is narrower than "it checks the links", though. These four categories
pass a green build and still need a human eye:

- **Anything outside `docs/`** — this file, the root `README.md`, each package's
  and example's `README.md` — plus `docs/README.md`, which `config.mts`
  `srcExclude`s. VitePress never renders them, so it never sees their links.
- **`#anchor` fragments**, even between two rendered pages. VitePress strips the
  hash before it compares, so `/getting-started#long-gone` passes as long as
  `getting-started` itself exists.
- **Links in config or frontmatter rather than markdown** — the `themeConfig.nav`
  and `sidebar` entries in `config.mts`, and the homepage's `hero.actions` in
  `docs/index.md`. Renaming a page updates none of them, and the build stays
  green while the site's own navigation 404s.
- **Links pointing at `CLAUDE.md`**, which `ignoreDeadLinks` exempts.

`docs/` has two audiences, and it is worth keeping them separate:

- **Adopter-facing** — [`docs/getting-started/`](docs/getting-started/introduction.md),
  [`docs/using-the-api.md`](docs/using-the-api.md), and
  [`docs/integrations/`](docs/integrations/). Written for someone building an app
  with Kavo.
- **Internal** — [`docs/internals/`](docs/internals/), holding the architecture
  documents and ADRs. Written for someone changing Kavo itself.

## Releases

Versioning is **lockstep**: every `@kavo/*` package ships at the same version
([ADR-0004](docs/internals/adr/0004-lockstep-versioning.md)).

Contributors do not bump versions. Releases are cut by maintainers, who push a
`vX.Y.Z` tag that triggers the publish workflow. A PR that edits a package's
`version` field will be asked to drop that change.

## Working with Claude Code

Kavo is developed with [Claude Code](https://claude.com/claude-code), and the
wiring is committed:

- `.claude/commands/` — the issue → implement → review → commit → PR → merge
  workflow as slash commands.
- `.claude/agents/` — read-only review agents used in the review fan-out.
- `.claude/skills/` — repo-specific procedures (adding an operation, a config
  key, an exception, an ADR).
- `.claude/settings.json` — permissions. `npm publish` / `pnpm publish` are
  `ask` (never `deny` — `/publish`'s first-publish bootstrap legitimately runs
  one on a packed tarball), and a small allowlist skips the prompt for
  genuinely read-only commands.

That allowlist is deliberately missing the three you would reach for first —
`git diff`, `git log`, and `git show`. **Do not add them.** Entries are prefix
matches, and all three accept git's diff options, which include
`--output=<file>`: that truncates and overwrites any path on disk, silently,
exiting 0. `git diff --no-index a b` reads any two files outside the repo, and
`git difftool -x <cmd>` runs an arbitrary command while still starting with the
characters `git diff`. Since this file is committed, an entry here applies to
every contributor's sessions — including ones whose context contains text from
a fork PR or an issue comment. The commands that need these calls already
declare them in their own `allowed-tools`, so the only thing the entries buy is
skipping a prompt on ad-hoc use, which is not worth an unprompted arbitrary
file write.

None of this is required to contribute — the commands above are the whole story,
and a PR is judged on its diff and a green gate either way.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license that covers the project.
