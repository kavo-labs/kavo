import type { KavoErrorCode } from "./kavo-exception-shape.js";

/**
 * One catalog entry: everything stable about an error code. Codes are API
 * surface — renaming one is a breaking change (semver policy).
 * The full human-facing table lives in
 * docs/internals/architecture/06-error-handling.md and is generated from
 * this object, so code and docs cannot drift.
 */
export interface ErrorCatalogEntry {
  /** HTTP status the `@kavo/nest` filter responds with. */
  readonly status: number;
  /** RFC 9457 `title`: short, human-readable summary of the problem type. */
  readonly title: string;
  /**
   * English default for `detail`, interpolated with `{param}` placeholders
   * from `messageParams`. Consumers localize by re-rendering the same
   * `messageKey` + params; the key is always the error code itself.
   */
  readonly message: string;
}

/**
 * The complete error catalog. Later changes only add entries — the codes
 * here are API surface, and the soft-delete leaves slotted
 * into the hierarchy reserved for them without renumbering anything.
 */
export const ERROR_CATALOG = {
  KAVO_QUERY_INVALID: {
    status: 400,
    title: "Invalid query",
    message: "The request query is invalid.",
  },
  KAVO_QUERY_INVALID_FIELD: {
    status: 400,
    title: "Invalid query field",
    message: "Field '{field}' cannot be used for {usage}.",
  },
  KAVO_QUERY_INVALID_OPERATOR: {
    status: 400,
    title: "Invalid filter operator",
    message: "Unknown filter operator '{operator}' on field '{field}'.",
  },
  KAVO_QUERY_INVALID_VALUE: {
    status: 400,
    title: "Invalid query value",
    message: "Value '{value}' for field '{field}' is not a valid {expected}.",
  },
  KAVO_QUERY_LIMIT_EXCEEDED: {
    status: 400,
    title: "Query limit exceeded",
    message: "{limit} exceeds the configured maximum of {max}.",
  },
  KAVO_QUERY_UNSUPPORTED_PARAM: {
    status: 400,
    title: "Unsupported query parameter",
    message: "Query parameter '{param}' is not supported: {reason}",
  },
  KAVO_QUERY_CONFLICTING_PARAMS: {
    status: 400,
    title: "Conflicting query parameters",
    message: "Query parameters '{param}' and '{other}' cannot be used together: {reason}",
  },
  KAVO_NOT_FOUND: {
    status: 404,
    title: "Not found",
    message: "{entity} with id '{id}' was not found.",
  },
  KAVO_FORBIDDEN: {
    status: 403,
    title: "Forbidden",
    message: "The current principal is not permitted to {operation} {entity}.",
  },
  KAVO_CONFLICT: {
    status: 409,
    title: "Conflict",
    message: "The operation conflicts with the current state of {entity}.",
  },
  KAVO_ARRAY_MUTATION_INVALID_SHAPE: {
    status: 400,
    title: "Invalid array-mutation body",
    message: "The body for '{relation}' on {entity} is not a valid array-mutation shape: {expected}.",
  },
  KAVO_ASSOCIATION_INVALID_SHAPE: {
    status: 400,
    title: "Invalid association shape",
    message:
      "The value for '{relation}' on {entity} must be a reference object naming '{idField}', or null — not a bare id.",
  },
  KAVO_JSON_PATCH_INVALID_DOCUMENT: {
    status: 400,
    title: "Invalid JSON Patch document",
    message: "The JSON Patch document for {entity} is invalid: {detail}",
  },
  KAVO_JSON_PATCH_TARGET_NOT_FOUND: {
    status: 404,
    title: "JSON Patch target not found",
    message: "Cannot remove '{id}' from '{relation}' on {entity}: it is not currently a member.",
  },
  KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND: {
    status: 404,
    title: "Array-mutation member not found",
    message: "Cannot remove '{id}' from '{relation}' on {entity}: it is not currently a member.",
  },
  KAVO_PATCH_NO_CHANGES: {
    status: 400,
    title: "Patch has no changes",
    message: "The PATCH body for {entity} with id '{id}' contains no field changes.",
  },
  KAVO_ALREADY_DELETED: {
    status: 409,
    title: "Already deleted",
    message: "{entity} with id '{id}' is already deleted.",
  },
  KAVO_NOT_DELETED: {
    status: 409,
    title: "Not deleted",
    message: "{entity} with id '{id}' is not deleted.",
  },
  KAVO_PRECONDITION_FAILED: {
    status: 412,
    title: "Precondition failed",
    // The current tag is in the message on purpose: it is the value the
    // client needs to retry, it is already public (it is the `ETag` of a
    // representation the client is authorized to read), and without it the
    // only way forward is a blind re-GET. "Authorized to read" is what the
    // engine checks before throwing this: when `findOne` is not an enabled
    // operation there is no representation the client may read, so it
    // never reaches here — `KAVO_PRECONDITION_UNSUPPORTED` is raised
    // instead, and discloses nothing.
    message:
      "The If-Match precondition failed: {entity} with id '{id}' has changed since the ETag the request supplied. " +
      "Its current ETag is {etag}.",
  },
  KAVO_PRECONDITION_UNSUPPORTED: {
    status: 412,
    title: "Precondition failed",
    // `{reason}` is a closed set of phrases written at the single throw
    // site (`KavoEngine.checkIfMatch`), never caller text — the same
    // reasoning that makes `{operation}` safe in `KAVO_OPERATION_DISABLED`
    // below: a placeholder is only a hazard when the value may be absent.
    //
    // Fail *closed*: RFC 9110 §13.1.1 forbids performing the method when
    // `If-Match` evaluates false, and a condition Kavo cannot evaluate is
    // one it cannot show to be true. Silently performing the write would
    // hand back a 2xx for a guard that was never applied, which is the
    // lost update this whole feature exists to prevent.
    message:
      "The If-Match precondition on '{operation}' for {entity} cannot be evaluated ({reason}), so the request was " +
      "refused rather than performed unguarded.",
  },
  KAVO_OPERATION_DISABLED: {
    status: 405,
    title: "Operation disabled",
    // `{operation}` twice is safe: `renderMessage` replaces globally, and
    // the one throw site (`KavoEngine.run`) always supplies it. A
    // placeholder for text a *caller* might omit would render verbatim —
    // which is why the fix is baked into the template rather than passed
    // in as a free-form hint.
    //
    // The parenthetical is unconditional for the same reason. The config
    // key alone is not the whole fix for `restoreOne`/`purgeOne`: on an
    // entity that resolves to hard delete, `requireSoftDeletable` rejects
    // them at bootstrap (ADR-0013), so advertising `operations.restoreOne`
    // on its own would send a developer from a 405 to an app that no longer
    // starts. A conditional clause would have to arrive as a param, and a
    // param this template can be rendered without is exactly the verbatim
    // hazard above — so the caveat is carried by the template, where it is
    // always true and always localizable.
    message:
      "Operation '{operation}' is disabled for {entity}. Enable it with 'operations.{operation}' in the entity config " +
      "(restoreOne and purgeOne also need the entity to be soft-deletable).",
  },
  KAVO_OPERATION_NOT_REGISTERED: {
    status: 405,
    title: "Operation not registered",
    // Distinct from `KAVO_OPERATION_DISABLED` because `messageKey` *is* the
    // code: a consumer localizing from key + params would otherwise
    // re-render "is disabled" for an operation nobody ever disabled.
    // `{available}` is the whole registry (eight standard entries), which
    // subsumes a "did you mean" — the near miss is right there in the list.
    message: "Operation '{operation}' is not registered for {entity}. Registered operations: {available}.",
  },
  KAVO_PERSISTENCE_FAILED: {
    status: 500,
    title: "Persistence failure",
    message: "The persistence layer failed while executing '{operation}'.",
  },
  KAVO_TRANSACTION_FAILED: {
    status: 500,
    title: "Transaction failure",
    message: "The transaction could not be completed.",
  },
  KAVO_CONFIG_INVALID: {
    status: 500,
    title: "Invalid configuration",
    message: "Invalid configuration for entity '{entity}' at '{path}': {problem}",
  },
  KAVO_HTTP_ERROR: {
    // Nominal only: this code is never thrown by a `KavoException` leaf, so
    // nothing in the hierarchy binds a fixed status to it. The `@kavo/nest`
    // filter uses it to wrap a framework-level `HttpException` (a global
    // `ValidationPipe`, an unmatched route) that reaches the boundary
    // un-normalized; the response carries that exception's *own* status,
    // not this one — see doc 06 §6.
    status: 500,
    title: "HTTP error",
    message: "The request failed before reaching the Kavo engine: {detail}",
  },
  KAVO_UNEXPECTED_ERROR: {
    status: 500,
    title: "Unexpected error",
    message: "An unexpected error occurred while processing the request.",
  },
} as const satisfies Record<KavoErrorCode, ErrorCatalogEntry>;

/** A code present in the shipped catalog. */
export type CatalogedErrorCode = keyof typeof ERROR_CATALOG;

/** Render an English `detail` string from a catalog template and params. */
export function renderMessage(code: CatalogedErrorCode, params: Readonly<Record<string, string | number>>): string {
  return ERROR_CATALOG[code].message.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}
