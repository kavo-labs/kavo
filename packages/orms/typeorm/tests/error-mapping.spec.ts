import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { QueryFailedError } from "typeorm";
import type { ErrorContext } from "@kavo/core";
import {
  ConflictException,
  NotFoundException,
  PersistenceException,
  QueryValidationException,
  TransactionException,
} from "@kavo/core";
import { mapDriverError } from "@kavo/typeorm";

interface DriverPayload {
  readonly code?: string;
  readonly errno?: number;
  readonly message?: string;
}

/**
 * A driver error must be a real `Error`: `QueryFailedError` calls
 * `toString()` on it to build its own message.
 */
function queryFailed(driver: DriverPayload): QueryFailedError {
  const driverError = Object.assign(new Error(driver.message ?? "driver failure"), driver);
  return new QueryFailedError("insert into author …", [], driverError);
}

const context: ErrorContext = {
  entityName: "Author",
  operation: "createOne",
  correlationId: "req-1",
};

const uniqueViolations: readonly (readonly [string, DriverPayload])[] = [
  ["Postgres unique_violation", { code: "23505" }],
  ["MySQL ER_DUP_ENTRY", { code: "ER_DUP_ENTRY", errno: 1062 }],
  ["SQLite extended unique code", { code: "SQLITE_CONSTRAINT_UNIQUE" }],
  ["SQLite extended primary-key code", { code: "SQLITE_CONSTRAINT_PRIMARYKEY" }],
  [
    "SQLite base code with a unique message",
    { code: "SQLITE_CONSTRAINT", message: "UNIQUE constraint failed: author.email" },
  ],
];

const foreignKeyViolations: readonly (readonly [string, DriverPayload])[] = [
  ["Postgres foreign_key_violation", { code: "23503" }],
  ["MySQL ER_NO_REFERENCED_ROW_2", { code: "ER_NO_REFERENCED_ROW_2", errno: 1452 }],
  ["MySQL ER_ROW_IS_REFERENCED_2", { code: "ER_ROW_IS_REFERENCED_2", errno: 1451 }],
  ["SQLite extended foreign-key code", { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }],
  [
    "SQLite base code with a foreign-key message",
    { code: "SQLITE_CONSTRAINT", message: "FOREIGN KEY constraint failed" },
  ],
];

const retryableFailures: readonly (readonly [string, DriverPayload])[] = [
  ["Postgres serialization_failure", { code: "40001" }],
  ["Postgres deadlock_detected", { code: "40P01" }],
  ["MySQL ER_LOCK_DEADLOCK", { code: "ER_LOCK_DEADLOCK", errno: 1213 }],
  ["SQLite busy", { code: "SQLITE_BUSY" }],
];

describe("mapDriverError — unique violations", () => {
  it.each(uniqueViolations)("maps a %s to a 409 conflict", (_name, driver) => {
    const error = queryFailed(driver);
    const mapped = mapDriverError(error, context);
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped).toMatchObject({ code: "KAVO_CONFLICT", status: 409 });
  });

  it("names the entity in the conflict's message params", () => {
    expect(mapDriverError(queryFailed({ code: "23505" }), context).messageParams).toEqual({ entity: "Author" });
  });

  it("falls back to a generic entity name when the context has none", () => {
    expect(mapDriverError(queryFailed({ code: "23505" }), {}).messageParams).toEqual({ entity: "entity" });
  });

  it("maps a unique violation held by a soft-deleted row to a plain conflict", () => {
    // Per the note in `error-mapping.ts`: a soft-deleted row keeps its
    // unique index entries, and the honest answer is "the value is taken" —
    // no soft-delete-aware code. The integration path is covered by
    // soft-delete.spec.ts; this pins the mapping itself.
    const mapped = mapDriverError(
      queryFailed({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: ticket.reference" }),
      { entityName: "Ticket", operation: "createOne" },
    );
    expect(mapped.code).toBe("KAVO_CONFLICT");
    expect(mapped.status).toBe(409);
  });
});

describe("mapDriverError — foreign-key violations", () => {
  it.each(foreignKeyViolations)("maps a %s to a 409 conflict", (_name, driver) => {
    const mapped = mapDriverError(queryFailed(driver), context);
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped).toMatchObject({ code: "KAVO_CONFLICT", status: 409 });
  });

  it("leaves other SQLite constraint failures to the fallback row", () => {
    // The message sniff is scoped to unique/foreign-key wording: a NOT NULL
    // failure is neither row of the table, so it must not become a 409.
    const mapped = mapDriverError(
      queryFailed({ code: "SQLITE_CONSTRAINT", message: "NOT NULL constraint failed: author.name" }),
      context,
    );
    expect(mapped).toBeInstanceOf(PersistenceException);
    expect(mapped.status).toBe(500);
  });
});

