import type { KavoExceptionShape, ErrorContext } from "./kavo-exception-shape.js";
import type { QueryIssueDto } from "./problem-details.js";
import type { CatalogedErrorCode } from "./error-catalog.js";
import { ERROR_CATALOG, renderMessage } from "./error-catalog.js";

/** Constructor input shared by every exception class. */
export interface KavoExceptionOptions {
  readonly messageParams?: Readonly<Record<string, string | number>>;
  readonly context?: ErrorContext;
  readonly cause?: unknown;
}

/**
 * Base class of the exception hierarchy. Every leaf binds one
 * catalog code; status, title, and the English `detail` template all come
 * from the catalog, so an exception cannot disagree with it.
 *
 * Downstream layers should keep programming against the `KavoExceptionShape`
 * *shape* (the `@kavo/nest` filter catches this class only as a
 * convenience at the HTTP boundary) — the hierarchy is extensible by
 * adding leaves, never by editing existing ones.
 */
export abstract class KavoException extends Error implements KavoExceptionShape {
  readonly code: CatalogedErrorCode;
  readonly status: number;
  readonly messageKey: string;
  readonly messageParams: Readonly<Record<string, string | number>>;
  readonly detail: string;
  readonly context: ErrorContext;
  override readonly cause?: unknown;

  protected constructor(code: CatalogedErrorCode, options: KavoExceptionOptions = {}) {
    const params = options.messageParams ?? {};
    const detail = renderMessage(code, params);
    super(detail);
    this.name = new.target.name;
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    // The message key is the code itself: one stable identifier for both
    // machine handling and localization lookup.
    this.messageKey = code;
    this.messageParams = params;
    this.detail = detail;
    this.context = options.context ?? {};
    this.cause = options.cause;
  }
}

/**
 * Bad filter/sort/fields/pagination input (query grammar violations).
 * Carries field-level issues that serialize into the problem-details
 * `errors[]` extension. The exception's own code is the generic
 * `KAVO_QUERY_INVALID`; each issue carries its precise sub-code.
 */
export class QueryValidationException extends KavoException {
  readonly issues: readonly QueryIssueDto[];

  constructor(issues: readonly QueryIssueDto[], options: KavoExceptionOptions = {}) {
    super("KAVO_QUERY_INVALID", options);
    this.issues = issues;
  }

  /** Convenience for the common single-issue case. */
  static single(issue: QueryIssueDto, options: KavoExceptionOptions = {}): QueryValidationException {
    return new QueryValidationException([issue], options);
  }
}

export class NotFoundException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_NOT_FOUND", options);
  }
}

/**
 * A `policy` (ADR-0037) evaluated to `false` for the current request's
 * `context.app` on this entity/operation. Raised by the engine's
 * policy stage, never by application code directly — a custom operation's
 * handler that wants the same status throws this itself, the same way it
 * already throws `NotFoundException` for a domain-level 404 (issue #182).
 */
export class ForbiddenException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_FORBIDDEN", options);
  }
}

export class ConflictException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_CONFLICT", options);
  }
}

/**
 * A write whose payload references a related row that does not exist — a
 * dangling foreign key on insert or update (`{ "word": { "id": "…" } }`
 * naming an id with no matching row) → 422. Distinct from
 * {@link ConflictException} (409): nothing in existing state conflicts, the
 * request just points at something absent, so the fix is to correct the id
 * and retry rather than to stop. A blocked *delete* — the row is still
 * referenced by children — stays a {@link ConflictException}: that one is a
 * genuine conflict with current state. Raised only by an adapter's
 * `mapDriverError` table from a driver-level FK violation, never by the
 * engine directly.
 */
export class UnresolvedRelationException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_UNRESOLVED_RELATION", options);
  }
}

/**
 * A `replace`-strategy array-mutation body (`PUT /entity/:id/relation`) that
 * is not the shape ADR-0014 defines for a to-many association — an array of
 * scalar ids / `{ id }` references, or `null` — → 400. `replace` disables
 * partial mutation outright (no `{ add: [...] }`/`{ remove: [...] }` shape,
 * no JSON Patch ops), so a body attempting one is this, not a silent
 * narrowing the way a deep nested write is silently narrowed elsewhere.
 */
export class ArrayMutationInvalidShapeException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_ARRAY_MUTATION_INVALID_SHAPE", options);
  }
}

/**
 * A single-key relation's write value on `create`/`update`/`patch` was a
 * bare scalar (`{"product": "<uuid>"}`) instead of the reference object
 * ADR-0014 requires (`{"product": {"id": "<uuid>"}}`) → 400. Previously a
 * bare scalar was silently accepted as shorthand for the reference object;
 * that shorthand made a caller's intent ambiguous — was `"<uuid>"` the
 * related row's id, or a value for some other field named `product`? — and
 * masked the shape of the actual foreign key when it was wrong (issue
 * #291). The deserializer now rejects it outright rather than guessing.
 */
export class AssociationInvalidShapeException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_ASSOCIATION_INVALID_SHAPE", options);
  }
}

/**
 * `arrayMutation`'s `jsonPatch` strategy: a `PATCH /entity/:id` array body
 * that is not a well-formed RFC 6902 document within Kavo's supported
 * subset → 400. Covers a malformed op (missing/invalid `op`, `path`, or
 * `value`), an unsupported `op` for its path shape (only `add`/`replace`
 * are legal on a `/<field>` path, only `add`/`remove` on a `/<relation>/-`
 * path), and a `path` naming neither a writable field nor a write-opted-in
 * relation of the entity. Whether a relation *member* named by `value`
 * actually exists is a request-time question the write path answers
 * instead — {@link NotFoundException} for `add`, {@link
 * JsonPatchTargetNotFoundException} for `remove` — not this exception.
 */
