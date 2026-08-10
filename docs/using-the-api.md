# Using the generated API

[Getting started](/getting-started) shows the routes `@Kavo()` generates. This page is how to actually call them as a client: the query-string grammar for filtering, sorting, pagination, field selection, and includes, plus the shape of an error response.

## Filtering

```
GET /books?filter[title][eq]=Dune
```

`filter[<field>][<operator>]=<value>`. Multiple `filter[...]` params AND together implicitly, and multiple operators on the same field also AND:

```
GET /books?filter[pages][gte]=200&filter[pages][lt]=500
```

| Operator              | Wire token   | Example                                            |
| --------------------- | ------------ | -------------------------------------------------- |
| Equals                | `eq`         | `filter[status][eq]=active`                        |
| Not equals            | `ne`         | `filter[status][ne]=banned`                        |
| Greater/equal         | `gt` / `gte` | `filter[age][gte]=18`                              |
| Less/equal            | `lt` / `lte` | `filter[age][lt]=65`                               |
| In list               | `in`         | `filter[status][in]=active,pending`                |
| Not in list           | `notIn`      | `filter[role][notIn]=bot,test`                     |
| Like                  | `like`       | `filter[name][like]=%25john%25`                    |
| Case-insensitive like | `ilike`      | `filter[name][ilike]=%25john%25`                   |
| Between               | `between`    | `filter[createdAt][between]=2026-01-01,2026-06-01` |
| Is null               | `isNull`     | `filter[deletedAt][isNull]=true`                   |
| Is not null           | `isNotNull`  | `filter[deletedAt][isNotNull]=true`                |

Wire tokens are exact-case (`gte`, not `GTE`) — a misspelled or wrong-case operator is a 400, not silently ignored. `like`/`ilike` never auto-wrap wildcards; pass `%` yourself, and escape any literal `%`/`_` in the value with a backslash. Both apply to string columns only.

`in`/`notIn` also accept the repeated-key form instead of a comma list, which is friendlier to URL-building libraries:

```
GET /books?filter[status][in][]=active&filter[status][in][]=pending
```

`between` takes exactly two comma-separated bounds. `isNull`/`isNotNull` are boolean-valued — `isNull=false` means the same thing as `isNotNull=true`, so pick whichever reads better.

Only fields on the entity's `filterable` allowlist can be filtered on — see [Configuration](/integrations/nest/configuration#allowlists) for how to configure that list. Anything outside it is a 400, never a silent no-op.

**OR / NOT / nested logic** uses the same bracket grammar and can be nested arbitrarily deep (up to `query.maxFilterDepth`, default 3):

```
GET /books?filter[or][0][author][eq]=Tolkien&filter[or][1][author][eq]=Herbert
GET /books?filter[not][status][eq]=banned
```

For anything the bracket grammar gets awkward at, `filter` also accepts one JSON-encoded value as a full-power escape hatch. It parses into exactly the same filter tree as the bracket form, so the two are interchangeable — and if both are present on a request, they AND together:

```
GET /books?filter={"or":[{"author":{"eq":"Tolkien"}},{"not":{"status":{"eq":"banned"}}}]}
```

**Relation-path filtering** uses dot notation and restricts root rows without loading the related collection — it never filters _what's inside_ an included relation, only which root rows come back:

```
GET /books?filter[author.country][eq]=UK
```