describe("mapDriverError — serialization failures and deadlocks", () => {
  it.each(retryableFailures)("maps a %s to a retryable transaction failure", (_name, driver) => {
    const mapped = mapDriverError(queryFailed(driver), context);
    expect(mapped).toBeInstanceOf(TransactionException);
    expect(mapped).toMatchObject({ code: "KAVO_TRANSACTION_FAILED", status: 500 });
    expect((mapped as TransactionException).retryable).toBe(true);
  });
});

describe("mapDriverError — invalid input syntax", () => {
  it("maps Postgres invalid_text_representation (22P02) to a query-validation 400", () => {
    const mapped = mapDriverError(
      queryFailed({ code: "22P02", message: 'invalid input syntax for type uuid: "not-a-uuid"' }),
      context,
    );
    expect(mapped).toBeInstanceOf(QueryValidationException);
    expect(mapped).toMatchObject({ code: "KAVO_QUERY_INVALID", status: 400 });
    expect((mapped as QueryValidationException).issues).toEqual([
      {
        field: "id",
        code: "KAVO_QUERY_INVALID_VALUE",
        detail: 'invalid input syntax for type uuid: "not-a-uuid"',
      },
    ]);
  });

  it("keeps the original driver error as cause", () => {
    const error = queryFailed({ code: "22P02" });
    expect(mapDriverError(error, context).cause).toBe(error);
  });
});

describe("mapDriverError — the fallback row", () => {
  it("maps an unrecognized driver code to a persistence failure", () => {
    const mapped = mapDriverError(queryFailed({ code: "42P01" }), context);
    expect(mapped).toBeInstanceOf(PersistenceException);
    expect(mapped).toMatchObject({ code: "KAVO_PERSISTENCE_FAILED", status: 500 });
  });

  it("carries the failing operation from the error context", () => {
    expect(mapDriverError(queryFailed({ code: "42P01" }), context).messageParams).toEqual({ operation: "createOne" });
  });

  it("reports the operation as 'unknown' when the context does not name one", () => {
    expect(mapDriverError(queryFailed({ code: "42P01" }), { entityName: "Author" }).messageParams).toEqual({
      operation: "unknown",
    });
  });

  it("wraps errors that are not QueryFailedError at all", () => {
    for (const raw of [new Error("ECONNRESET"), "boom", null]) {
      const mapped = mapDriverError(raw, context);
      expect(mapped).toBeInstanceOf(PersistenceException);
      expect(mapped.cause).toBe(raw);
    }
  });

  it("does not read driver codes off a look-alike that is not a QueryFailedError", () => {
    // Only `QueryFailedError` is trusted to carry driver codes; a bare
    // object wearing `code: "23505"` is not a driver error.
    const lookAlike = Object.assign(new Error("unique violation"), { driverError: { code: "23505" } });
    expect(mapDriverError(lookAlike, context)).toBeInstanceOf(PersistenceException);
  });

  it("still classifies by errno when the driver reports no code", () => {
    // The SQLite sniffing further down calls `code.startsWith(...)`, which
    // a missing code would break — so the `?? ""` guard is what lets an
    // errno-only driver error reach its own row instead of crashing.
    expect(mapDriverError(queryFailed({ errno: 1062 }), context)).toBeInstanceOf(ConflictException);
  });

  it("falls back to a persistence failure when there is neither a code nor a known errno", () => {
    expect(mapDriverError(queryFailed({}), context)).toBeInstanceOf(PersistenceException);
  });
});

describe("mapDriverError — cause and context propagation", () => {
  const everyRow = [
    ...uniqueViolations,
    ...foreignKeyViolations,
    ...retryableFailures,
    ["Postgres invalid_text_representation", { code: "22P02" }],
    ["unknown", { code: "42P01" }],
  ] as const;

  it("keeps the original driver error as cause in every mapped case", () => {
    for (const [, driver] of everyRow) {
      const error = queryFailed(driver);
      expect(mapDriverError(error, context).cause).toBe(error);
    }
  });

  it("carries the error context onto every mapped exception", () => {
    for (const [, driver] of everyRow) {
      expect(mapDriverError(queryFailed(driver), context).context).toEqual(context);
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
