import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CatalogedErrorCode, KavoExceptionShape, QueryIssueDto } from "@kavo/core";
import {
  AlreadyDeletedException,
  ArrayMutationInvalidShapeException,
  ArrayMutationMemberNotFoundException,
  ConfigurationException,
  ConflictException,
  ForbiddenException,
  KavoException,
  DefaultErrorHandler,
  ERROR_CATALOG,
  NotDeletedException,
  NotFoundException,
  OperationDisabledException,
  OperationNotRegisteredException,
  PatchNoChangesException,
  PersistenceException,
  QueryValidationException,
  TransactionException,
  renderMessage,
  toProblemDetails,
} from "@kavo/core";

/**
 * The shipped catalog, pinned. Codes are API surface — renaming, restatusing
 * or dropping one is a breaking change under semver policy, so
 * it should cost a deliberate edit here.
 *
 * `KAVO_BULK_FAILED` is absent on purpose: bulk was dropped, so the code is
 * not shipped (doc 06's table still lists it as reserved).
 */
const CATALOG: Readonly<Record<CatalogedErrorCode, { status: number; title: string }>> = {
  KAVO_QUERY_INVALID: { status: 400, title: "Invalid query" },
  KAVO_QUERY_INVALID_FIELD: { status: 400, title: "Invalid query field" },
  KAVO_QUERY_INVALID_OPERATOR: { status: 400, title: "Invalid filter operator" },
  KAVO_QUERY_INVALID_VALUE: { status: 400, title: "Invalid query value" },
  KAVO_QUERY_LIMIT_EXCEEDED: { status: 400, title: "Query limit exceeded" },
  KAVO_QUERY_UNSUPPORTED_PARAM: { status: 400, title: "Unsupported query parameter" },
  KAVO_QUERY_CONFLICTING_PARAMS: { status: 400, title: "Conflicting query parameters" },
  KAVO_NOT_FOUND: { status: 404, title: "Not found" },
  KAVO_FORBIDDEN: { status: 403, title: "Forbidden" },
  KAVO_CONFLICT: { status: 409, title: "Conflict" },
  KAVO_ARRAY_MUTATION_INVALID_SHAPE: { status: 400, title: "Invalid array-mutation body" },
  KAVO_ASSOCIATION_INVALID_SHAPE: { status: 400, title: "Invalid association shape" },
  KAVO_JSON_PATCH_INVALID_DOCUMENT: { status: 400, title: "Invalid JSON Patch document" },
  KAVO_JSON_PATCH_TARGET_NOT_FOUND: { status: 404, title: "JSON Patch target not found" },
  KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND: { status: 404, title: "Array-mutation member not found" },
  KAVO_PATCH_NO_CHANGES: { status: 400, title: "Patch has no changes" },
  KAVO_ALREADY_DELETED: { status: 409, title: "Already deleted" },
  KAVO_NOT_DELETED: { status: 409, title: "Not deleted" },
  KAVO_PRECONDITION_FAILED: { status: 412, title: "Precondition failed" },
  KAVO_PRECONDITION_UNSUPPORTED: { status: 412, title: "Precondition failed" },
  KAVO_OPERATION_DISABLED: { status: 405, title: "Operation disabled" },
  KAVO_OPERATION_NOT_REGISTERED: { status: 405, title: "Operation not registered" },
  KAVO_PERSISTENCE_FAILED: { status: 500, title: "Persistence failure" },
  KAVO_TRANSACTION_FAILED: { status: 500, title: "Transaction failure" },
  KAVO_CONFIG_INVALID: { status: 500, title: "Invalid configuration" },
  KAVO_HTTP_ERROR: { status: 500, title: "HTTP error" },
  KAVO_UNEXPECTED_ERROR: { status: 500, title: "Unexpected error" },
};

