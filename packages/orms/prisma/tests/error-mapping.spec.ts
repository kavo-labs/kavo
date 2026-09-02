import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { ErrorContext } from "@kavo/core";
import {
  ConflictException,
  NotFoundException,
  PersistenceException,
  TransactionException,
  UnresolvedRelationException,
} from "@kavo/core";
import { mapDriverError } from "@kavo/prisma";

function knownRequestError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    code,
    clientVersion: "6.19.3",
    meta,
  });
}

const context: ErrorContext = {
  entityName: "Author",
  operation: "createOne",
  correlationId: "req-1",
};

const deleteContext: ErrorContext = {
  entityName: "Author",
  operation: "deleteOne",
  correlationId: "req-1",
};

describe("mapDriverError — unique violations", () => {
  it("maps P2002 to a 409 conflict", () => {
    const mapped = mapDriverError(knownRequestError("P2002"), context);
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped).toMatchObject({ code: "KAVO_CONFLICT", status: 409 });
  });

  it("names the entity in the conflict's message params", () => {
    expect(mapDriverError(knownRequestError("P2002"), context).messageParams).toEqual({ entity: "Author" });
  });

  it("falls back to a generic entity name when the context has none", () => {
    expect(mapDriverError(knownRequestError("P2002"), {}).messageParams).toEqual({ entity: "entity" });
  });
});

describe("mapDriverError — relation violations", () => {
  it.each(["P2003", "P2014"])("maps %s on a write to a 422 unresolved relation", (code) => {
    const mapped = mapDriverError(knownRequestError(code), context);
    expect(mapped).toBeInstanceOf(UnresolvedRelationException);
    expect(mapped).toMatchObject({ code: "KAVO_UNRESOLVED_RELATION", status: 422 });
  });

  it("names the entity in the unresolved-relation message params", () => {
    expect(mapDriverError(knownRequestError("P2003"), context).messageParams).toEqual({ entity: "Author" });
  });

  it("keeps P2003 a 409 conflict when the operation is a delete", () => {
    // A parent delete blocked by children that still reference the row is a
    // genuine conflict with current state.
    const mapped = mapDriverError(knownRequestError("P2003"), deleteContext);
    expect(mapped).toBeInstanceOf(ConflictException);
    expect(mapped).toMatchObject({ code: "KAVO_CONFLICT", status: 409 });
  });

  it("still routes P2014 to 422 even under a delete operation", () => {
    // P2014 is a required-relation violation from a write, never a delete.
    expect(mapDriverError(knownRequestError("P2014"), deleteContext)).toBeInstanceOf(UnresolvedRelationException);
  });
});

describe("mapDriverError — record-not-found and write conflicts", () => {
  it("maps P2025 to NotFoundException", () => {
    const mapped = mapDriverError(knownRequestError("P2025"), context);
    expect(mapped).toBeInstanceOf(NotFoundException);
    expect(mapped.status).toBe(404);
  });

  it("maps P2034 to a retryable transaction failure", () => {
    const mapped = mapDriverError(knownRequestError("P2034"), context);
    expect(mapped).toBeInstanceOf(TransactionException);
    expect(mapped).toMatchObject({ code: "KAVO_TRANSACTION_FAILED", status: 500 });
    expect((mapped as TransactionException).retryable).toBe(true);
  });
});

describe("mapDriverError — the fallback row", () => {
  it("maps an unrecognized Prisma code to a persistence failure", () => {
    const mapped = mapDriverError(knownRequestError("P2099"), context);
    expect(mapped).toBeInstanceOf(PersistenceException);
    expect(mapped).toMatchObject({ code: "KAVO_PERSISTENCE_FAILED", status: 500 });
  });

  it("carries the failing operation from the error context", () => {
    expect(mapDriverError(knownRequestError("P2099"), context).messageParams).toEqual({ operation: "createOne" });
  });

  it("reports the operation as 'unknown' when the context does not name one", () => {
    expect(mapDriverError(knownRequestError("P2099"), { entityName: "Author" }).messageParams).toEqual({
      operation: "unknown",
    });
  });

  it("wraps errors that are not PrismaClientKnownRequestError at all", () => {
    for (const raw of [new Error("ECONNRESET"), "boom", null]) {
      const mapped = mapDriverError(raw, context);
      expect(mapped).toBeInstanceOf(PersistenceException);
      expect(mapped.cause).toBe(raw);
    }
  });

  it("does not read a Prisma code off a look-alike that isn't a real Prisma error", () => {
    const lookAlike = Object.assign(new Error("unique violation"), { code: "P2002" });
    expect(mapDriverError(lookAlike, context)).toBeInstanceOf(PersistenceException);
  });
});

describe("mapDriverError — cause and context propagation", () => {
  const everyCode = ["P2002", "P2003", "P2014", "P2025", "P2034", "P2099"];

  it("keeps the original driver error as cause in every mapped case", () => {
    for (const code of everyCode) {
      const error = knownRequestError(code);
      expect(mapDriverError(error, context).cause).toBe(error);
    }
  });

  it("carries the error context onto every mapped exception", () => {
    for (const code of everyCode) {
      expect(mapDriverError(knownRequestError(code), context).context).toEqual(context);
    }
  });
});

describe("mapDriverError — Kavo exceptions pass through", () => {
  it("returns an already-mapped exception by identity, not a copy", () => {
    for (const original of [
      new NotFoundException({ messageParams: { entity: "Author", id: "7" } }),
      new ConflictException({ messageParams: { entity: "Author" } }),
      new UnresolvedRelationException({ messageParams: { entity: "Author" } }),
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
