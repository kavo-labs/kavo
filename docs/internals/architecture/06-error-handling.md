# 06 — Error Handling

One exception hierarchy in `core/src/errors/`, one stable code catalog,
one wire shape (RFC 9457 problem details, ADR-0009). Later work adds
leaves; nothing existing changes.

## 1. Hierarchy

```
KavoException (abstract; implements the KavoExceptionShape contract)
├─ QueryValidationException     carries issues[] → errors[] extension
├─ NotFoundException
├─ ConflictException
├─ AlreadyDeletedException      soft delete of a deleted row → 409
├─ NotDeletedException          restore/purge of a live row → 409
├─ OperationDisabledException
├─ OperationNotRegisteredException   registry miss, never "disabled"
├─ BulkOperationException       carries items[] (reserved)
├─ PersistenceException
├─ TransactionException         carries retryable: boolean
└─ ConfigurationException       mostly bootstrap; also a request-time refusal
                                when a handler returns an unusable shape
```

Every leaf binds exactly one catalog code; status, title, and the English
message template come from the catalog, so an exception cannot disagree
with it. Downstream layers program against the `KavoExceptionShape` contract;
`@kavo/nest`'s filter uses the base class only as its catch token.

## 2. Error-code catalog

Codes are API surface — renaming one is a breaking change (semver
policy). Source of truth: `ERROR_CATALOG` in
`core/src/errors/error-catalog.ts`.

