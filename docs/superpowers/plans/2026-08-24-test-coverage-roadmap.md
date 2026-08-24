# Test Coverage Roadmap — by test type, ORM, and example app

**Goal:** A living inventory of which test categories exist today, per package
and per example app, so gaps are visible and prioritizable rather than
implicit. This is a coverage map, not an implementation plan — each row below
becomes its own `/issue` when picked up.

**Scope:** `packages/orms/*` (typeorm, prisma, mongoose, mikroorm),
`packages/frameworks/nest`, `packages/protocols/*`, `packages/realtime/sse`,
and `examples/*` (nest-typeorm, nest-mongoose, nest-mikroorm — see the
correction below about `nest-prisma`).

**As of:** 2026-08-24, 2980 passing tests across 120 files (`pnpm check` green).

---

## Part 1 — Test type × implementation status (engine-wide)

| Test type                                                   | Implemented | Where                                                          | Notes                                                              |
| ----------------------------------------------------------- | ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| CRUD (happy path)                                           | ✅          | `crud-e2e.suite.ts`, `binding.e2e.spec.ts`                     | Full lifecycle over real HTTP, all ORMs                            |
| Validation (query grammar)                                  | ✅          | `query-normalizer.spec.ts`, `filter-parser.spec.ts`            | Operator mapping, bad values, depth/`IN` limits                    |
| Validation (DTO/body)                                       | ✅          | per-entity override tests, `class-validator` DTOs              | Only where an app opts in via `@Override`                          |
| Security — allowlist bypass                                 | ✅          | `security.e2e.spec.ts`, `crud-e2e.suite.ts` (#45)              | filter/sort/select restricted per entity                           |
| Security — SQL / NoSQL injection                            | ✅          | `security.e2e.spec.ts` (typeorm, mikroorm, mongoose)           | Identifier + value position, real databases, all 3 example apps    |
| Security — mass assignment                                  | ✅          | `security.e2e.spec.ts` (all 3 apps), `binding.e2e.spec.ts`     | id/deletedAt/generated columns stripped                            |
| Security — IDOR / authz                                     | ✅          | `policy.e2e.spec.ts`                                           | Ownership, 404-beats-403, ADR-0037 (TypeORM only)                  |
| Security — prototype pollution                              | ✅          | `binding.e2e.spec.ts`                                          | `__proto__` wire-query amplification                               |
| Security — internal-detail leakage                          | ✅          | `binding.e2e.spec.ts`, `kavo-exception.filter.spec.ts`         | `exposeInternals` off-by-default                                   |
| Security — XSS / stored payload                             | ✅          | `security.e2e.spec.ts` (all 3 apps)                            | JSON-only responses, no HTML sink                                  |
| Concurrency — optimistic locking / ETag                     | ✅          | `etag.spec.ts`, `caching.spec.ts`, `principal.e2e.spec.ts`     | `If-Match` preconditions                                           |
| Concurrency — race conditions (parallel writes)             | ✅          | `examples/nest-typeorm/tests/concurrency.e2e.spec.ts`          | Two overlapping writers, stale `If-Match`, concurrent deletes      |
| Idempotency (PUT/replace semantics)                         | ✅          | `array-mutation-resource.spec.ts`, `json-patch.spec.ts`        | Replace/patch semantics pinned down (TypeORM only)                 |
| Idempotency keys (client-supplied)                          | ❌          | —                                                              | Not a Kavo feature; no idempotency-key header support              |
| Transactions / rollback                                     | ✅          | `handler-data-access.spec.ts`, adapter `error-mapping.spec.ts` | Write failure leaves row unchanged                                 |
| Error mapping (driver → problem-details)                    | ✅          | `error-mapping.spec.ts` per ORM                                | Unique violation, invalid UUID, etc.                               |
| Soft delete / restore / purge                               | ✅          | `crud-e2e.suite.ts`, per-ORM specs                             | 34 files touch it                                                  |
| Bulk operations                                             | ⚠️ thin     | 2 files                                                        | Exists but sparsely covered vs. singular ops                       |
| Pagination (limit/offset, page, cursor)                     | ✅          | 35 files, `cursor-pagination.spec.ts` per ORM                  | Both strategies, clamping, envelope shape                          |
| Relations / includes (depth, N+1 shape)                     | ✅          | `crud-e2e.suite.ts`, ADR-0008 cap tests                        | Depth cap, batch vs. join                                          |
| Performance / N+1 regression                                | ✅          | `packages/orms/typeorm/tests/n-plus-one.spec.ts`               | Query count asserted flat as root row count scales (TypeORM only)  |
| Rate limiting / throttling                                  | ❌          | —                                                              | Not a Kavo concern (delegated to the host app/gateway)             |
| GraphQL / MCP / SSE protocol bindings                       | ✅          | `packages/protocols/*`, `packages/realtime/sse`                | 7 spec files                                                       |
| Config precedence (global→entity→op→call)                   | ✅          | `config-validation.spec.ts` and friends                        | Layered merge semantics                                            |
| Type coercion / serialization                               | ✅          | `value-coercion.spec.ts`, `filter-evaluator.spec.ts`           | Wire strings → typed values, both directions                       |
| Null vs. absent / undefined edge cases                      | ✅          | 31 files across `packages/core/tests`                          | `null` vs. omitted field distinguished throughout                  |
| Unicode / non-ASCII input                                   | ⚠️ thin     | `barrel.spec.ts`, `errors.spec.ts`, prisma isolation spec      | No dedicated multi-script/emoji round-trip suite                   |
| Timezone / date handling                                    | ✅          | per-ORM `adapter.spec.ts`/`soft-delete.spec.ts`                | Date columns across 4 ORM drivers                                  |
| DI wiring / module bootstrap                                | ✅          | 32 files (`forRoot`, `forFeature`, `DiscoveryService`)         | Binder discovery, async factories, dup registration                |
| OpenAPI/Swagger documentation                               | ⚠️ thin     | 2 files (folded into `binding.e2e.spec.ts`)                    | Route/schema shape asserted per-feature, not a dedicated audit     |
| Content negotiation (Content-Type/Accept)                   | ✅          | 8 files                                                        | `application/json` vs. `application/problem+json`                  |
| Payload/limit boundaries (maxLimit, maxInValues, body size) | ✅          | `settings.e2e.spec.ts`, query-normalizer specs                 | Pagination clamps, `IN` cap; no raw body-size-limit test           |
| Backward compatibility across ORM adapters                  | ✅          | 10 files (mirrored specs per ORM)                              | Same behavioral spec run against 4 backends                        |
| Migration / schema drift (`synchronize`, composite keys)    | ✅          | `composite-primary-key.spec.ts`, per-ORM adapter specs         | No live migration-runner test, but schema shape is pinned          |
| Realtime / event delivery (SSE)                             | ✅          | `sse-transport.spec.ts`, `integration.spec.ts`                 | Channel scoping, event payload shape                               |
| Fuzz / property-based testing                               | ⚠️ minimal  | `query-normalizer.spec.ts` (ad hoc cases only)                 | No `fast-check`-style generator in the repo                        |
| Load / stress testing                                       | ❌          | —                                                              | No throughput/soak test exists                                     |
| Multi-tenant / cross-entity isolation                       | ❌          | —                                                              | No tenant-scoping feature or test; would ride on `policy` if added |
| Docs consistency (link/ADR checks)                          | ✅          | `tests/check-doc-links.spec.ts`                                | Repo-wiring test, not product behavior                             |
| Release/CI pipeline correctness                             | ✅          | `tests/release-workflow.spec.ts`                               | Gates `publish.yml`                                                |

---

## Part 2 — Per-ORM adapter coverage (`packages/orms/*/tests`)

`✅` = file exists and covers the category for that adapter. `❌` = no file.

| Category                                       | typeorm                                 | prisma | mongoose | mikroorm |
| ---------------------------------------------- | --------------------------------------- | ------ | -------- | -------- |
| adapter (core CRUD contract)                   | ✅                                      | ✅     | ✅       | ✅       |
| filter-translator                              | ✅                                      | ✅     | ✅       | ✅       |
| includes (relations)                           | ✅                                      | ✅     | ✅       | ✅       |
| cursor-pagination                              | ✅                                      | ✅     | ✅       | ✅       |
| soft-delete                                    | ✅                                      | ✅     | ✅       | ✅       |
| error-mapping                                  | ✅                                      | ✅     | ✅       | ✅       |
| metadata (entity-metadata seam)                | — (n/a, TypeORM metadata used directly) | ✅     | ✅       | ✅       |
| array-mutation (per-relation writes, ADR-0029) | ✅                                      | ❌     | ❌       | ❌       |
| composite-primary-key                          | ✅                                      | ❌     | ❌       | ❌       |
| json-patch (JSON column semantics)             | ✅                                      | ❌     | ❌       | ❌       |
| document-mapping (ObjectId ↔ hex, ADR-0018)    | n/a                                     | n/a    | ✅       | n/a      |
| database-isolation (per-test DB scoping)       | n/a (SQLite in-memory)                  | ✅     | n/a      | n/a      |

**Gap:** `array-mutation`, `composite-primary-key`, and `json-patch` are
TypeORM-only. Whether that's a real gap or a documented ORM-capability
difference needs to be checked per feature against
`docs/integrations/orms/*` before opening issues — some of these may be
TypeORM-specific by design (e.g. JSON columns don't exist identically across
all four backends).

---

## Part 3 — Per-example-app coverage (`examples/*/tests`)

**Correction:** the original draft of this table listed a fourth app,
`nest-prisma`, as "has entities and an app module but zero tests." That was
wrong — `examples/nest-prisma` on disk contains only `dist/` and
`node_modules/` (stale build/install artifacts), no `src/`, and is not
tracked in git (`git ls-files examples/nest-prisma` returns nothing, and
`pnpm-workspace.yaml`'s `examples/*` glob has no package there to pick up).
There is no `nest-prisma` example app in this repo today, so there is
nothing to add tests to.

| Category                                                | nest-typeorm                                 | nest-mongoose             | nest-mikroorm             |
| ------------------------------------------------------- | -------------------------------------------- | ------------------------- | ------------------------- |
| Has a `tests/` directory at all                         | ✅                                           | ✅                        | ✅                        |
| Basic CRUD e2e (`app*.e2e.spec.ts`)                     | ✅ (sqlite + postgres + mariadb + cockroach) | ✅ (mongo)                | ✅ (postgres + pglite)    |
| Security (SQLi/NoSQLi, mass assignment, XSS, allowlist) | ✅ `security.e2e.spec.ts`                    | ✅ `security.e2e.spec.ts` | ✅ `security.e2e.spec.ts` |
| Policy / authz (ADR-0037)                               | ✅ `policy.e2e.spec.ts`                      | ❌                        | ❌                        |
| Array-mutation resource routes                          | ✅ `array-mutation-resource.e2e.spec.ts`     | ❌                        | ❌                        |
| Pagination + caching (ETag)                             | ✅ `pagination-caching.e2e.spec.ts`          | ❌                        | ❌                        |
| Realtime (SSE)                                          | ✅ `realtime.e2e.spec.ts`                    | ❌                        | ❌                        |
| Multi-driver variants                                   | ✅ (4 drivers)                               | ⚠️ 1 driver               | ✅ (2 drivers)            |
| Concurrent-write race behavior                          | ✅ `concurrency.e2e.spec.ts` (new)           | ❌                        | ❌                        |

`nest-mongoose` and `nest-mikroorm` now carry the same security coverage as
`nest-typeorm` (identifier + value-position injection, mass assignment, and
stored-XSS-payload safety — adapted per store: SQL injection for the two SQL
backends, NoSQL operator injection for Mongo). They still lack
policy/pagination-caching/array-mutation/realtime/concurrency/perf coverage
— that's either a real gap or an intentional "one reference app carries the
deep feature coverage" choice that should be written down somewhere (a
short note in `CLAUDE.md` or the relevant ADR) rather than left implicit.

**Finding from writing the Mongoose security suite:** a nested-object value
in the operator position (`filter[title][eq][$ne]=`) is not rejected at
query-validation time. It reaches `@kavo/mongoose`'s driver call, which
throws a Mongoose cast error, surfacing as `500 KAVO_PERSISTENCE_FAILED`
instead of `400 KAVO_QUERY_INVALID`. Not an actual injection — the driver
refuses the malformed query, nothing is bypassed — but attacker-controlled
input reaching the persistence layer unvalidated is exactly the shape
`kavo-security-auditor`'s allowlist-bypass check exists to catch, just one
step further down the pipeline (value _shape_ validation, not value
_content_). Pinned as a known-behavior test in
`examples/nest-mongoose/tests/security.e2e.spec.ts` rather than fixed here —
fixing it means deciding where operator-value scalar-shape validation
belongs in `packages/core/src/query/`, which is its own change.

---

## Priority order for follow-up issues

1. ~~`examples/nest-prisma` has no tests~~ — **not a real gap**; see the
   Part 3 correction above. No such example app exists in this repo.
2. **Concurrent-write race test** — done,
   `examples/nest-typeorm/tests/concurrency.e2e.spec.ts`.
3. **N+1 / query-count regression test** — done,
   `packages/orms/typeorm/tests/n-plus-one.spec.ts` (adapter-level, not an
   example app: query counting needs a real `DataSource` logger, and the
   batching logic under test lives in the adapter, not in any one example).
4. **Decide and document**: is `nest-typeorm` deliberately the only example
   app carrying security/policy/array-mutation/pagination-caching/realtime/
   concurrency/perf coverage, or should that be mirrored (at least
   partially) into `nest-mongoose` / `nest-mikroorm`?
5. **Bulk operations** — thin coverage (2 files) relative to how much
   surface `bulk` config covers.
6. **Fuzz/property-based testing** — no generator-based suite exists;
   `query-normalizer.spec.ts`'s hand-picked edge cases are the closest thing.
7. **Load/stress testing** — no throughput baseline exists; likely out of
   scope for `pnpm check` but worth a documented decision either way.

Each of the above should become its own `/issue` when picked up, rather than
one large one — they touch different packages and have independent
acceptance criteria.
