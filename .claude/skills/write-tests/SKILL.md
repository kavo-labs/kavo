---
name: write-tests
description: How to write tests for the Kavo monorepo — file placement, Vitest/SWC setup, fixtures, and the cases every change must pin down. Use when adding or updating tests in packages/core, packages/orms/*, or packages/frameworks/*.
---

# Writing tests for Kavo

## Placement and setup

- Tests go in each package's `tests/` directory — **never in `src/`**, so they
  are not shipped in `dist/`. The layout is flat: `packages/core/tests/*.spec.ts`,
  with shared fixtures in `packages/core/tests/support/`.
- Vitest aliases `@kavo/*` to package `src/` (see `vitest.config.ts`), so tests
  import the package by name and exercise sources directly. **Never import from
  `dist/`.**
- The SWC vitest plugin is mandatory: TypeORM entities and Nest DI need
  decorator metadata that esbuild cannot emit. If a test loses metadata
  unexpectedly, suspect the transform before the logic.

```bash
pnpm test                                                    # whole monorepo
pnpm vitest run packages/core/tests/filter-parser.spec.ts    # one file
pnpm vitest run -t "coerces JavaScript number syntax"        # one test by name
```

## Reuse the fixtures

Check `packages/core/tests/support/` before building anything: there are
existing entity fixtures (`user-fixture.ts`, `blog-fixture.ts`,
`account-fixture.ts`) and shared query cases. A new ad-hoc entity in a spec file
is usually a fixture that already exists.

## Test through the real seams

Kavo is built from injected seams — handlers, serializer/deserializer, query
normalizer, pagination strategies, error handler. Prefer driving the **real
engine** with a test adapter over mocking the pipeline. A test that mocks the
thing it is testing passes when the implementation is wrong.

Assert **observable behavior**, not internals. Call counts, private fields and
the order of injected seams break on every refactor and catch no bugs.

## The cases a change must pin down

For each behavior you add or change, write the test that would fail if it
silently regressed:

- **Happy path** — the intended result, with the full shape asserted, not
  `toBeDefined()`.
- **Validation** — rejected input produces the right rejection, not a crash.
- **Error path** — assert the thrown `*Exception` type **and** its
  `KAVO_SNAKE_CASE` code. The code is a public contract; asserting only the
  message lets the code drift silently.
- **Edge cases** — empty results, `null` vs. absent, boundary pagination values,
  the field-path recursion cap (ADR-0008), unknown include paths,
  non-allowlisted filter fields, disabled operations.
- **Regression** — a bugfix without a test that fails against the old code is
  unfinished. Write that test first and watch it fail.

## HTTP e2e suites: bootstrap with `listen(app)`, never `app.init()`

Any suite that drives a Nest app through supertest must bind it first:

```ts
import { listen } from "./support/listen.js";

app = moduleRef.createNestApplication();
const server = await listen(app); // == await app.listen(0, "127.0.0.1")
await request(server).get("/todos").expect(200);
```

`app.init()` leaves `getHttpServer()` unbound, so supertest binds it itself,
once per request: `listen(0)` on the **wildcard**, then a connect to a
hardcoded `127.0.0.1`. That asymmetry is a lottery over the ephemeral range —
a wildcard bind can be handed a port an unrelated local process already holds
on the loopback, and the request goes to that process instead. It surfaces as
`Parse Error: Expected HTTP/`, a foreign `400`/`404`/`405`, `socket hang up`,
or a hook timeout, and it made these suites ~10% flaky (issue #91). A foreign
`405` is the worst of them: it reads as a missing generated route.

The `await` is load-bearing — `listen(0, host)` binds asynchronously, unlike
the no-host path — so `listen` returns through `boundServer`, which rejects
all three ways the binding can be wrong: absent, unbound, or bound to the
wildcard. That last one is why a plain null-check is not enough — a wildcard
bind reports a healthy-looking `::` address while supertest still connects to
`127.0.0.1`. A suite that keeps its server in a variable routes its `server()`
accessor through `boundServer` too, so a mid-test `close()` cannot slip past.

The helper is duplicated per package (`packages/frameworks/nest/tests/support/`,
`examples/*/tests/support/`) because a test file may not import another
package's `tests/` — the alternative, a shared home outside every package that
owns it, is legal but buys less than it costs. Change all three copies
together. Never fix a port collision with a retry, a fixed port, or a raised
timeout; those hide it, and `listen.e2e.spec.ts` fails on the fixed port.

## Contracts that need wire-level assertions

These cross a boundary to a consumer, so assert the actual shape:

- query-string parsing and operator-token mapping (camelCase wire tokens →
  `SCREAMING_SNAKE` AST enum, exact-case matched)
- the response envelope: `items`, `limit`, `offset`, `total`, `meta`
- problem-details error output
- generated routes: method, path, and manual-method-wins suppression

## Before you call it done

Run `pnpm check` — build, `depcruise`, and the full suite. Report the real
result; if something fails, say so with the output.
