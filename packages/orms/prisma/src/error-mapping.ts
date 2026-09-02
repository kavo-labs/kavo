import type { ErrorContext } from "@kavo/core";
import {
  ConflictException,
  KavoException,
  NotFoundException,
  PersistenceException,
  TransactionException,
  UnresolvedRelationException,
} from "@kavo/core";

/**
 * The standard operations that delete a row. A P2003 from one of these is a
 * parent still referenced by children — a genuine conflict with current
 * state (409); from anything else it is a dangling reference in the payload
 * (422). The set is closed to these two standard ids on purpose: a custom
 * delete operation cannot be recognized here, and defaulting it to 422
 * matches the dominant case.
 */
function isDeleteOperation(operation: string | undefined): boolean {
  return operation === "deleteOne" || operation === "purgeOne";
}

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
 * | P2002 unique constraint failed            | ConflictException (409)            |
 * | P2003 foreign-key violation on a delete    | ConflictException (409)            |
 * | P2003 foreign-key violation otherwise      | UnresolvedRelationException (422)  |
 * | P2014 required-relation violation          | UnresolvedRelationException (422)  |
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
        return new ConflictException({ messageParams: { entity }, context, cause: error });
      case "P2003":
        // A bad foreign key on insert/update → 422; a delete blocked by
        // children that still reference the row → 409 (issue #365).
        return isDeleteOperation(context.operation)
          ? new ConflictException({ messageParams: { entity }, context, cause: error })
          : new UnresolvedRelationException({ messageParams: { entity }, context, cause: error });
      case "P2014":
        // "The change would violate the required relation" — always a write
        // pointing at a missing or invalid related record, never a delete.
        return new UnresolvedRelationException({ messageParams: { entity }, context, cause: error });
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
