---
name: add-exception
description: How to add a new Kavo exception — hierarchy placement, error-code catalog entry, problem-details wiring, and adapter error mapping. Use when a change needs to signal a new failure mode to callers rather than reusing an existing exception.
---

# Adding an exception

Kavo has one exception hierarchy, one error-code catalog, and one wire shape
(RFC 9457 problem details, ADR-0009) — `docs/internals/architecture/06-error-handling.md`.
A new failure mode is a new catalog entry, never a raw `Error`, a bare string
code, or a second serialization path.

## Decide it's actually new

Check `ERROR_CATALOG` (`packages/core/src/errors/error-catalog.ts`) and the
hierarchy first — a new failure mode for an _existing_ code (e.g. another
reason a request is malformed) is usually a `QueryValidationException` issue,
not a new class. Only add a leaf when the failure needs its own HTTP status,
its own payload shape, or callers need to `instanceof`/catch it distinctly.

## Where it goes

1. **The class** — a new leaf under `KavoException`
   (`packages/core/src/errors/`), named `*Exception`. It implements the
   `KavoExceptionShape` contract; downstream layers (including `@kavo/nest`'s
   filter and `@kavo/next`'s `toErrorResponse`) program against that shape,
   never the concrete class, so don't
   add fields the base contract can't express without extending the contract
   itself.
2. **The catalog entry** — `ERROR_CATALOG` gets one row: a stable
   `KAVO_SNAKE_CASE` code, HTTP status, title, and an English message
   template with `{param}` placeholders. **Codes are public API surface** —
   once shipped, renaming one is a breaking change.
   Pick the name you're willing to keep.
3. **Payload extensions, if any** — follow the existing pattern rather than
   inventing a shape: issue-level detail lives in `errors[]` (query
   validation), per-item detail in `items[]` (bulk), a typed flag alongside
   the message (`retryable` on `TransactionException`). A new top-level wire
   field needs a reason `errors[]`/`items[]` can't already carry it.
4. **`ErrorContext`** — the throw site doesn't need to fill
   `entityName`/`operation`/`correlationId` itself; `DefaultErrorHandler`
   backfills whatever's missing. Don't hand-roll that at the throw site.
5. **Adapter mapping, if it originates from `@kavo/typeorm`** — add the
   translation in the adapter's own table (`mapDriverError`, doc 09 §5)
   _inside the adapter package_. Core never gains ORM-specific knowledge to
   recognize a driver error; whatever the adapter doesn't recognize already
   falls through to `PersistenceException` with the original as `cause`.
6. **`exposeInternals`** — if the new exception can carry adapter/driver
   detail, gate it behind `errors.exposeInternals` (default `false`) the same
   way `PersistenceException.cause` is gated — never leak it unconditionally.

## What you don't touch

`toProblemDetails`, the `@kavo/nest` filter, and `@kavo/next`'s
`toErrorResponse` are all generic over the `KavoExceptionShape` contract — a
new leaf needs no changes in any of them. If adding your exception seems to
require touching one of these, the new class is missing something the
contract already provides; fix the class, not the generic machinery.

## Tests

Per the `write-tests` skill: assert the thrown exception's **type and its
`KAVO_SNAKE_CASE` code** (not just the message — the code is the public
contract), the resulting HTTP status and problem-details shape end-to-end for
anything reachable over HTTP, and — for adapter-originated errors — that the
mapping table actually recognizes the driver error it claims to.

## Docs

Add the row to the error-catalog table in
`docs/internals/architecture/06-error-handling.md` §2. A code missing from
that table is invisible to the next reader and to API consumers relying on
the docs as the catalog's source of truth.
