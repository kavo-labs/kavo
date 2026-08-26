import type { ErrorContext } from "@kavo/core";
import {
  ConflictException,
  KavoException,
  NotFoundException,
  PersistenceException,
  TransactionException,
} from "@kavo/core";

/**
 * The shape of `PrismaClientKnownRequestError` this module reads. Kept
 * structural (not imported from `@prisma/client`) for the same reason as
 * {@link PrismaClientLike} — see that file's doc comment.
 */
interface PrismaKnownRequestError extends Error {
  readonly code: string;
  readonly meta?: Record<string, unknown>;
}

function isPrismaKnownRequestError(error: unknown): error is PrismaKnownRequestError {
  return (
    error instanceof Error &&
    error.constructor.name === "PrismaClientKnownRequestError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

/**
 * The error-mapping table: Prisma driver error → Kavo exception.
 *
 * | Prisma code                              | Exception                         |
 * | ----------------------------------------- | ---------------------------------- |
 * | P2002 unique constraint failed            | ConflictException                  |
 * | P2003 / P2014 foreign-key / relation violation | ConflictException             |
 * | P2025 record required for write not found | NotFoundException                  |
 * | P2034 transaction write conflict/deadlock | TransactionException (retryable)   |
 * | anything else                             | PersistenceException with `cause`  |
 *
 * Every code Prisma reports is driver-agnostic already (Prisma normalizes
 * Postgres/MySQL/SQLite/… errors into its own `P####` catalog), so unlike
 * `@kavo/typeorm`'s table this one needs no per-database code lists.
 *
 * **Soft delete and unique indexes.** Same caveat as `@kavo/typeorm`: a
 * soft-deleted row still occupies its unique indexes, so re-creating "the
 * same" row after a soft delete raises P2002 — mapped here to a 409 like
 * any other conflict. Kavo never rewrites indexes; the fix is a partial
 * unique index scoped to live rows.
 */
export function mapDriverError(error: unknown, context: ErrorContext): KavoException {
  if (error instanceof KavoException) {
    return error;
  }

  const entity = context.entityName ?? "entity";
  if (isPrismaKnownRequestError(error)) {
    switch (error.code) {
      case "P2002":
      case "P2003":
      case "P2014":
        return new ConflictException({ messageParams: { entity }, context, cause: error });
      case "P2025":
        return new NotFoundException({ messageParams: { entity, id: "" }, context, cause: error });
      case "P2034":
        return new TransactionException({ retryable: true, context, cause: error });
      default:
        break;
    }
  }

  return new PersistenceException({
    messageParams: { operation: context.operation ?? "unknown" },
    context,
    cause: error,
  });
}
