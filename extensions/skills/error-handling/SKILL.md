---
name: error-handling
description: Reference for Kavo's exception hierarchy, KAVO_* error-code catalog, and the RFC 9457 problem-details wire shape every generated route returns on failure. Use when handling/mapping a Kavo error, deciding which exception to throw from a custom handler/@Override, or answering "what does the error response look like" questions.
---

# Error handling reference

One exception hierarchy (`core/src/errors/`), one stable code catalog, one
wire shape (RFC 9457 problem details, ADR-0009). Full detail:
`docs/internals/architecture/06-error-handling.md`.

## Hierarchy

```
KavoException (abstract; implements the KavoExceptionShape contract)
├─ QueryValidationException     carries issues[] → errors[] extension
├─ NotFoundException
├─ ConflictException
├─ AlreadyDeletedException      soft-deleting an already-deleted row → 409
├─ NotDeletedException          restoring/purging a live row → 409
├─ OperationDisabledException
├─ OperationNotRegisteredException   registry miss, never "disabled"
├─ BulkOperationException       carries items[] (reserved — bulk not built)
├─ PersistenceException
├─ TransactionException         carries retryable: boolean
└─ ConfigurationException       bootstrap-only, never a wire response
```

Every leaf binds exactly one catalog code; status, title, and message
template all come from the catalog, so a thrown exception can never
disagree with its own documented response. `@kavo/nest`'s
`KavoExceptionFilter` (`@Catch(KavoException)`) is the only place Kavo
touches HTTP — Kavo exceptions never extend Nest's, and core never depends
on framework exception types.

## Error-code catalog (`ERROR_CATALOG`, `core/src/errors/error-catalog.ts`)

Codes are API surface — renaming one is a breaking (semver) change.

| Code                            | HTTP | Fires when                                                                      | Payload extensions                |
| ------------------------------- | ---- | ------------------------------------------------------------------------------- | --------------------------------- |
| `KAVO_QUERY_INVALID`            | 400  | Any query grammar/allowlist/limit violation (aggregate)                         | `errors[]` of the sub-codes below |
| `KAVO_QUERY_INVALID_FIELD`      | 400  | Field not on the filter/sort/select allowlist                                   | issue-level                       |
| `KAVO_QUERY_INVALID_OPERATOR`   | 400  | Unknown or misspelled wire operator                                             | issue-level                       |
| `KAVO_QUERY_INVALID_VALUE`      | 400  | Coercion failure, malformed bounds, bad pagination value                        | issue-level                       |
| `KAVO_QUERY_LIMIT_EXCEEDED`     | 400  | `limits.filterDepth` / `limits.inValues` exceeded                               | issue-level                       |
| `KAVO_QUERY_UNSUPPORTED_PARAM`  | 400  | `withDeleted` on a hard-delete entity; `include` with no include resolver wired | issue-level                       |
| `KAVO_NOT_FOUND`                | 404  | Target row missing on `findOne`/`updateOne`/`patchOne`/`deleteOne`              | —                                 |
| `KAVO_CONFLICT`                 | 409  | Unique/FK violation mapped by the adapter                                       | —                                 |
| `KAVO_ALREADY_DELETED`          | 409  | Soft-deleting an already-deleted row                                            | —                                 |
| `KAVO_NOT_DELETED`              | 409  | Restoring or purging a row that is not deleted                                  | —                                 |
| `KAVO_OPERATION_DISABLED`       | 405  | Programmatic/HTTP call to a disabled registry entry                             | —                                 |
| `KAVO_OPERATION_NOT_REGISTERED` | 405  | Programmatic call naming an operation the registry has no entry for at all      | —                                 |
| `KAVO_BULK_FAILED`              | 422  | Atomic bulk failure (reserved — bulk is not built)                              | `items[]` per-index issues        |
| `KAVO_PERSISTENCE_FAILED`       | 500  | Unrecognized adapter/driver error                                               | `cause` kept internally           |
| `KAVO_TRANSACTION_FAILED`       | 500  | Deadlock/serialization failure                                                  | `retryable` flag                  |
| `KAVO_CONFIG_INVALID`           | 500  | Bootstrap config error — fails startup, never a response                        | —                                 |

## Error context & message strategy

Every exception carries `ErrorContext` (`entityName`, `operation`,
`correlationId`); the engine's `DefaultErrorHandler` fills in whatever the
throw site didn't set. `detail` strings render from `messageKey` (= the
code) + `messageParams` via the catalog's `{param}` templates, so a
consumer can localize by re-rendering the same key/params — core ships only
the English defaults.

## Mapping strategy (adapter errors)

Adapter errors are translated by the adapter's own table (`@kavo/typeorm`'s
`mapDriverError`) **inside the adapter**; anything unrecognized that
reaches the engine becomes `PersistenceException` with the original as
`cause` — never swallowed. Whether `cause` details leak into the wire
response is governed by `errors.exposeInternals` (default `false` — see the
`global-config` skill).

## The wire shape — `toProblemDetails(exception, { exposeInternals })`

```json
{
  "type": "https://kavo.dev/errors/kavo-not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "User with id '42' was not found.",
  "instance": "urn:kavo:request:<correlationId>",
  "code": "KAVO_NOT_FOUND"
}
```

- `type` — `https://kavo.dev/errors/<kebab-code>`.
- `title`/`status` — from the catalog.
- `errors[]` — present on query-validation failures, one entry per
  independent issue (filter/sort/fields/pagination violations all collect
  into **one** exception/response, never a per-field round trip).
- `items[]` — bulk (reserved, not built).
- `@kavo/nest`'s filter serves this with
  `Content-Type: application/problem+json`. A different wire shape means
  swapping the serializer, never the exception hierarchy.

## Throwing from custom code (handlers, `@Override`)

Throw the existing `KavoException` subclass that matches the failure
(`NotFoundException`, `ConflictException`, etc.) rather than a bare `Error`
or a Nest `HttpException` — that's what keeps a custom handler's failures
indistinguishable from a generated route's at the wire level. Adding an
entirely new failure mode (not covered by an existing leaf) is the
`add-exception` skill's job, not something to improvise inline.
