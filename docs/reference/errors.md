# Errors

Every error Kavo raises is an [RFC 9457 problem-details](https://www.rfc-editor.org/rfc/rfc9457) document ([ADR-0009](/internals/adr/0009-problem-details-error-shape)), `Content-Type: application/problem+json`:

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

`code` is stable API surface. Renaming one is a breaking change. `type` is `https://kavo.dev/errors/<kebab-code>`. `instance` is `urn:kavo:request:<correlationId>`, so you can correlate a single request's errors in your logs.

This shape is the same across REST, GraphQL, and MCP, because every binding runs the same engine and the same error handler. A `NotFoundException` looks the same no matter which protocol raised it. Over MCP it arrives as an `isError: true` tool result carrying `${code}: ${detail}` as text, rather than an HTTP response. See [MCP](/integrations/protocols/mcp).

A query-validation failure additionally carries an `errors[]` array, so a client can fix every problem with a request in one round trip:

```json
{
  "code": "KAVO_QUERY_INVALID",
  "status": 400,
  "errors": [{ "code": "KAVO_QUERY_INVALID_FIELD", "detail": "'nickname' is not a filterable field." }]
}
```

## Full code catalog

| Code                                | HTTP | Fires when                                                                                                                                                                                   |
| ----------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KAVO_QUERY_INVALID`                | 400  | Any query grammar/allowlist/limit violation (aggregate; carries `errors[]`)                                                                                                                  |
| `KAVO_QUERY_INVALID_FIELD`          | 400  | Field not on the filter/sort/select allowlist                                                                                                                                                |
| `KAVO_QUERY_INVALID_OPERATOR`       | 400  | Unknown or misspelled wire operator                                                                                                                                                          |
| `KAVO_QUERY_INVALID_VALUE`          | 400  | Coercion failure, malformed bounds, bad pagination value                                                                                                                                     |
| `KAVO_QUERY_LIMIT_EXCEEDED`         | 400  | `maxFilterDepth` / `maxInValues` exceeded                                                                                                                                                    |
| `KAVO_QUERY_UNSUPPORTED_PARAM`      | 400  | `withDeleted`/`onlyDeleted` on a hard-delete entity; `include` with no include resolver wired                                                                                                |
| `KAVO_QUERY_CONFLICTING_PARAMS`     | 400  | `withDeleted=true` and `onlyDeleted=true` set together                                                                                                                                       |
| `KAVO_ARRAY_MUTATION_INVALID_SHAPE` | 400  | A relation-replace body isn't an array of ids/`{id}` refs, or `null`                                                                                                                         |
| `KAVO_JSON_PATCH_INVALID_DOCUMENT`  | 400  | `patchOne` array body isn't a well-formed RFC 6902 document within Kavo's subset                                                                                                             |
| `KAVO_FORBIDDEN`                    | 403  | A resolved `policy` (operation, entity, or global scope) returned `false` for the request, or `authorization.required` denied a request no policy covered; also raisable by a custom handler |
| `KAVO_NOT_FOUND`                    | 404  | Target row missing on `findOne`/`updateOne`/`patchOne`/`deleteOne`                                                                                                                           |
| `KAVO_JSON_PATCH_TARGET_NOT_FOUND`  | 404  | A `jsonPatch` `remove` op names a relation member id that isn't currently associated                                                                                                         |
| `KAVO_CONFLICT`                     | 409  | Unique or foreign-key violation                                                                                                                                                              |
| `KAVO_ALREADY_DELETED`              | 409  | Soft-deleting an already-deleted row                                                                                                                                                         |
| `KAVO_NOT_DELETED`                  | 409  | Restoring or purging a row that isn't deleted                                                                                                                                                |
| `KAVO_PRECONDITION_FAILED`          | 412  | `If-Match` names no tag matching the target's current `ETag`                                                                                                                                 |
| `KAVO_PRECONDITION_UNSUPPORTED`     | 412  | `If-Match` on a request the engine can't evaluate it for: untargeted operation, `cache.etag` off, `findOne` disabled                                                                         |
| `KAVO_OPERATION_DISABLED`           | 405  | Programmatic call to a disabled registry entry (no route exists over HTTP)                                                                                                                   |
| `KAVO_OPERATION_NOT_REGISTERED`     | 405  | Programmatic call naming an operation id the registry has no entry for                                                                                                                       |
| `KAVO_BULK_FAILED`                  | 422  | Reserved, bulk operations aren't implemented                                                                                                                                                 |
| `KAVO_PERSISTENCE_FAILED`           | 500  | Unrecognized adapter/driver error                                                                                                                                                            |
| `KAVO_TRANSACTION_FAILED`           | 500  | Deadlock/serialization failure (carries a `retryable` flag)                                                                                                                                  |
| `KAVO_CONFIG_INVALID`               | 500  | A bootstrap config error, **or** a request-time refusal when a handler returns a shape the response can't project                                                                            |
| `KAVO_HTTP_ERROR`                   | *    | A framework-level `HttpException` reaching the filter without going through Kavo's engine at all                                                                                             |
| `KAVO_UNEXPECTED_ERROR`             | 500  | Any other error reaching the filter without going through Kavo's engine                                                                                                                      |

`*`: `KAVO_HTTP_ERROR` carries whatever status the underlying framework exception already had. It's the one code whose status legitimately varies.

## Exposing internal detail

Driver-level detail, like raw SQL error text and stack info, never leaks into `detail` unless `errors.exposeInternals` is turned on. Keep it off in production. See [Reference/Config keys §errors](/reference/config-keys#errors).

## Where these come from

Every code above maps to exactly one exception class in one hierarchy: `KavoException` and its leaves (`NotFoundException`, `ConflictException`, `ConfigurationException`, and so on). Application code raising its own errors from a [custom operation handler](/core/custom-operations) throws these same classes. Anything else that escapes to the boundary is wrapped as `KAVO_HTTP_ERROR` or `KAVO_UNEXPECTED_ERROR`, so a framework-shaped error body never leaks out.

See [Error handling](/internals/architecture/06-error-handling) for the full hierarchy and the adapter-level mapping tables from raw driver errors to catalog codes. See [Guides/Error handling](/guides/error-handling) for handling these as a caller.
