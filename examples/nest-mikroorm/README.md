# nest-mikroorm

The same Pet domain as [`nest-typeorm`](../nest-typeorm) — single-table
inheritance (`Cat`/`Dog` over one `pet` table), an `Owner` relation both ways, a
one-to-one `Address`, and a many-to-many `Tag` edge — served over HTTP by the
real stack: `@Kavo(...)`-generated NestJS routes → CRUD engine →
`@kavo/mikroorm` → a real database, with filtering, sorting, pagination, DTO
projections (`item` vs. leaner `list`), layered config, Swagger docs, and RFC
9457 problem-details errors.

Running the _same domain_ under a different adapter is the point. Where this app
behaves identically to `nest-typeorm`, that is the seam doing its job; where it
differs, the difference is real and worth seeing.

```bash
pnpm --filter @kavo/example-nest-mikroorm start
# → http://localhost:3002/cats   (Swagger at /docs)
```

It runs on in-memory SQLite by default, so there is nothing to install. Set
`PGDATABASE` (plus the usual `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`) to point
it at a Postgres instead:

```bash
docker run --rm -e POSTGRES_PASSWORD=kavo -p 5432:5432 postgres:18-alpine
PGDATABASE=postgres PGPASSWORD=kavo pnpm --filter @kavo/example-nest-mikroorm start
```

Unlike `nest-typeorm`, this app has no CockroachDB flavour: MikroORM has no
dedicated CockroachDB driver, and pointing `@mikro-orm/postgresql` (which
runs on `knex`) at Cockroach's Postgres-wire-compatible port doesn't work —
`knex`'s Postgres dialect runs `SELECT version()` on every new connection
and regex-parses the result to detect the server version; CockroachDB's
version string doesn't match that pattern, so the parse returns `null` and
the connection pool throws on every acquire. That's a `knex`/CockroachDB
incompatibility, not something this app's wiring can work around.

## What differs from `nest-typeorm`

**Soft delete is declared, not inferred.** `Owner` is soft-deletable in both
apps, but TypeORM's `@DeleteDateColumn` says so on the entity, and MikroORM has
no equivalent — its soft-delete pattern is a user-defined `@Filter`, which is a
query concern rather than a column declaration. So `deletedAt` is an ordinary
nullable property and `OwnerController` names it through `softDelete.field`.
That one config line is what enables soft delete _and_ what puts
`PATCH /owners/:id/restore` on the router.

It also means the marker is not automatically un-writable, which is why every
`Owner` DTO slot omits `deletedAt` and every allowlist excludes it. With
`purgeOne` enabled, a stampable marker would be a path to a permanent delete —
see doc 17 §7, and the e2e test that pins it down.

**Relation paths are filterable and sortable.** `filter[owner.name][eq]=Ada` and
`sort=-owner.name` work here, because MikroORM nests a relation path in its own
query language and adds the join itself. (`@kavo/mongoose` refuses the same
query outright.) It is still an allowlist decision, independent of whether the
relation may be included.

**Relations are declared by name, not by class.** `@ManyToOne((): any => "Owner")`
rather than `@ManyToOne(() => Owner)`, with a type-only import alongside — the same
reason `nest-typeorm`'s entities use TypeORM's string targets. A value import
both ways would make `Owner`↔`Pet` a runtime import cycle, which
`.dependency-cruiser.cjs`'s `no-circular` rule forbids. The adapter resolves the
target class off MikroORM's `targetMeta` either way. The `(): any =>` return
type is required as of MikroORM v7: its decorator types no longer accept a
bare string, only a thunk resolving to an entity class or `EntitySchema` — a
string target still works at runtime, but only passes type-checking with
`any` as the thunk's declared return type.

**There is no second entity registry.** `createInfrastructure` takes the
`MikroORM` instance itself, and the instance already carries its entity
metadata — so unlike `nest-typeorm` there is no `DatabaseModule` assembling a
`DataSource`, and unlike `@kavo/prisma` there are no marker classes.

It takes the ORM instance rather than an `EntityManager` on purpose: every
adapter operation forks its own manager, which is the isolation a request-scoped
`RequestContext` would otherwise give. This app needs no MikroORM middleware.

**`AddressController` is plain CRUD here.** `nest-typeorm`'s version is the
reference for `@Override` and fully custom routes; that machinery belongs to
`@kavo/nest` rather than to any adapter, so repeating it would add bulk without
exercising anything MikroORM-specific.

## The e2e suites

All three suites run the same assertions — `tests/crud-e2e.suite.ts` holds
them, and each spec differs only in which database it points the app at. One
behavioral spec, three drivers, no forked assertions (the same split
`nest-typeorm` uses).

| Spec                                    | Database                                              |
| --------------------------------------- | ----------------------------------------------------- |
| `tests/app.e2e.spec.ts`                 | in-memory SQLite — no Docker, nothing to install      |
| `tests/app-postgres.e2e.spec.ts`        | Testcontainers `postgres:18-alpine`                   |
| `tests/app-postgres-pglite.e2e.spec.ts` | PGlite, fronted by `pglite-socket` — no Docker either |

Both Postgres suites exercise `caseInsensitiveFilters: true` — the only place
it's turned on. `ILIKE` maps to MikroORM's `$ilike`, which **only PostgreSQL
supports** — every other driver receives the token verbatim and fails with a
syntax error — so the flag is declared rather than detected, and defaults to
`false`. The PGlite suite exists to get that same real-Postgres
`ILIKE`/SQLSTATE-23505 behavior without a Docker daemon; the Testcontainers
suite remains as the check against an actual `postgres:18-alpine` server.

The suite's ILIKE assertion passes across all three: a real `ILIKE` on both
Postgres flavours, and a degraded `$like` on SQLite, whose own `LIKE` is
already ASCII case-insensitive. That all three hold is exactly the argument
for the `false` default.

```bash
pnpm vitest run examples/nest-mikroorm/tests/app.e2e.spec.ts                  # no Docker
pnpm vitest run examples/nest-mikroorm/tests/app-postgres.e2e.spec.ts         # needs Docker
pnpm vitest run examples/nest-mikroorm/tests/app-postgres-pglite.e2e.spec.ts  # no Docker
```