/** Every `KAVO_*` code literal appearing anywhere in core's source. */
function codesUsedInSource(): string[] {
  const root = new URL("../src/", import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".ts"));
  const codes = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(new URL(file, root), "utf8").matchAll(/KAVO_[A-Z][A-Z0-9_]*/g)) {
      codes.add(match[0]);
    }
  }
  return [...codes].sort();
}

describe("ERROR_CATALOG completeness", () => {
  it("catalogs every error code core's source actually uses", () => {
    // `KavoErrorCode` is an open template type, so the compiler cannot
    // close this gap: a new code with no catalog entry would render a title
    // of "Error" at runtime and go unnoticed.
    const used = codesUsedInSource();
    // Guards the guard: a scanner that found nothing would pass vacuously.
    expect(used.length).toBeGreaterThanOrEqual(Object.keys(ERROR_CATALOG).length);
    expect(used.filter((code) => !(code in ERROR_CATALOG))).toEqual([]);
  });

  it("ships exactly the pinned set of codes", () => {
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual(Object.keys(CATALOG).sort());
  });

  it("binds the pinned HTTP status and title to each code", () => {
    for (const [code, expected] of Object.entries(CATALOG)) {
      expect(ERROR_CATALOG[code as CatalogedErrorCode]).toMatchObject(expected);
    }
  });

  it("gives every entry a usable status, title, and message template", () => {
    for (const entry of Object.values(ERROR_CATALOG)) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });
});

describe("renderMessage — message key + params", () => {
  it("interpolates every {param} placeholder from the params bag", () => {
    expect(renderMessage("KAVO_NOT_FOUND", { entity: "User", id: "7" })).toBe("User with id '7' was not found.");
  });

  it("stringifies numeric params", () => {
    expect(renderMessage("KAVO_NOT_FOUND", { entity: "User", id: 7 })).toContain("'7'");
  });

  it("returns a placeholder-free template untouched", () => {
    expect(renderMessage("KAVO_TRANSACTION_FAILED", {})).toBe(ERROR_CATALOG.KAVO_TRANSACTION_FAILED.message);
  });

  it("ignores params the template does not name", () => {
    expect(renderMessage("KAVO_CONFLICT", { entity: "User", stray: "x" })).toBe(
      "The operation conflicts with the current state of User.",
    );
  });

  it("leaves an unsupplied placeholder verbatim rather than printing 'undefined'", () => {
    // The spec fixes key + params as the localization contract but is silent
    // on a missing param; keeping the placeholder is what core does, and it
    // keeps the gap legible in the rendered detail.
    expect(renderMessage("KAVO_NOT_FOUND", { entity: "User" })).toBe("User with id '{id}' was not found.");
  });
});

