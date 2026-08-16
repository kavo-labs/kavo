# Error handling

Every error Kavo raises, over REST, GraphQL, or MCP, comes from one exception hierarchy and answers in one wire shape: an [RFC 9457 problem-details](https://www.rfc-editor.org/rfc/rfc9457) document ([ADR-0009](/internals/adr/0009-problem-details-error-shape)), `Content-Type: application/problem+json` over REST.

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

`code` is the field to branch on. It's stable API surface, unlike `detail`'s free-text message. The full catalog of codes, their HTTP status, and what fires each one lives at [Reference/Errors](/reference/errors); this page is about handling them as a caller, not enumerating them.

## Reading a validation failure

A query-validation failure carries an `errors[]` array alongside the top-level `code`, so a client can fix every problem with a request in one round trip instead of discovering them one at a time:

```json
{
  "code": "KAVO_QUERY_INVALID",
  "status": 400,
  "errors": [
    { "code": "KAVO_QUERY_INVALID_FIELD", "detail": "'nickname' is not a filterable field." },
    { "code": "KAVO_QUERY_LIMIT_EXCEEDED", "detail": "'or' nesting exceeds the configured depth of 3." }
  ]
}
```

Iterate `errors[]` rather than assuming a single failure. A request with a bad filter field _and_ an oversized `limit` reports both at once.

## Handling a conflict on write

`KAVO_CONFLICT` (409) means a unique or foreign-key constraint rejected the write. Retry with different data, don't retry the same request. `KAVO_ALREADY_DELETED`/`KAVO_NOT_DELETED` (both 409) are the soft-delete-specific version of the same idea: they mean the row's state doesn't match what the operation assumed, not that anything is broken.

## Handling a conditional-write failure

`KAVO_PRECONDITION_FAILED` (412) means your `If-Match` token didn't match the row's current `ETag`: someone else wrote it since you last read it. The fix is almost always to re-`GET`, resolve the conflict, and retry with the fresh tag. `KAVO_PRECONDITION_UNSUPPORTED` (also 412) is a different situation entirely: it means the check couldn't run at all (untargeted operation, caching off, `findOne` disabled), so retrying unchanged will never help. See [Caching & ETags](/features/caching-and-etags) for the full conditional-request contract.

## What never reaches the client

Driver-level detail (raw SQL error text, stack traces) never appears in `detail` unless `errors.exposeInternals` is explicitly turned on (default `false`, and it should stay off in production). An error your own [custom operation handler](/core/custom-operations) doesn't explicitly raise as a `KavoException` still reaches the client in this same shape: anything unrecognized is wrapped as `KAVO_UNEXPECTED_ERROR` (500) rather than leaking whatever internal shape it had.

## Errors outside Kavo's own routes

The problem-details filter is registered app-wide, not just on `@Kavo`-generated routes. An unmatched route, a global validation pipe, or a bug in a hand-written controller method still answers in this same shape (`KAVO_HTTP_ERROR` for a framework-level exception, `KAVO_UNEXPECTED_ERROR` for anything else). A client never has to special-case "was this a Kavo route or not."

See [Reference/Errors](/reference/errors) for the complete code catalog and [Error handling](/internals/architecture/06-error-handling) for the underlying exception hierarchy and adapter-level error mapping.