export class JsonPatchInvalidDocumentException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_JSON_PATCH_INVALID_DOCUMENT", options);
  }
}

/**
 * `arrayMutation`'s `jsonPatch` strategy: a `remove` op targeting a
 * relation member id that is not currently associated with the row → 404.
 * RFC 6902 requires a `remove`'s target location to exist; Kavo enforces
 * that explicitly rather than treating it as a silent no-op, so a client
 * removing a member that already isn't linked finds out, rather than
 * getting a 200 that changed nothing it asked for.
 */
export class JsonPatchTargetNotFoundException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_JSON_PATCH_TARGET_NOT_FOUND", options);
  }
}

/**
 * `arrayMutation`'s `resource` strategy (ADR-0029's resource amendment): a
 * `DELETE /entity/:id/relation` naming a member id that is not currently
 * associated with the row → 404. The strategy-neutral counterpart of
 * {@link JsonPatchTargetNotFoundException} — same rule ("a removal that
 * changes nothing is an error, not a silent no-op"), raised under its own
 * code because a `resource` client's `DELETE` never carries a JSON Patch
 * document for that exception's title to describe accurately.
 */
export class ArrayMutationMemberNotFoundException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_ARRAY_MUTATION_MEMBER_NOT_FOUND", options);
  }
}

/**
 * `patchOne`'s body carried no field changes to apply — either the raw
 * body was empty, or every key it did carry (id, the soft-delete marker)
 * is stripped as immutable before it would reach the write. `updateOne`
 * (full replace) is unaffected: this is patch-specific, raised only by the
 * partial-write path, never the PUT one.
 */
export class PatchNoChangesException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_PATCH_NO_CHANGES", options);
  }
}

export class PersistenceException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_PERSISTENCE_FAILED", options);
  }
}

export class TransactionException extends KavoException {
  /** Whether retrying the whole transaction may succeed (deadlocks do). */
  readonly retryable: boolean;

  constructor(options: KavoExceptionOptions & { readonly retryable?: boolean } = {}) {
    super("KAVO_TRANSACTION_FAILED", options);
    this.retryable = options.retryable ?? false;
  }
}

/** Soft-deleting a row that is already soft-deleted → 409. */
export class AlreadyDeletedException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_ALREADY_DELETED", options);
  }
}

/**
 * Restoring — or purging — a row that is not deleted → 409.
 * Both operations act on soft-deleted rows only; a live row is a state
 * conflict, not a missing one.
 */
export class NotDeletedException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_NOT_DELETED", options);
  }
}

/**
 * An `If-Match` precondition whose tokens do not include the target's
 * current ETag → 412. Distinct from {@link ConflictException} (409): a
 * conflict is the database refusing the write, this is Kavo refusing to
 * attempt it because the client is acting on a version it never saw
 * (ADR-0020). A target with no current representation is never this: the
 * check falls through to the handler, which raises whatever that operation
 * raises for it ({@link NotFoundException} for a row that is gone,
 * {@link AlreadyDeletedException} for a `deleteOne` on a soft-deleted one)
 * — so an error's identity never depends on whether a cache header was
 * sent.
 */
export class PreconditionFailedException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_PRECONDITION_FAILED", options);
  }
}

/**
 * An `If-Match` the engine cannot evaluate at all → 412. Three ways to get
 * here, all of them configuration or operation shape rather than a race:
 * the operation does not target one identified row (`createOne`, any
 * custom operation), `cache.etag` is off for the operation in force, or
 * `findOne` is not an enabled operation so there is no canonical
 * representation to compare against (ADR-0020 §4).
 *
 * Distinct from {@link PreconditionFailedException} because the fix is
 * different — that one says "re-read and retry", this one says "this guard
 * cannot be honored here at all", and retrying it will never succeed. Both
 * are 412: the request did not happen, which is what an `If-Match` client
 * must be able to rely on.
 */
export class PreconditionUnsupportedException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_PRECONDITION_UNSUPPORTED", options);
  }
}

/** Calling an operation whose registry entry is disabled. */
export class OperationDisabledException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_OPERATION_DISABLED", options);
  }
}

/**
 * Calling an operation the registry has no entry for at all — a misspelled
 * id, or a custom operation that was never registered. Distinct from
 * {@link OperationDisabledException} at the same 405: "disabled" says the
 * entry exists and can be switched on, which for a registry miss is simply
 * untrue, and `messageKey` (= the code) is what a localizing consumer
 * re-renders from.
 *
 * Unreachable over HTTP — route generation walks the same registry, so an
 * unregistered id has no route — which is exactly why the falsehood
 * survived: only programmatic callers ever saw it.
 */
export class OperationNotRegisteredException extends KavoException {
  constructor(options: KavoExceptionOptions = {}) {
    super("KAVO_OPERATION_NOT_REGISTERED", options);
  }
}

/**
 * Bootstrap-time configuration error. Never a wire response — it fires
 * before the app serves traffic, and it must name the entity, the key
 * path, and the offending value (error quality bar).
 */
export class ConfigurationException extends KavoException {
  constructor(entity: string, path: string, problem: string) {
    super("KAVO_CONFIG_INVALID", {
      messageParams: { entity, path, problem },
      context: { entityName: entity },
    });
  }
}