describe("exception hierarchy", () => {
  const leaves = [
    { exception: new NotFoundException(), code: "KAVO_NOT_FOUND", status: 404 },
    { exception: new ForbiddenException(), code: "KAVO_FORBIDDEN", status: 403 },
    { exception: new ConflictException(), code: "KAVO_CONFLICT", status: 409 },
    { exception: new ArrayMutationInvalidShapeException(), code: "KAVO_ARRAY_MUTATION_INVALID_SHAPE", status: 400 },
    {
      exception: new ArrayMutationMemberNotFoundException(),
      code: "KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND",
      status: 404,
    },
    { exception: new PatchNoChangesException(), code: "KAVO_PATCH_NO_CHANGES", status: 400 },
    { exception: new AlreadyDeletedException(), code: "KAVO_ALREADY_DELETED", status: 409 },
    { exception: new NotDeletedException(), code: "KAVO_NOT_DELETED", status: 409 },
    { exception: new OperationDisabledException(), code: "KAVO_OPERATION_DISABLED", status: 405 },
    { exception: new OperationNotRegisteredException(), code: "KAVO_OPERATION_NOT_REGISTERED", status: 405 },
    { exception: new PersistenceException(), code: "KAVO_PERSISTENCE_FAILED", status: 500 },
    { exception: new TransactionException(), code: "KAVO_TRANSACTION_FAILED", status: 500 },
    { exception: new QueryValidationException([]), code: "KAVO_QUERY_INVALID", status: 400 },
    { exception: new ConfigurationException("User", "operations.x", "why"), code: "KAVO_CONFIG_INVALID", status: 500 },
  ] as const;

  it("binds each leaf to its catalog code and status", () => {
    for (const { exception, code, status } of leaves) {
      expect(exception.code).toBe(code);
      expect(exception.status).toBe(status);
      expect(exception.status).toBe(ERROR_CATALOG[code].status);
    }
  });

  it("is catchable as an Error and through the KavoException base token", () => {
    for (const { exception } of leaves) {
      expect(exception).toBeInstanceOf(Error);
      expect(exception).toBeInstanceOf(KavoException);
      expect(exception.name).toBe(exception.constructor.name);
    }
  });

  it("uses the code itself as the localization message key", () => {
    for (const { exception, code } of leaves) {
      expect(exception.messageKey).toBe(code);
    }
  });

  it("renders detail from the catalog template and the supplied params", () => {
    const exception = new NotFoundException({ messageParams: { entity: "User", id: 7 } });
    expect(exception.messageParams).toEqual({ entity: "User", id: 7 });
    expect(exception.detail).toBe("User with id '7' was not found.");
    expect(exception.message).toBe(exception.detail);
  });

  it("defaults messageParams and context to empty bags", () => {
    const exception = new ConflictException();
    expect(exception.messageParams).toEqual({});
    expect(exception.context).toEqual({});
    expect(exception.cause).toBeUndefined();
  });

  it("keeps the originating error as cause — never swallowed", () => {
    const cause = new Error("driver exploded");
    expect(new PersistenceException({ cause }).cause).toBe(cause);
  });

  it("carries the error context (entity, operation, correlation id)", () => {
    const context = { entityName: "User", operation: "findOne", correlationId: "abc" };
    expect(new NotFoundException({ context }).context).toEqual(context);
  });

  it("carries field-level issues on QueryValidationException under the aggregate code", () => {
    const issues: QueryIssueDto[] = [
      { field: "age", code: "KAVO_QUERY_INVALID_VALUE", detail: "bad" },
      { field: "password", code: "KAVO_QUERY_INVALID_FIELD", detail: "not allowlisted" },
    ];
    const exception = new QueryValidationException(issues);
    expect(exception.code).toBe("KAVO_QUERY_INVALID");
    expect(exception.issues).toEqual(issues);
  });

  it("wraps the single-issue case into the same issues array", () => {
    const issue: QueryIssueDto = { field: "limit", code: "KAVO_QUERY_INVALID_VALUE", detail: "bad" };
    const exception = QueryValidationException.single(issue);
    expect(exception).toBeInstanceOf(QueryValidationException);
    expect(exception.issues).toEqual([issue]);
  });

  it("marks a transaction retryable only when told so", () => {
    expect(new TransactionException().retryable).toBe(false);
    expect(new TransactionException({ retryable: true }).retryable).toBe(true);
  });

  it("bakes the fix into the disabled-operation template, not into a caller-supplied hint", () => {
    // Issue #7: `messageKey` *is* the code, so a consumer that localizes by
    // re-rendering key + params has to get the actionable half too — it
    // cannot live only in the English string a throw site pasted together.
    const exception = new OperationDisabledException({
      messageParams: { operation: "purgeOne", entity: "User" },
    });
    expect(exception.detail).toContain("Operation 'purgeOne' is disabled for User.");
    expect(exception.detail).toContain("Enable it with 'operations.purgeOne' in the entity config");
    // The caveat rides the template rather than a param, so it survives
    // re-rendering and cannot leave a `{placeholder}` in a response when a
    // caller constructs this exception without it. `purgeOne` is disabled by
    // default on *every* entity, so the flag alone is the wrong advice more
    // often than not.
    expect(exception.detail).toContain("also need the entity to be soft-deletable");
    expect(exception.detail).not.toContain("{");
    expect(renderMessage("KAVO_OPERATION_DISABLED", exception.messageParams)).toBe(exception.detail);
  });

  it("never calls an unregistered operation 'disabled'", () => {
    const exception = new OperationNotRegisteredException({
      messageParams: { operation: "findAll", entity: "User", available: "findMany, findOne" },
    });
    expect(exception.detail).toContain("is not registered for User");
    expect(exception.detail).toContain("Registered operations: findMany, findOne.");
    expect(exception.detail).not.toContain("disabled");
    // The two share a status but never a code — the code is what a
    // localizing consumer keys off.
    expect(exception.status).toBe(new OperationDisabledException().status);
    expect(exception.code).not.toBe("KAVO_OPERATION_DISABLED");
  });

  it("names the entity, key path, and problem on a configuration error", () => {
    const exception = new ConfigurationException("User", "operations.purgeOne", "not soft-deletable");
    expect(exception.messageParams).toEqual({
      entity: "User",
      path: "operations.purgeOne",
      problem: "not soft-deletable",
    });
    expect(exception.context.entityName).toBe("User");
    expect(exception.detail).toContain("operations.purgeOne");
  });
});

