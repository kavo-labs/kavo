import { describe, expect, it } from "vitest";
import {
  CheckConstraintViolationException,
  DeadlockException,
  DriverException,
  ForeignKeyConstraintViolationException,
  LockWaitTimeoutException,
  NotNullConstraintViolationException,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import type { ErrorContext } from "@kavo/core";
import {
  ConflictException,
  NotFoundException,
  PersistenceException,
  QueryValidationException,
  TransactionException,
  UnresolvedRelationException,
} from "@kavo/core";
import { mapDriverError } from "@kavo/mikroorm";

const context: ErrorContext = {
  entityName: "Author",
  operation: "createOne",
  correlationId: "req-1",
};

const foreignKeyViolation = new ForeignKeyConstraintViolationException(new Error("FOREIGN KEY constraint failed"));

/**
 * MikroORM builds each of these from the driver's own error, which is what
 * this adapter matches on instead of the SQLSTATEs and errnos `@kavo/typeorm`
 * has to recognize itself.
 */
const conflicts = [
  ["a unique violation", new UniqueConstraintViolationException(new Error("UNIQUE constraint failed: author.email"))],
] as const;

const retryable = [
  ["a deadlock", new DeadlockException(new Error("deadlock detected"))],
  ["a lock-wait timeout", new LockWaitTimeoutException(new Error("lock wait timeout exceeded"))],
] as const;

const fallbacks = [
  ["a not-null violation", new NotNullConstraintViolationException(new Error("NOT NULL constraint failed"))],
  ["a check violation", new CheckConstraintViolationException(new Error("CHECK constraint failed"))],
  ["an unrecognized driver failure", new DriverException(new Error("relation does not exist"))],
] as const;

describe("mapDriverError — conflicts", () => {
  it.each(conflicts)("maps %s to a 409 conflict", (_name, error) => {
    const mapped = mapDriverError(error, context);
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped).toMatchObject({ code: "KAVO_CONFLICT", status: 409 });
  });

  it("maps a foreign-key violation blocking a delete to a 409 conflict", () => {
    for (const operation of ["deleteOne", "purgeOne"] as const) {
      const mapped = mapDriverError(foreignKeyViolation, { entityName: "Author", operation });
      expect(mapped).toBeInstanceOf(ConflictException);
      expect(mapped).toMatchObject({ code: "KAVO_CONFLICT", status: 409 });
    }
  });

  it("names the entity in the conflict's message params", () => {
    expect(mapDriverError(conflicts[0][1], context).messageParams).toEqual({ entity: "Author" });
  });

  it("falls back to a generic entity name when the context has none", () => {
    expect(mapDriverError(conflicts[0][1], {}).messageParams).toEqual({ entity: "entity" });
  });

  it("maps a unique violation held by a soft-deleted row to a plain conflict", () => {
    // Per the note in `error-mapping.ts`: a soft-deleted row keeps its unique
    // index entries, and the honest answer is "the value is taken" — no
    // soft-delete-aware code. The integration path is covered by
    // soft-delete.spec.ts; this pins the mapping itself.
    const mapped = mapDriverError(
      new UniqueConstraintViolationException(new Error("UNIQUE constraint failed: ticket.reference")),
      { entityName: "Ticket", operation: "createOne" },
    );
    expect(mapped.code).toBe("KAVO_CONFLICT");
    expect(mapped.status).toBe(409);
  });
});

describe("mapDriverError — foreign-key violations on insert/update", () => {
  it("maps a foreign-key violation from a write to a 422 unresolved relation", () => {
    const mapped = mapDriverError(foreignKeyViolation, context);
    expect(mapped).toBeInstanceOf(UnresolvedRelationException);
    expect(mapped).toMatchObject({ code: "KAVO_UNRESOLVED_RELATION", status: 422 });
  });

  it("names the entity in the unresolved-relation message params", () => {
    expect(mapDriverError(foreignKeyViolation, context).messageParams).toEqual({ entity: "Author" });
  });

  it("defaults to 422 when the context names no operation", () => {
    expect(mapDriverError(foreignKeyViolation, { entityName: "Author" })).toBeInstanceOf(UnresolvedRelationException);
  });
});

