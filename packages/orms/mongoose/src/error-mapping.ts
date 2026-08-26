import type { ErrorContext } from "@kavo/core";
import {
  ConflictException,
  KavoException,
  NotFoundException,
  PersistenceException,
  QueryValidationException,
  TransactionException,
} from "@kavo/core";

/** MongoDB server error codes this table recognizes. */
const DUPLICATE_KEY = 11000;
const DUPLICATE_KEY_LEGACY = 11001;
const WRITE_CONFLICT = 112;

/**
 * The shapes this module reads, kept structural rather than imported from
 * `mongoose`/`mongodb` — the same posture `@kavo/prisma` takes, and what
 * keeps this package's `src` free of any value import from its peer.
 * `name` is the stable discriminator across both libraries' error classes.
 */
interface MongoErrorLike extends Error {
  readonly code?: unknown;
  /** Present on a `CastError`: the schema path whose value failed to cast. */
  readonly path?: unknown;
  /** Present on a `CastError`: the value that failed to cast, as supplied. */
  readonly stringValue?: unknown;
  readonly value?: unknown;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/**
 * The value a `CastError` rejected, rendered for the 404 message.
 *
 * Mongoose exposes both `value` (the raw input) and `stringValue` (the same
 * thing already quoted for its own message text). The raw value is
 * preferred; `stringValue`'s surrounding quotes are stripped so the id is
 * not double-quoted once core interpolates it into `'{id}'`.
 */
function castValueOf(error: unknown): string {
  const { value, stringValue } = (error ?? {}) as MongoErrorLike;
  if (typeof value === "string") {
    return value;
  }
  if (value !== undefined && value !== null) {
    return String(value);
  }
  if (typeof stringValue === "string") {
    return stringValue.replace(/^"|"$/g, "");
  }
  return "";
}

function serverErrorCode(error: unknown): number | undefined {
  const code = (error as MongoErrorLike | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

/**
 * The error-mapping table: Mongoose/MongoDB driver error → Kavo exception.
 *
 * | Driver condition                        | Exception                         |
 * | --------------------------------------- | --------------------------------- |
 * | `CastError` on the id path              | NotFoundException                 |
 * | `CastError` on any other path           | QueryValidationException (400)    |
 * | duplicate key (11000 / 11001)           | ConflictException                 |
 * | write conflict (112)                    | TransactionException (retryable)  |
 * | anything else                           | PersistenceException with `cause` |
 *
 * **Why a bad id is a 404, not a 400.** `GET /books/not-an-objectid` asks
 * for a document that cannot exist: no 12-byte `ObjectId` has that spelling.
 * Answering 404 makes an unparseable id indistinguishable from a
 * well-formed one that isn't there, which is both the honest answer and the
 * one that avoids leaking the key format as an oracle. It also matters that
 * the *only* reason this error exists is MongoDB's key type — under
 * `@kavo/typeorm` an integer id column produces the same 404 by simply not
 * matching a row, so the 404 keeps adapters behaving alike.
 *
 * **Why other cast failures are a 400.** A `CastError` on a non-id path
 * means a supplied value could not be interpreted as that path's declared
 * type — precisely the "coercion failure" `KAVO_QUERY_INVALID_VALUE` names
 * in `docs/internals/architecture/06-error-handling.md`. Core coerces query values
 * against entity metadata before an adapter ever sees them, so in practice
 * this catches values whose MongoDB type is finer than core's coarse
 * `FieldKind` (an `ObjectId` reference field being the common one).
 *
 * **Schema validation is deliberately *not* mapped.** A Mongoose
 * `ValidationError` (a missing `required` path, an `enum` miss) falls
 * through to `PersistenceException`. Doc 06 scopes every 400 in the catalog
 * to query grammar, allowlists, and limits; there is no request-body
 * validation code, and minting one from inside an adapter would be an
 * adapter quietly widening core's public error contract. `@kavo/typeorm`
 * and `@kavo/prisma` leave the equivalent not-null violation unmapped for
 * the same reason. The original error always travels as `cause`.
 *
 * **Soft delete and unique indexes.** Same caveat as the other adapters: a
 * soft-deleted document still occupies its unique indexes, so re-creating
 * "the same" document after a soft delete raises 11000 — mapped here to a
 * 409 like any other conflict. The fix is a partial unique index scoped to
 * live documents (`{ deletedAt: null }` as a `partialFilterExpression`).
 */
export function mapDriverError(error: unknown, context: ErrorContext, idField?: string): KavoException {
  if (error instanceof KavoException) {
    return error;
  }

  const entity = context.entityName ?? "entity";

  if (errorName(error) === "CastError") {
    const path = (error as MongoErrorLike).path;
    const field = typeof path === "string" ? path : "";
    if (idField !== undefined && field === idField) {
      // The rejected spelling, so the message reads exactly like the 404 for
      // a well-formed id that is simply absent. Rendering an empty id here
      // would itself be the key-format oracle this branch exists to avoid:
      // `… with id '' was not found` announces "that was not a valid
      // ObjectId", while `… with id 'abc' was not found` says nothing.
      return new NotFoundException({
        messageParams: { entity, id: castValueOf(error) },
        context,
        cause: error,
      });
    }
    return QueryValidationException.single(
      {
        field: field === "" ? "filter" : field,
        code: "KAVO_QUERY_INVALID_VALUE",
        detail:
          `Value for '${field === "" ? "filter" : field}' could not be interpreted as the type ` +
          `declared for that path on '${entity}'.`,
      },
      { context, cause: error },
    );
  }

  const code = serverErrorCode(error);
  if (code === DUPLICATE_KEY || code === DUPLICATE_KEY_LEGACY) {
    return new ConflictException({ messageParams: { entity }, context, cause: error });
  }
  if (code === WRITE_CONFLICT) {
    return new TransactionException({ retryable: true, context, cause: error });
  }

  return new PersistenceException({
    messageParams: { operation: context.operation ?? "unknown" },
    context,
    cause: error,
  });
}
