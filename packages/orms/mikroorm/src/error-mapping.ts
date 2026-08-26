import type { ErrorContext } from "@kavo/core";
import { ConflictException, KavoException, PersistenceException, TransactionException } from "@kavo/core";
import {
  DeadlockException,
  ForeignKeyConstraintViolationException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";

/**
 * The error-mapping table: driver error → Kavo exception.
 *
 * | MikroORM condition                          | Exception                          |
 * | ------------------------------------------- | ---------------------------------- |
 * | `UniqueConstraintViolationException`        | ConflictException                  |
 * | `ForeignKeyConstraintViolationException`    | ConflictException                  |
 * | `DeadlockException` / `LockWaitTimeoutException` | TransactionException (retryable) |
 * | anything else                               | PersistenceException with `cause`  |
 *
 * The same four rows `@kavo/typeorm`'s table has, reached differently:
 * MikroORM normalizes each driver's native error into its own exception
 * hierarchy before it surfaces, so this matches on those classes rather than
 * on Postgres SQLSTATEs, MySQL errnos, and SQLite extended codes the way the
 * TypeORM adapter must. Every driver MikroORM supports is covered by that
 * normalization, and anything it does not recognize falls through to
 * `PersistenceException` — the original error always travels as `cause`,
 * never swallowed.
 *
 * **Soft delete and unique indexes.** A soft-deleted row still occupies its
 * unique indexes, so re-creating "the same" row after a soft delete raises a
 * unique violation — mapped here to a 409 like any other conflict, which is
 * the honest answer: the value *is* taken. Kavo never rewrites indexes; the
 * standard fix is a partial/filtered unique index on the live rows only,
 * e.g. in Postgres
 * `CREATE UNIQUE INDEX … ON author (email) WHERE deleted_at IS NULL`
 * (SQLite supports the same form; MySQL needs a generated column).
 */
export function mapDriverError(error: unknown, context: ErrorContext): KavoException {
  if (error instanceof KavoException) {
    return error;
  }

  const entity = context.entityName ?? "entity";

  if (error instanceof UniqueConstraintViolationException || error instanceof ForeignKeyConstraintViolationException) {
    return new ConflictException({
      messageParams: { entity },
      context,
      cause: error,
    });
  }

  if (error instanceof DeadlockException || error instanceof LockWaitTimeoutException) {
    return new TransactionException({ retryable: true, context, cause: error });
  }

  return new PersistenceException({
    messageParams: { operation: context.operation ?? "unknown" },
    context,
    cause: error,
  });
}