| Code                                   | HTTP | Fires when                                                                                                                                                                                                            | Payload extensions                |
| -------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `KAVO_QUERY_INVALID`                   | 400  | Any query grammar/allowlist/limit violation (aggregate)                                                                                                                                                               | `errors[]` of the sub-codes below |
| `KAVO_QUERY_INVALID_FIELD`             | 400  | Field not on the filter/sort/select allowlist                                                                                                                                                                         | issue-level                       |
| `KAVO_QUERY_INVALID_OPERATOR`          | 400  | Unknown or misspelled wire operator                                                                                                                                                                                   | issue-level                       |
| `KAVO_QUERY_INVALID_VALUE`             | 400  | Coercion failure, malformed bounds, bad pagination value                                                                                                                                                              | issue-level                       |
| `KAVO_QUERY_LIMIT_EXCEEDED`            | 400  | maxFilterDepth / maxInValues exceeded                                                                                                                                                                                 | issue-level                       |
| `KAVO_QUERY_UNSUPPORTED_PARAM`         | 400  | `withDeleted`/`onlyDeleted` on a hard-delete entity; `include` when no include resolver is wired                                                                                                                      | issue-level                       |
| `KAVO_QUERY_CONFLICTING_PARAMS`        | 400  | `withDeleted=true` and `onlyDeleted=true` set together                                                                                                                                                                | issue-level                       |
| `KAVO_ARRAY_MUTATION_INVALID_SHAPE`    | 400  | `replace<Relation>` body is not an array of ids/`{id}` refs, or `null`; a `resource`-strategy `add`/`remove<Relation>` body is not a single id/`{id}` ref (arrayMutation's `replace`/`resource` strategies, ADR-0029) | —                                 |
| `KAVO_JSON_PATCH_INVALID_DOCUMENT`     | 400  | `patchOne` array body is not a well-formed RFC 6902 document within Kavo's subset (arrayMutation's `jsonPatch` strategy, ADR-0029)                                                                                    | —                                 |
| `KAVO_NOT_FOUND`                       | 404  | Target row missing on findOne/update/patch/delete; also a `jsonPatch`/`resource` `add` naming an id with no matching row                                                                                              | —                                 |
| `KAVO_FORBIDDEN`                       | 403  | A configured `operations.<id>.policy` node evaluated to `false` for the current principal (ADR-0032); available to a custom operation's own handler for the same purpose                                              | —                                 |
| `KAVO_JSON_PATCH_TARGET_NOT_FOUND`     | 404  | `jsonPatch` `remove` op names a relation member id that is not currently associated (ADR-0029)                                                                                                                        | —                                 |
| `KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND` | 404  | `resource`-strategy `remove<Relation>` names a member id that is not currently associated (ADR-0029's resource amendment)                                                                                             | —                                 |
| `KAVO_CONFLICT`                        | 409  | Unique/FK violation mapped by the adapter                                                                                                                                                                             | —                                 |
| `KAVO_ALREADY_DELETED`                 | 409  | Soft-deleting an already-deleted row                                                                                                                                                                                  | —                                 |
| `KAVO_NOT_DELETED`                     | 409  | Restoring or purging a row that is not deleted                                                                                                                                                                        | —                                 |
| `KAVO_PRECONDITION_FAILED`             | 412  | `If-Match` names no tag matching the target's current ETag (ADR-0020)                                                                                                                                                 | —                                 |
| `KAVO_PRECONDITION_UNSUPPORTED`        | 412  | `If-Match` the engine cannot evaluate — untargeted operation, `cache.etag` off, `findOne` disabled (ADR-0020 §4)                                                                                                      | —                                 |
| `KAVO_OPERATION_DISABLED`              | 405  | Programmatic call to a disabled registry entry (no route exists over HTTP)                                                                                                                                            | —                                 |
| `KAVO_OPERATION_NOT_REGISTERED`        | 405  | Programmatic call naming an operation the registry has no entry for at all                                                                                                                                            | —                                 |
| `KAVO_BULK_FAILED`                     | 422  | Atomic bulk failure (reserved — bulk is not built)                                                                                                                                                                    | `items[]` per-index issues        |
| `KAVO_PERSISTENCE_FAILED`              | 500  | Unrecognized adapter/driver error                                                                                                                                                                                     | `cause` kept internally           |
| `KAVO_TRANSACTION_FAILED`              | 500  | Deadlock/serialization failure                                                                                                                                                                                        | `retryable` flag                  |
| `KAVO_CONFIG_INVALID`                  | 500  | Bootstrap config error (fails startup), **and** a request-time refusal when a handler returns a shape the envelope or the projection cannot use                                                                       | —                                 |
| `KAVO_HTTP_ERROR`                      | *    | Framework-level `HttpException` reaching the filter without ever going through `KavoEngine.execute` (§6)                                                                                                              | —                                 |
| `KAVO_UNEXPECTED_ERROR`                | 500  | Any other error reaching the filter without ever going through `KavoEngine.execute` (§6)                                                                                                                              | `cause` kept internally           |

## 3. Error context & message strategy

Every exception carries `ErrorContext` (`entityName`, `operation`,
`correlationId`); the engine's `DefaultErrorHandler` fills whatever the
throw site didn't know. Human-readable `detail` strings are rendered from
`messageKey` (= the code) + `messageParams` via the catalog's `{param}`
templates, so a consumer can localize by re-rendering the same key and
params; core ships the English defaults.

## 4. Mapping strategy

Adapter errors are translated by the adapter's own table — each adapter
has one, keyed on whatever its driver reports (`@kavo/typeorm` doc 09 §5,
`@kavo/prisma` doc 14 §5, `@kavo/mongoose` doc 15 §6, `@kavo/mikroorm`
doc 17 §6) — _inside_ the adapter;
whatever reaches the engine unrecognized becomes `PersistenceException`
with the original as `cause` — never swallowed. Whether `cause` details
leak into responses is governed by `errors.exposeInternals` (default
`false`).

## 5. Problem-details serialization

`toProblemDetails(exception, { exposeInternals })` produces the wire
document: `type` (`https://kavo.dev/errors/<kebab-code>`), `title` and
`status` from the catalog, `detail`, `instance`
(`urn:kavo:request:<correlationId>`), `code`, plus `errors[]`
(query issues) and `items[]` (bulk, reserved). The `@kavo/nest` filter
maps it 1:1 with `Content-Type: application/problem+json`; a different
wire shape means swapping this serializer, never the hierarchy. Core
never depends on NestJS exceptions — the filter is the boundary.

## 6. Errors that never reach `KavoEngine.execute`

`KavoExceptionFilter` is registered globally (`APP_FILTER`), so it is the
one error boundary for the whole Nest app, not only `@Kavo`-generated
routes — a global `ValidationPipe`, an unmatched route, or a bug in
application code outside a Kavo handler must still answer with
problem-details (ADR-0009), never Nest's default `{ statusCode, message,
error }` shape. `@Catch()` (no token) is what makes that possible; the
filter narrows to HTTP contexts itself (`host.getType() !== "http"`
rethrows) since a global filter also runs for ws/rpc contexts a
REST-only framework binding has nothing to map.

`toKavoExceptionShape` (`@kavo/nest/src/unhandled-exception.ts`) adapts
whatever isn't a `KavoException` into the same `KavoExceptionShape`
contract `toProblemDetails` already serializes:

- A Nest `HttpException` → `KAVO_HTTP_ERROR`, with the **response's**
  `status` taken from the exception's own `getStatus()`, not the catalog's
  (nominal 500) entry — the one place a shape's status legitimately
  disagrees with its code's catalog row, because Nest already picked the
  correct one. Its `detail` is the exception's own message (Nest's
  built-ins, and a `ValidationPipe`'s `message: string[]`, are already
  meant for a client to see, so this happens regardless of
  `exposeInternals`).
- Anything else → `KAVO_UNEXPECTED_ERROR`, fixed at 500, with the original
  value as `cause` — leaked into `detail` only when `exposeInternals` is
  on, same as `PersistenceException`.

This mapping lives in `@kavo/nest`, not in the exception hierarchy: these
are framework-level errors Kavo did not raise and does not own the shape
of, so no new `KavoException` leaf exists for them.