**Limits** guard every request, configurable per scope: `query.maxFilterDepth` (default 3) caps how deeply `or`/`not` can nest, `query.maxInValues` (default 100) caps `in`/`notIn` array length, and `pagination.maxLimit` (default 100) caps page size. Filter/sort/fields/pagination violations on one request are collected together and reported in a single response — see [Errors](#errors) below.

## Sorting

```
GET /books?sort=-publishedAt,title
```

Comma-separated field list, `-` prefix for descending, order = priority order. Only fields on the `sortable` allowlist are usable. If a request supplies no `sort` at all, the entity's configured `query.defaultSort` (if any) applies — a client-supplied `sort` always wins outright over that default rather than merging with it.

## Pagination

```
GET /books?limit=20&offset=40
```

The default strategy is flat `limit`/`offset` (0-based) — the same field names the response envelope reports back, so request and response mirror each other. A missing `limit` falls back to `pagination.defaultLimit`; a `limit` above `pagination.maxLimit` is clamped, not rejected.

A 1-indexed page-based alternative is also built in — `page[number]`/`page[size]` — for entities configured to use it (see [Configuration](/integrations/nest/configuration)). It normalizes to the same `limit`/`offset` internally, so the response envelope always reports `limit`/`offset` either way.

### Cursor (keyset) pagination

```
GET /books?limit=20
GET /books?limit=20&cursor=WzE3MTIzNDU2Nzg5LDQyXQ
```

For entities configured with `pagination.strategy: "cursor"`, a page is defined by the row it continues _after_ rather than by a count of rows to skip. Given a matching index (see below) that makes fetching a page `O(limit)` however deep it is, and stable while rows are being inserted and deleted — offset paging can skip or repeat a row when the data shifts underneath it.

The next page's token comes back as **`meta.nextCursor`**, and is `null` on the last page:

```json
{
  "items": [{ "id": 41, "title": "Dune" }],
  "limit": 20,
  "offset": 0,
  "total": 137,
  "meta": { "nextCursor": "WzE3MTIzNDU2Nzg5LDQyXQ" }
}
```

Pass it straight back as `?cursor=…` to get the next page, and keep every other parameter (`sort`, `filter`, `include`, `fields`) identical.

Things to know:

- **A cursor is opaque.** It encodes the previous page's last row projected onto the effective sort. Do not parse it, construct one, or store it as a permanent bookmark — the encoding is an implementation detail and may change. It is _not_ signed and is not a security boundary: everything inside it is a comparison value against a field the client can already filter on, so forging one grants nothing `filter[…]` does not.
- **The sort must end in the id field.** Keyset paging needs a total order, so `sort` (or the entity's `query.defaultSort`) has to end in the entity's primary key: `?sort=-createdAt,id`. A request without one is a 400 naming the field it needs. The sort keys must also be plain scalar columns of the entity — not relation paths, and not JSON columns.
- **Every cursor sort key must be filterable and selectable too,** not just sortable. A cursor turns each sort key into a filter comparison and reads its value off the raw row into `meta.nextCursor`, so a field that is on `allowlists.sortable` but missing from `allowlists.filterable` or `allowlists.selectable` is rejected with a 400 rather than quietly dropped from the sort. If you narrow one of the three allowlists, narrow all three the same way for any column you intend to page by.
- **A bad cursor is a 400,** exactly like a malformed `page[number]`: `KAVO_QUERY_INVALID` with a `cursor` issue. That includes a token from a _different_ sort, which is why changing `sort` means starting from the first page again.
- **`offset` is always `0`** on a cursor page. A keyset page knows what comes after a row, not how many rows precede it; the field stays in the envelope because the envelope's shape is fixed. `total` is unaffected — it still counts the whole match set, and still respects `pagination.count`.
- **You need a matching composite index.** Keyset paging is only `O(limit)` against an index covering the sort tuple **in that exact column order and with those directions** — `(created_at DESC, id ASC)` for `?sort=-createdAt,id`. Kavo never owns your schema, so it cannot create it for you. Without one, every page sorts the whole match set; on MongoDB an unindexed large sort does not merely get slow, it exceeds the 32 MB in-memory sort limit and returns an error.
- **Turn `pagination.count` off.** It defaults to `true`, so an out-of-the-box cursor page is the cheap keyset select _plus_ a `COUNT(*)` over the entire match set — which is `O(n)` and dominates everything the cursor just saved. `total` is the one thing keyset paging cannot make cheap, so pair `strategy: "cursor"` with `count: false` unless you genuinely need the number.

Two things cursor pagination does **not** support:

- **Nullable sort keys.** A cursor cannot resume from a `null`, and which way it fails depends on where your database sorts NULLs. When they sort _first_, a page boundary landing on a null-keyed row returns a 400 naming the column. When they sort _last_ — PostgreSQL's default for `ASC`, sqlite's for `DESC` — the null-keyed rows are **silently omitted from every page**: no error, `meta.nextCursor` goes to `null` as if you had reached the end, and `total` still counts the rows you never saw. Sort only on columns that are never null.
- **`bigint` and decimal columns**, including as the primary key. Their runtime representation disagrees with the column type Kavo derives from your ORM (a JS `bigint`, a `Decimal` object, or a string depending on the ORM), which a page token cannot round-trip. Kavo raises a configuration error naming the column rather than paging incorrectly.

Finally, the **GraphQL and MCP bindings cannot page a cursor- or since-configured entity.** Both expose `limit`/`offset` only, and a keyset page ignores `offset`, so binding one would answer every paged query with the first page (or, under `since`, everything from the beginning). They refuse at bootstrap with a configuration error instead. Page those entities over REST, or give them an entity-scope `pagination.strategy` of `"offset"`/`"page"`.

### Since (seek-by-timestamp) pagination

```
GET /books?limit=20
GET /books?limit=20&since=2024-03-01T10:00:00.000Z%7C41
```

For entities configured with `pagination.strategy: "since"`, a page is defined by "everything after this boundary" against one configured column (`pagination.since.field`, default `"updatedAt"`) — a polling/sync shape, not a bounded traversal.

The next poll's value comes back as **`meta.nextSince`**:

```json
{
  "items": [{ "id": 41, "title": "Dune", "updatedAt": "2024-03-01T10:00:00.000Z" }],
  "limit": 20,
  "offset": 0,
  "total": 137,
  "meta": { "nextSince": "2024-03-01T10:00:00.000Z|41" }
}
```

Pass it straight back as `?since=…` on the next poll.

Things to know:

- **A since value is plain, not opaque, but compound.** It is the boundary column's own value plus the row's id, joined by `|` — `2024-03-01T10:00:00.000Z|41`. The id is what makes paging exactly-once even when several rows share the same boundary value; unlike a cursor's token you can still read it, or construct one by hand from a row you already have.
- **The sort is forced, not chosen.** Every request is ordered by `[since.field, idField]` ascending regardless of any `sort` you send — sending one is a 400, not a silent override. `since.field` must be a `date`- or `string`-kind column (a plain `number`, including an auto-increment id, does not qualify), and — like a cursor sort key — it and `idField` must both be on the `filterable` and `selectable` allowlists as well as `sortable`. Unlike cursor pagination's rules, these are all checked at startup: since the sort is entirely config-known, a misconfigured `since.field` fails immediately rather than on the first request.
- **Paging is exactly-once**, the same guarantee cursor pagination gives — no row is skipped or repeated, even when many rows share one `since.field` value.
- **`nextSince` advances even on a partial page.** If a poll asks for 100 rows and only 12 exist, `nextSince` still moves past those 12 — unlike `nextCursor`, it does not wait for a full page, because there is no "last page" in a poll to wait for. A genuinely caught-up poll gets back `items: []` and its own `since` echoed back rather than `null` — there is no "last page" to signal the end of.
- **`offset` is always `0`,** the same reason a cursor page reports it. `total` is unaffected.
- **You need a matching composite index**, covering `(since.field, id)` in that order — the same requirement cursor pagination has, for the same reason.
- **Turn `pagination.count` off** for the same cost reason cursor pagination recommends it.

## Field selection

```
GET /books?fields=id,title
```

Sparse fieldset for the root resource, validated against the `selectable` allowlist. Narrow an included relation the same way: `fields[author]=id,name`.

`selectable` also decides what a response carries when no `fields=` is sent, so it is the one place to keep a column out of every response — see [Allowlists](/integrations/nest/configuration#allowlists).

## Computed fields

A response can carry fields that have no database column behind them — a `fullName` built from two columns, a formatted total, a flag that depends on who is asking. They are declared once on the entity's config:

```ts
@Kavo(Book, {
  computed: {
    displayTitle: { resolve: (book) => (book.title === null ? null : `${book.title} (${book.year})`) },
  },
})
```

```
GET /books/1     → { "id": 1, "title": "Dune", "year": 1965, "displayTitle": "Dune (1965)" }
GET /books?fields=id,displayTitle
```

From a client's point of view a computed field is an ordinary field: it is in the default response, it can be selected with `fields=`, and it can be narrowed away by an `item`/`list` DTO. Three things it is not:

- **not filterable or sortable** — `filter[displayTitle][eq]=…` and `sort=displayTitle` are a 400, because there is no column to translate to `WHERE`/`ORDER BY`. Filter and sort on the underlying columns instead (`sort=title`);
- **not writable** — sending one in a `POST`/`PUT`/`PATCH` body is silently ignored, like any other non-writable key (a server-side `create`/`update`/`patch` DTO that _declares_ one is a startup error rather than a silent drop);
- **not database-side** — it is evaluated after the row is fetched, so it costs no extra query but also cannot make one cheaper.

The one thing worth knowing on the server side: `resolve` must handle every value its columns can hold. It runs per served row with nothing catching it, so a single row it cannot handle turns a whole list response into a 500 — write `book.title?.toUpperCase() ?? null`, not `book.title.toUpperCase()`, against a nullable column.

A computed field declared on a related entity shows up when that relation is included (`?include=author`), resolved from the related entity's own config. See [Configuration](/integrations/nest/configuration#computed) for the descriptor's options and [ADR-0019](/internals/adr/0019-computed-fields-are-serializer-evaluated) for why the three limits are permanent rather than pending.

## Includes

```
GET /books?include=author,reviews.user
```

Comma-separated dot-paths, merged into one tree. Only relations the entity marks `includable` (see [Configuration](/integrations/nest/configuration#relations)) can appear here — an un-includable or misspelled relation is a 400.

## Soft-deleted rows

```
GET /books?withDeleted=true
```

Opts back into seeing soft-deleted rows on a read that would otherwise exclude them. `?onlyDeleted=true` narrows the other way — only soft-deleted rows, for a "trash" view. Both are rejected outright on an entity that isn't soft-deletable, and setting both together is rejected as a conflicting combination, rather than either being silently ignored — see [Getting started's soft delete section](/getting-started#soft-delete).

## The response envelope

A list response (`GET /books`) always has the same shape:

```json
{
  "items": [{ "id": 1, "title": "Dune" }],
  "limit": 20,
  "offset": 0,
  "total": 1
}
```

`total` is `null` (and its `COUNT` query skipped) if `pagination.count` is turned off. The key is always present — a list always answers "how many matched", so configuration changes the value, never the shape.

One optional fifth key can join them. `meta` is an open bag for anything the API wants to say about the list that isn't a row: a facet count, a "results are approximate" flag, the next cursor or since value. It appears when the entity's `findMany` handler puts something there — see [custom list metadata](/integrations/nest/configuration#custom-list-metadata) for how — or under [cursor pagination](#cursor-keyset-pagination) or [since pagination](#since-seek-by-timestamp-pagination), which contribute `nextCursor`/`nextSince` and are the keys Kavo writes itself. A response with nothing to report has no `meta` key at all rather than an empty `{}`, so read it as `body.meta?.facets`. Nothing in the bag is projected, filtered, or renamed on the way out: what the handler returns is what the client receives.

## ETags and conditional requests

Every single-item response — `POST /books`, `GET /books/1`, `PUT`, `PATCH`, and `PATCH /books/1/restore` — carries a strong `ETag`:

```
ETag: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
```

It is a hash of the exact representation being returned, so it changes whenever any field in the response does. List responses (`GET /books`) do not carry one.

### `If-None-Match` — skip a body you already have

```
GET /books/1
If-None-Match: "9f86d0…"
```

If your copy is still current you get `304 Not Modified` with an empty body and the same `ETag`. If it isn't, you get the ordinary `200` and a fresh tag. `*` matches any existing representation.

### `If-Match` — don't overwrite a version you never saw

```
PATCH /books/1
If-Match: "9f86d0…"
```

Supported on every route that targets one book: `PUT /books/1`, `PATCH /books/1`, `DELETE /books/1`, and the soft-delete routes `PATCH /books/1/restore` and `DELETE /books/1/purge`. If the book's current tag is one you named, the write goes ahead and the response carries the new tag. If it isn't — somebody else changed the book since you read it — the write is refused with `412 Precondition Failed` and a `KAVO_PRECONDITION_FAILED` problem document naming the current tag, and **nothing is written**. `*` matches any existing representation, so `If-Match: *` means "only if it still exists".

For restore and purge, the tag to send is the one from `GET /books/1?withDeleted=true` — a soft-deleted book is what those routes act on, and an ordinary `GET /books/1` will not show it to you.

If the book doesn't exist at all, or is in a state the route refuses, you get that route's own error rather than a `412`: `404` for a book that isn't there, `409 KAVO_ALREADY_DELETED` for `DELETE` on one that is already soft-deleted. Sending a conditional header never changes which error you get, only whether the write happens.

### `If-Match` where Kavo can't check it

Kavo refuses rather than quietly proceeds. A `412 KAVO_PRECONDITION_UNSUPPORTED` means the header was understood and the write did **not** happen, but the guard could not be evaluated at all — so retrying it unchanged will not help. Three ways to see it:

- **On a route that doesn't target one row** — `POST /books`, and any custom operation you add. Kavo knows what row `PATCH /books/1` is about; it cannot know what a custom `POST /books/1/publish` is about.
- **When [`caching.etag`](/integrations/nest/configuration#caching) is off** for that route, at any scope. No tags are issued, so there is nothing to compare — and answering `200` would tell you a guard was applied when none was.
- **When `findOne` is disabled** on the entity. The check compares against the representation `GET /books/1` would return; with no such route there is none.

`If-Match` on a `GET` is the one case Kavo ignores instead of refusing: a read cannot overwrite anything, and `If-None-Match` above is the read-side conditional.

**A hand-written or `@Override`'d route enforces nothing by itself.** The check runs inside Kavo's engine, so a controller method you wrote replaces it along with everything else — it receives the `If-Match` tokens as its last parameter and must pass them on (`this.base.updateOne(id, data, { preconditions })`) for the guard to apply. See [`caching`](/integrations/nest/configuration#caching).

### Two things to know

**The `If-Match` check is not atomic.** Kavo reads the row, compares the tag, and then writes. There is a real window between the check and the write in which another writer can slip in — so this narrows the last-write-wins race, it does not eliminate it. It is not a database-level compare-and-swap, and Kavo does not claim to be one. If you need that guarantee, enforce it in your own transaction.

**An `If-Match` token has to come from an unnarrowed read.** An ETag identifies one _representation_, so `GET /books/1?fields=title` produces a different tag from `GET /books/1`. Preconditions are evaluated against the full default representation, so a tag taken from a `fields=`- or `include=`-narrowed read will 412. Use the tag from a plain `GET /books/1`. The tag on a write response works too — it is the tag of the body you just got back — but only while that body is the same representation a plain `GET` returns, which stops being true once a relation is configured `defaultInclude`: a write resolves no query, so write responses never carry relations. On such an entity, take the token from a `GET`.

Both halves are one setting, [`caching.etag`](/integrations/nest/configuration#caching) (on by default). Turning it off at any scope stops the tags being generated _and_ stops the conditional headers being honored.

## Errors

Every error response is an [RFC 9457 problem-details](https://www.rfc-editor.org/rfc/rfc9457) document, `Content-Type: application/problem+json`:

```json
{
  "type": "https://kavo.dev/errors/kavo-not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "Book with id 999 was not found.",
  "instance": "urn:kavo:request:a1b2c3d4",
  "code": "KAVO_NOT_FOUND"
}
```

A query-validation failure additionally carries an `errors[]` array, so a client can fix every problem with its request in one round trip instead of one at a time:

```json
{
  "type": "https://kavo.dev/errors/kavo-query-invalid",
  "title": "Bad Request",
  "status": 400,
  "detail": "The request query is invalid.",
  "code": "KAVO_QUERY_INVALID",
  "errors": [{ "code": "KAVO_QUERY_INVALID_FIELD", "detail": "'nickname' is not a filterable field." }]
}
```

The most common codes:

| Code                   | HTTP | Fires when                                              |
| ---------------------- | ---- | ------------------------------------------------------- |
| `KAVO_QUERY_INVALID`   | 400  | Any filter/sort/select/pagination violation (aggregate) |
| `KAVO_NOT_FOUND`       | 404  | Target row missing on a get/update/patch/delete         |
| `KAVO_CONFLICT`        | 409  | A unique or foreign-key violation                       |
| `KAVO_ALREADY_DELETED` | 409  | Soft-deleting a row that's already deleted              |
| `KAVO_NOT_DELETED`     | 409  | Restoring or purging a row that isn't deleted           |

Driver-level detail (raw SQL error text, stack info) never leaks into `detail` unless `errors.exposeInternals` is turned on — keep it off in production. See [Error handling](/internals/architecture/06-error-handling) for the full exception hierarchy and code catalog.
