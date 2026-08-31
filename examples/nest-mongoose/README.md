# nest-mongoose

A small Blog domain served over HTTP by the real stack — `@Kavo(...)`-generated
NestJS routes → CRUD engine → `@kavo/mongoose` → a real MongoDB — with
filtering, sorting, pagination, DTO projections (`item` vs. leaner `list`),
layered config, Swagger docs, and RFC 9457 problem-details errors. `Author` is
the relation side; `Article` carries a `ref` edge, a scalar array, and
config-declared soft delete.

It is the document-store counterpart to [`nest-typeorm`](../nest-typeorm),
which can only ever prove the SQL path. This app is what shows the same
decorator, engine, and route generation working over MongoDB.

```bash
docker run --rm -p 27017:27017 mongo:8
MONGO_URL=mongodb://127.0.0.1:27017/kavo pnpm --filter @kavo/example-nest-mongoose start
# → http://localhost:3001/articles   (Swagger at /docs)
```

`MONGO_URL` defaults to `mongodb://127.0.0.1:27017/kavo`.

## The e2e suites

Neither suite needs any of the above set up by hand, and both run the same
assertions — `tests/crud-e2e.suite.ts` holds them, and each spec only differs
in how it gets a `mongod` to point the default `mongoose` instance at. One
behavioral spec, two servers, no forked assertions (the same split
`nest-typeorm` uses for SQLite/Postgres/MariaDB).

| Spec                          | Server                                                |
| ----------------------------- | ----------------------------------------------------- |
| `tests/app.e2e.spec.ts`       | `mongodb-memory-server` — standalone, no Docker       |
| `tests/app-mongo.e2e.spec.ts` | Testcontainers `mongo:8` — a real, pinned replica set |

The default suite is the one that runs without Docker: it downloads a `mongod`
binary once and caches it, then runs it against an ephemeral data directory, so
`pnpm vitest run examples/nest-mongoose/tests/app.e2e.spec.ts` exercises the
whole stack on a machine with no daemon. (`pnpm check` as a whole still needs
one — `nest-typeorm`'s Postgres and MariaDB suites have required it since
before this app existed.) What the default suite cannot pin down is the server
the app is actually deployed onto — it is a standalone of whatever version the
tool fetches for the current platform.

So `tests/app-mongo.e2e.spec.ts` self-provisions a pinned `mongo:8` container
via Testcontainers and runs the identical suite against it, exactly the way
`nest-typeorm`'s Postgres and MariaDB suites do. That needs a running Docker
daemon wherever `pnpm check`/`pnpm test` runs. Two details are specific to
MongoDB:

- `MongoDBContainer` always starts a **single-node replica set**, and
  `rs.initiate()` advertises that member under the container's own hostname.
  The test connects with `directConnection: true` so the driver keeps talking
  to the mapped port instead of chasing that unroutable address —
  `getConnectionString()` does not set it.
- Unique indexes are only enforced once they exist, and Mongoose builds them
  in the background after connecting. The shared suite awaits `Model.init()`
  before asserting that a duplicate `Author.email` is a 409, so the assertion
  cannot race the index into existence on a cold database.

## What's different from the TypeORM app

Notice how much less wiring `AppModule` needs than `nest-typeorm`'s
`AppModule` + `DatabaseModule`: there is no entity list and no `DataSource`,
because a Mongoose model _is_ the entity identity Kavo wants and
`mongoose.connection` already is the model registry (ADR-0018). Nothing is
declared twice — no marker classes, no mirror of the schema.

Try it:

```
POST   /authors                  {"name":"Ada","email":"ada@x.io"}
POST   /articles                 {"title":"Hello","tags":["intro"],"author":"<author _id>"}
GET    /articles?filter[status][eq]=published&sort=-createdAt
GET    /articles?include=author            # loaded by populate, not a join
GET    /articles?filter[author][eq]=<id>   # the ref path is the foreign key too
DELETE /articles/<id>            # soft delete — `deletedAt` is stamped
GET    /articles?withDeleted=true
PATCH  /articles/<id>/restore
DELETE /articles/<id>/purge      # permanent, and only for an already-deleted doc
```

Ids are MongoDB `_id` values rendered as hex **strings**, so responses are
keyed by `_id` rather than a numeric `id`. Filtering _across_ a relation
(`filter[author.name]`) is refused with a 400 rather than silently matching
nothing — MongoDB resolves dotted paths inside a document, not across a `ref`.

This app's `crud-e2e.suite.ts` deliberately does not reuse `nest-typeorm`'s
same-named suite: that one is written against a numeric `id` and single-table
inheritance, and forking its assertions would hide exactly the difference this
app exists to show.

The app consumes only public package APIs — if it ever needs a deep import,
that is an API-surface bug in the package, not the app.
