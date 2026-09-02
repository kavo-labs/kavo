# Using the generated API

[Getting started](/getting-started/introduction) shows the routes `@Kavo()` generates. This page covers the response envelope and error shape. The query-string grammar itself (filtering, search, sorting, pagination, field selection, and includes) lives under [Querying](/querying/filtering).

## Soft-deleted rows

```http
GET /books?withDeleted=true
```

This opts back into seeing soft-deleted rows on a read that would otherwise exclude them. `?onlyDeleted=true` narrows the other way: only soft-deleted rows, for a "trash" view. Both are rejected on an entity that isn't soft-deletable. Setting both together is also rejected, as a conflicting combination, rather than one silently winning. See [Soft delete](/features/soft-delete).

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

`total` is `null` (and its `COUNT` query skipped) if `pagination.count` is turned off. The key is always present: a list always answers "how many matched." Configuration changes the value, never the shape.

One optional fifth key can join them: `meta`. It's an open bag for anything the API wants to say about the list that isn't a row: a facet count, a "results are approximate" flag, the next cursor or since value.

`meta` appears when the entity's `findMany` handler puts something there (see [custom list metadata](/guides/configuration/operations#custom-list-metadata)), or under [cursor or since pagination](/querying/pagination#cursor-keyset-pagination), which write `nextCursor` and `nextSince` themselves.

A response with nothing to report has no `meta` key at all, not an empty `{}`. Read it as `body.meta?.facets`. Nothing in the bag is projected, filtered, or renamed on the way out: what the handler returns is what the client receives.

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

| Code                       | HTTP | Fires when                                                                |
| -------------------------- | ---- | ------------------------------------------------------------------------- |
| `KAVO_QUERY_INVALID`       | 400  | Any filter/sort/select/pagination violation (aggregate)                   |
| `KAVO_NOT_FOUND`           | 404  | Target row missing on a get/update/patch/delete                           |
| `KAVO_CONFLICT`            | 409  | A unique violation, or a delete blocked by a still-referenced row         |
| `KAVO_UNRESOLVED_RELATION` | 422  | A create/update whose payload references a related row that doesn't exist |
| `KAVO_ALREADY_DELETED`     | 409  | Soft-deleting a row that's already deleted                                |
| `KAVO_NOT_DELETED`         | 409  | Restoring or purging a row that isn't deleted                             |

Driver-level detail (raw SQL error text, stack info) never leaks into `detail` unless `errors.exposeInternals` is turned on. Keep it off in production. See [Error handling](/internals/architecture/06-error-handling) for the full exception hierarchy and code catalog.