describe("toProblemDetails — RFC 9457 document (ADR-0009)", () => {
  it("produces type, title, status, detail, and the code extension", () => {
    const exception = new NotFoundException({ messageParams: { entity: "User", id: 7 } });
    expect(toProblemDetails(exception)).toEqual({
      type: "https://kavo.dev/errors/kavo-not-found",
      title: "Not found",
      status: 404,
      detail: "User with id '7' was not found.",
      code: "KAVO_NOT_FOUND",
    });
  });

  it("derives the type URI from the code for every cataloged code", () => {
    for (const code of Object.keys(ERROR_CATALOG) as CatalogedErrorCode[]) {
      const problem = toProblemDetails({
        code,
        status: ERROR_CATALOG[code].status,
        messageKey: code,
        messageParams: {},
        detail: "",
        context: {},
      });
      expect(problem.type).toBe(`https://kavo.dev/errors/${code.toLowerCase().replace(/_/g, "-")}`);
      expect(problem.title).toBe(ERROR_CATALOG[code].title);
    }
  });

  it("emits one errors[] entry per issue of a multi-issue query failure", () => {
    const issues: QueryIssueDto[] = [
      { field: "age", code: "KAVO_QUERY_INVALID_VALUE", detail: "not a number" },
      { field: "password", code: "KAVO_QUERY_INVALID_FIELD", detail: "not filterable" },
    ];
    const problem = toProblemDetails(new QueryValidationException(issues));
    expect(problem).toMatchObject({
      type: "https://kavo.dev/errors/kavo-query-invalid",
      status: 400,
      code: "KAVO_QUERY_INVALID",
    });
    expect(problem.errors).toEqual(issues);
  });

  it("omits errors[] for a failure that carries no field-level issues", () => {
    expect(toProblemDetails(new ConflictException()).errors).toBeUndefined();
  });

  it("reports the correlation id as the instance URN, and omits it when absent", () => {
    const correlated = toProblemDetails(new NotFoundException({ context: { correlationId: "req-1" } }));
    expect(correlated.instance).toBe("urn:kavo:request:req-1");
    expect(toProblemDetails(new NotFoundException()).instance).toBeUndefined();
  });

  it("keeps driver detail out of the document unless exposeInternals is on", () => {
    const exception = new PersistenceException({ cause: new Error("SQLITE_BUSY") });
    expect(toProblemDetails(exception).detail).not.toContain("SQLITE_BUSY");
    expect(toProblemDetails(exception, { exposeInternals: true }).detail).toContain("SQLITE_BUSY");
  });
});

