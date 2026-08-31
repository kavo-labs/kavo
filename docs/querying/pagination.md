# Pagination

```http
GET /books?limit=20&offset=40
```

The default strategy is flat `limit`/`offset`, 0-based. The response envelope reports back the same field names, so request and response mirror each other. A missing `limit` falls back to `pagination.defaultLimit`. A `limit` above `pagination.maxLimit` gets clamped, not rejected.

A 1-indexed, page-based alternative is also built in: `page[number]`/`page[size]`, for entities configured to use it (see [Settings](/guides/configuration/settings#pagination)). It normalizes to the same `limit`/`offset` internally, so the response envelope always reports `limit`/`offset` either way.

## No pagination

```http
GET /countries
```

For entities configured with `pagination.strategy: "none"`, `findMany` always serves the whole match set. This is the escape hatch for a resource that should never be paginated, like a small lookup table. There's no configured ceiling to raise: `defaultLimit` and `maxLimit` go unused entirely under this strategy.

A few things to know:

- Sending `limit` or `offset` is rejected, not ignored: a 400 (`KAVO_QUERY_UNSUPPORTED_PARAM`) naming the param. A client that thinks it's getting a page should be told it isn't.
- The envelope's `limit` field isn't a real page size. The response shape is fixed (`items`, `limit`, `offset`, `total`, `meta`), so `limit` still has to report something. It reports `2147483647` (`2^31 - 1`, the largest value every consumer in the workspace can carry without its own ceiling). Read `items.length` for the actual count returned. `offset` is always `0`.
- `total` still respects `pagination.count`, the same as every other strategy. `count: false` still turns the extra `COUNT` query off.
- Kavo never owns your schema. Nothing here warns you when a table configured this way has grown past what one response should reasonably carry. That judgment call is yours.
- Everything else composes normally. `filter`, `sort`, `include`, and `search` all work exactly as they do under `offset`. Only `limit`/`offset` are off the table.

## Cursor (keyset) pagination

```http
GET /books?limit=20
GET /books?limit=20&cursor=WzE3MTIzNDU2Nzg5LDQyXQ
```

For entities configured with `pagination.strategy: "cursor"`, a page is defined by the row it continues after, rather than by a count of rows to skip. Given a matching index (see below), that makes fetching a page `O(limit)` no matter how deep it is, and stable while rows are being inserted and deleted. Offset paging, by contrast, can skip or repeat a row when the data shifts underneath it.

The next page's token comes back as `meta.nextCursor`, and is `null` on the last page:

```json
{
  "items": [{ "id": 41, "title": "Dune" }],
  "limit": 20,
  "offset": 0,
  "total": 137,
  "meta": { "nextCursor": "WzE3MTIzNDU2Nzg5LDQyXQ" }
}
```

Pass it straight back as `?cursor=…` to get the next page, and keep every other parameter (`sort`, `filter`, `include`, `select`) identical.

### Things to know

**A cursor is opaque.** It encodes the previous page's last row projected onto the effective sort. Don't parse it, construct one, or store it as a permanent bookmark: the encoding is an implementation detail and may change. It's not signed and isn't a security boundary. Everything inside it is a comparison value against a field the client can already filter on, so forging one grants nothing that `filter[…]` doesn't already.

**The sort must end in the id field.** Keyset paging needs a total order, so `sort` (or the entity's `query.defaultSort`) has to end in the entity's primary key, like `?sort=-createdAt,id`. A request without one is a 400 naming the field it needs. The sort keys must also be plain scalar columns of the entity, not relation paths and not JSON columns.

**Every cursor sort key must be filterable and selectable too, not just sortable.** A cursor turns each sort key into a filter comparison, and reads its value off the raw row into `meta.nextCursor`. So a field on `allowlists.sortable` but missing from `allowlists.filterable` or `allowlists.selectable` gets rejected with a 400 rather than quietly dropped from the sort. If you narrow one of the three allowlists, narrow all three the same way for any column you page by.

**A bad cursor is a 400**, exactly like a malformed `page[number]`: `KAVO_QUERY_INVALID` with a `cursor` issue. That includes a token from a different sort, which is why changing `sort` means starting from the first page again.

**`offset` is always `0`** on a cursor page. A keyset page knows what comes after a row, not how many rows precede it. The field stays in the envelope because the envelope's shape is fixed. `total` is unaffected: it still counts the whole match set, and still respects `pagination.count`.

**You need a matching composite index.** Keyset paging is only `O(limit)` against an index covering the sort tuple in that exact column order and direction, for example `(created_at DESC, id ASC)` for `?sort=-createdAt,id`. Kavo never owns your schema, so it can't create the index for you. Without one, every page sorts the whole match set. On MongoDB, an unindexed large sort doesn't merely get slow: it exceeds the 32 MB in-memory sort limit and returns an error.

**Turn `pagination.count` off.** It defaults to `true`, so an out-of-the-box cursor page runs the cheap keyset select plus a `COUNT(*)` over the entire match set, which is `O(n)` and dominates everything the cursor just saved. `total` is the one thing keyset paging can't make cheap, so pair `strategy: "cursor"` with `count: false` unless you genuinely need the number.

### What cursor pagination doesn't support

**Nullable sort keys.** A cursor can't resume from a `null`, and which way it fails depends on where your database sorts NULLs. When they sort first, a page boundary landing on a null-keyed row returns a 400 naming the column. When they sort last (PostgreSQL's default for `ASC`, SQLite's for `DESC`), the null-keyed rows are silently omitted from every page: no error, `meta.nextCursor` goes to `null` as if you'd reached the end, and `total` still counts the rows you never saw. Sort only on columns that are never null.

**`bigint` and decimal columns**, including as the primary key. Their runtime representation disagrees with the column type Kavo derives from your ORM (a JS `bigint`, a `Decimal` object, or a string, depending on the ORM), which a page token can't round-trip. Kavo raises a configuration error naming the column rather than paging incorrectly.

**A database-defaulted date column, on SQLite.** SQLite stores a date as text and compares it as text, so one column can hold two spellings of the same instant. A SQL default (what TypeORM's `@CreateDateColumn` becomes) is written by SQLite itself as `2026-08-10 14:51:07`, while the driver binds a JS `Date` as `2026-08-10 14:51:07.000`. The shorter string compares below the longer one, so the keyset re-selects rows the previous page already served, the page doesn't advance, and the second request fails with a configuration error rather than looping forever. On SQLite, page by a date column your own application writes on every row. PostgreSQL and MySQL store dates as a real type and aren't affected.

## Since (seek-by-timestamp) pagination

```http
GET /books?limit=20
GET /books?limit=20&since=2024-03-01T10:00:00.000Z%7C41
```

For entities configured with `pagination.strategy: "since"`, a page is defined as "everything after this boundary," against one configured column (`pagination.since.field`, default `"updatedAt"`). This is a polling or sync shape, not a bounded traversal.

The next poll's value comes back as `meta.nextSince`:

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

### Things to know

**A since value is plain, not opaque, but compound.** It's the boundary column's own value plus the row's id, joined by `|`, for example `2024-03-01T10:00:00.000Z|41`. The id is what makes paging exactly-once even when several rows share the same boundary value. Unlike a cursor's token, you can still read it, or construct one by hand from a row you already have.

**The sort is forced, not chosen.** Every request is ordered by `[since.field, idField]` ascending regardless of any `sort` you send; sending one is a 400, not a silent override. `since.field` must be a `date`- or `string`-kind column (a plain `number`, including an auto-increment id, doesn't qualify), and, like a cursor sort key, it and `idField` must both be on the `filterable` and `selectable` allowlists as well as `sortable`. Unlike cursor pagination's rules, these are all checked at startup: since the sort is entirely config-known, a misconfigured `since.field` fails immediately rather than on the first request.

**Paging is exactly-once**, the same guarantee cursor pagination gives: no row is skipped or repeated, even when many rows share one `since.field` value.

**`nextSince` advances even on a partial page.** If a poll asks for 100 rows and only 12 exist, `nextSince` still moves past those 12. Unlike `nextCursor`, it doesn't wait for a full page, because there's no "last page" in a poll to wait for. A genuinely caught-up poll gets back `items: []` and its own `since` echoed back, rather than `null`.

**`offset` is always `0`**, for the same reason a cursor page reports it. `total` is unaffected.

**You need a matching composite index**, covering `(since.field, id)` in that order. This is the same requirement cursor pagination has, for the same reason.

**Turn `pagination.count` off** for the same cost reason cursor pagination recommends it.

## GraphQL and MCP

The GraphQL and MCP bindings can't page a cursor- or since-configured entity. Both expose `limit`/`offset` only, and a keyset page ignores `offset`, so binding one would answer every paged query with the first page (or, under `since`, everything from the beginning). They refuse at bootstrap with a configuration error instead. Page those entities over REST, or give them an entity-scope `pagination.strategy` of `"offset"` or `"page"`.
