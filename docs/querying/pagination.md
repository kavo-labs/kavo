# Pagination

```http
GET /books?limit=20&offset=40
```

The default strategy is flat `limit`/`offset` (0-based) — the same field names the response envelope reports back, so request and response mirror each other. A missing `limit` falls back to `pagination.defaultLimit`; a `limit` above `pagination.maxLimit` is clamped, not rejected.

A 1-indexed page-based alternative is also built in — `page[number]`/`page[size]` — for entities configured to use it (see [Settings](/guides/configuration/settings#pagination)). It normalizes to the same `limit`/`offset` internally, so the response envelope always reports `limit`/`offset` either way.

## Cursor (keyset) pagination

```http
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

Three things cursor pagination does **not** support:

- **Nullable sort keys.** A cursor cannot resume from a `null`, and which way it fails depends on where your database sorts NULLs. When they sort _first_, a page boundary landing on a null-keyed row returns a 400 naming the column. When they sort _last_ — PostgreSQL's default for `ASC`, sqlite's for `DESC` — the null-keyed rows are **silently omitted from every page**: no error, `meta.nextCursor` goes to `null` as if you had reached the end, and `total` still counts the rows you never saw. Sort only on columns that are never null.
- **`bigint` and decimal columns**, including as the primary key. Their runtime representation disagrees with the column type Kavo derives from your ORM (a JS `bigint`, a `Decimal` object, or a string depending on the ORM), which a page token cannot round-trip. Kavo raises a configuration error naming the column rather than paging incorrectly.
- **A database-defaulted date column, on SQLite.** SQLite stores a date as text and compares it as text, so one column can hold two spellings of the same instant: a SQL default (which is what TypeORM's `@CreateDateColumn` becomes) is written by SQLite itself as `2026-08-10 14:51:07`, while the driver binds a JS `Date` as `2026-08-10 14:51:07.000`. The shorter string compares _below_ the longer one, so the keyset re-selects rows the previous page already served, the page does not advance, and the second request fails with a configuration error rather than looping forever. On SQLite, page by a date column your own application writes on every row. PostgreSQL and MySQL store dates as a real type and are unaffected.

Finally, the **GraphQL and MCP bindings cannot page a cursor- or since-configured entity.** Both expose `limit`/`offset` only, and a keyset page ignores `offset`, so binding one would answer every paged query with the first page (or, under `since`, everything from the beginning). They refuse at bootstrap with a configuration error instead. Page those entities over REST, or give them an entity-scope `pagination.strategy` of `"offset"`/`"page"`.

## No pagination

```http
GET /countries
```

For entities configured with `pagination.strategy: "none"`, `findMany` always serves the whole match set — the escape hatch for a resource that should never be paginated, like a small lookup/reference table. There is no configured ceiling to raise: `defaultLimit`/`maxLimit` go unused entirely under this strategy.

Things to know:

- **`limit`/`offset` are rejected, not ignored.** Sending either is a 400 (`KAVO_QUERY_UNSUPPORTED_PARAM`) naming the param — the same "wrong strategy, told, not silently narrowed" treatment `cursor`/`since` params get under any other strategy. A client that thinks it is getting a page should be told it is not.
- **The envelope's `limit` is not a real page size.** The response shape is fixed (`items`, `limit`, `offset`, `total`, `meta`), so `limit` still has to report _something_ — it reports `2147483647` (`2^31 - 1`, the largest value every consumer in the workspace — every SQL `LIMIT`, GraphQL's `Int`, MongoDB's int32 limit — can carry without its own ceiling). Read `items.length` for the actual count returned. `offset` is always `0`.
- **`total` still respects `pagination.count`,** the same as every other strategy — it is not implied by `items.length` being the same number; `count: false` still turns the extra `COUNT` query off.
- **Kavo never owns your schema.** Nothing here warns you when a table this is configured on has grown past what one response should reasonably carry — that judgment call is yours to make when you opt an entity in.
- **Everything else composes normally.** Unlike `cursor`/`since`, this is not a keyset strategy — `filter`/`sort`/`include`/`search` all work exactly as they do under `offset`; only `limit`/`offset` are off the table.

## Since (seek-by-timestamp) pagination

```http
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
- **`nextSince` advances even on a partial page.** If a poll asks for 100 rows and only 12 exist, `nextSince` still moves past those 12 — unlike `nextCursor`, it does not wait for a full page, because there is no "last page" in a poll to wait for. A genuinely caught-up poll gets back `items: []` and its own `since` echoed back rather than `null`.
- **`offset` is always `0`,** the same reason a cursor page reports it. `total` is unaffected.
- **You need a matching composite index**, covering `(since.field, id)` in that order — the same requirement cursor pagination has, for the same reason.
- **Turn `pagination.count` off** for the same cost reason cursor pagination recommends it.
