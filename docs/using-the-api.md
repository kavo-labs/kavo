# Using the generated API

[Getting started](/getting-started/introduction) shows the routes `@Kavo()` generates. This page covers the response envelope and error shape; the query-string grammar itself — filtering, search, sorting, pagination, field selection, and includes — lives under [Querying](/querying/filtering).

## Soft-deleted rows

```http
GET /books?withDeleted=true
```

Opts back into seeing soft-deleted rows on a read that would otherwise exclude them. `?onlyDeleted=true` narrows the other way — only soft-deleted rows, for a "trash" view. Both are rejected outright on an entity that isn't soft-deletable, and setting both together is rejected as a conflicting combination, rather than either being silently ignored — see [Soft delete](/features/soft-delete).

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

One optional fifth key can join them. `meta` is an open bag for anything the API wants to say about the list that isn't a row: a facet count, a "results are approximate" flag, the next cursor or since value. It appears when the entity's `findMany` handler puts something there — see [custom list metadata](/guides/configuration/operations#custom-list-metadata) for how — or under [cursor pagination](/querying/pagination#cursor-keyset-pagination) or [since pagination](/querying/pagination#since-seek-by-timestamp-pagination), which contribute `nextCursor`/`nextSince` and are the keys Kavo writes itself. A response with nothing to report has no `meta` key at all rather than an empty `{}`, so read it as `body.meta?.facets`. Nothing in the bag is projected, filtered, or renamed on the way out: what the handler returns is what the client receives.

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