describe("DefaultErrorHandler — engine boundary mapping", () => {
  const handler = new DefaultErrorHandler();

  it("passes a Kavo exception through with its code, status, and payload intact", () => {
    const original = new QueryValidationException([{ field: "age", code: "KAVO_QUERY_INVALID_VALUE", detail: "x" }]);
    const handled = handler.handle(original, { entityName: "User", operation: "findMany" });
    expect(handled).toBeInstanceOf(QueryValidationException);
    expect(handled).toMatchObject({ code: "KAVO_QUERY_INVALID", status: 400, detail: original.detail });
    expect((handled as QueryValidationException).issues).toEqual(original.issues);
  });

  it("fills in only the context the exception did not already know", () => {
    const original = new NotFoundException({ context: { entityName: "Account" } });
    const handled = handler.handle(original, {
      entityName: "User",
      operation: "findOne",
      correlationId: "req-1",
    });
    expect(handled.context).toEqual({
      entityName: "Account",
      operation: "findOne",
      correlationId: "req-1",
    });
  });

  it("wraps an untranslated error as a persistence failure, keeping the cause", () => {
    const driverError = new Error("ECONNRESET");
    const handled = handler.handle(driverError, { entityName: "User", operation: "createOne" });
    expect(handled).toBeInstanceOf(PersistenceException);
    expect(handled.code).toBe("KAVO_PERSISTENCE_FAILED");
    expect(handled.status).toBe(500);
    expect(handled.cause).toBe(driverError);
    expect(handled.context).toMatchObject({ entityName: "User", operation: "createOne" });
    expect(handled.messageParams).toEqual({ operation: "createOne" });
  });

  it("wraps a thrown non-Error value just the same", () => {
    const handled = handler.handle("boom", {});
    expect(handled).toBeInstanceOf(PersistenceException);
    expect(handled.cause).toBe("boom");
    expect(handled.messageParams).toEqual({ operation: "unknown" });
  });

  it("hands the serializer a document a client can act on", () => {
    const handled: KavoExceptionShape = handler.handle(new Error("boom"), {
      operation: "updateOne",
      correlationId: "req-2",
    });
    expect(toProblemDetails(handled)).toMatchObject({
      type: "https://kavo.dev/errors/kavo-persistence-failed",
      status: 500,
      instance: "urn:kavo:request:req-2",
    });
  });
});

describe("toProblemDetails — codes the catalog does not know", () => {
  // The extension path: a consumer subclassing the exception hierarchy
  // with its own code still has to get a well-formed problem document, not
  // a crash on a missing catalog entry.
  const custom: KavoExceptionShape = {
    code: "KAVO_SOMETHING_CUSTOM" as KavoExceptionShape["code"],
    status: 418,
    messageKey: "custom.brewing",
    messageParams: {},
    detail: "brewing refused",
    context: {},
    cause: undefined,
  };

  it("falls back to a generic title rather than reading undefined", () => {
    expect(toProblemDetails(custom)).toMatchObject({ title: "Error", status: 418, code: "KAVO_SOMETHING_CUSTOM" });
  });

  it("still derives the type URI from the code", () => {
    expect(toProblemDetails(custom).type).toBe("https://kavo.dev/errors/kavo-something-custom");
  });
});

describe("toProblemDetails — describing a cause that is not an Error", () => {
  // `DefaultErrorHandler` keeps a thrown non-`Error` value as the cause
  // verbatim, so the serializer has to render one. An `Error` cause reads
  // as `name: message`; anything else goes through `String`.
  it("renders a string cause through String, under exposeInternals", () => {
    const handled = new DefaultErrorHandler().handle("boom", {});
    expect(toProblemDetails(handled, { exposeInternals: true }).detail).toContain("[cause: boom]");
  });

  it("renders an Error cause as name and message", () => {
    const handled = new DefaultErrorHandler().handle(new TypeError("bad"), {});
    expect(toProblemDetails(handled, { exposeInternals: true }).detail).toContain("[cause: TypeError: bad]");
  });

  it("keeps the cause out of the document by default", () => {
    const handled = new DefaultErrorHandler().handle("boom", {});
    expect(toProblemDetails(handled).detail).not.toContain("boom");
  });
});