describe("mapDriverError — serialization failures and deadlocks", () => {
  it.each(retryable)("maps %s to a retryable transaction failure", (_name, error) => {
    const mapped = mapDriverError(error, context);
    expect(mapped).toBeInstanceOf(TransactionException);
    expect(mapped).toMatchObject({ code: "KAVO_TRANSACTION_FAILED", status: 500 });
    expect((mapped as TransactionException).retryable).toBe(true);
  });
});

describe("mapDriverError — the fallback row", () => {
  it.each(fallbacks)("maps %s to a persistence failure", (_name, error) => {
    // Only unique and foreign-key violations are mapped (to 409 / 422). A
    // constraint failure of another kind is not the caller's to resolve, so
    // it must not become a 4xx — the same line `@kavo/typeorm`'s table draws.
    const mapped = mapDriverError(error, context);
    expect(mapped).toBeInstanceOf(PersistenceException);
    expect(mapped).toMatchObject({ code: "KAVO_PERSISTENCE_FAILED", status: 500 });
  });

  it("carries the failing operation from the error context", () => {
    expect(mapDriverError(fallbacks[0][1], context).messageParams).toEqual({ operation: "createOne" });
  });

  it("reports the operation as 'unknown' when the context does not name one", () => {
    expect(mapDriverError(fallbacks[0][1], { entityName: "Author" }).messageParams).toEqual({ operation: "unknown" });
  });

  it("wraps errors that are not MikroORM driver exceptions at all", () => {
    for (const raw of [new Error("ECONNRESET"), "boom", null]) {
      const mapped = mapDriverError(raw, context);
      expect(mapped).toBeInstanceOf(PersistenceException);
      expect(mapped.cause).toBe(raw);
    }
  });

  it("does not treat a look-alike error as a constraint violation", () => {
    // Only MikroORM's own normalized exceptions are trusted; an error merely
    // named like one is not a driver error.
    const lookAlike = Object.assign(new Error("unique violation"), {
      name: "UniqueConstraintViolationException",
    });
    expect(mapDriverError(lookAlike, context)).toBeInstanceOf(PersistenceException);
  });
});

describe("mapDriverError — cause and context propagation", () => {
  const everyRow = [
    ...conflicts,
    ["a foreign-key violation", foreignKeyViolation],
    ...retryable,
    ...fallbacks,
  ] as const;

  it("keeps the original driver error as cause in every mapped case", () => {
    for (const [, error] of everyRow) {
      expect(mapDriverError(error, context).cause).toBe(error);
    }
  });

  it("carries the error context onto every mapped exception", () => {
    for (const [, error] of everyRow) {
      expect(mapDriverError(error, context).context).toEqual(context);
    }
  });
});

describe("mapDriverError — Kavo exceptions pass through", () => {
  it("returns an already-mapped exception by identity, not a copy", () => {
    // The adapter raises `NotFoundException` itself (affected === 0); a
    // second trip through the table must not restate it as a 500.
    for (const original of [
      new NotFoundException({ messageParams: { entity: "Author", id: "7" } }),
      new ConflictException({ messageParams: { entity: "Author" } }),
      new UnresolvedRelationException({ messageParams: { entity: "Author" } }),
      new QueryValidationException([{ field: "age", code: "KAVO_QUERY_INVALID_VALUE", detail: "bad" }]),
      new TransactionException({ retryable: true }),
    ]) {
      expect(mapDriverError(original, context)).toBe(original);
    }
  });

  it("leaves the passed-through exception's own context untouched", () => {
    const original = new NotFoundException({ context: { entityName: "Book" } });
    expect(mapDriverError(original, context).context).toEqual({ entityName: "Book" });
  });
});
