import type { OperationId } from "../operations/operation.js";
import type { QueryIssueDto } from "./problem-details.js";

/**
 * Stable, string-based error code. Codes are API surface: the full catalog
 * (code → HTTP status → when it fires → payload extensions) is defined
 * elsewhere, and renaming a code is a breaking change (semver
 * policy).
 */
export type KavoErrorCode = `KAVO_${string}`;

/** Where an error happened — attached to exceptions and problem details. */
export interface ErrorContext {
  readonly entityName?: string;
  readonly operation?: OperationId;
  readonly correlationId?: string;
}

/**
 * Contract every Kavo exception class satisfies. Deliberately
 * an interface, not a base class: `@kavo/core` ships types
 * only, and downstream layers (the `@kavo/nest` exception filter) program
 * against this shape, never against `instanceof`.
 *
 * Human-readable text is built from `messageKey` + `messageParams` so a
 * consumer can localize; `detail` carries the English default.
 */
export interface KavoExceptionShape {
  readonly code: KavoErrorCode;
  /** HTTP status this error maps to (from the error catalog). */
  readonly status: number;
  readonly messageKey: string;
  readonly messageParams: Readonly<Record<string, string | number>>;
  readonly detail: string;
  readonly context: ErrorContext;
  /**
   * Field-level issues that serialize into the problem-details `errors[]`
   * extension (ADR-0009) — query-grammar violations, or a framework-level
   * body-validation failure wrapped at the `@kavo/nest` boundary (issue
   * #437). Declared on the shape itself, not on one leaf class, so
   * `toProblemDetails` never needs an `instanceof` check to reach it.
   */
  readonly issues?: readonly QueryIssueDto[];
  /**
   * The original error when this wraps an adapter/driver failure — never
   * swallowed. Whether it leaks into responses is governed by the
   * `errors.exposeInternals` setting (off by default).
   */
  readonly cause?: unknown;
}

/**
 * Maps arbitrary thrown values to Kavo exceptions at the engine boundary.
 * Adapter errors are translated by the adapter's own mapping table
 * anything unrecognized becomes a `PersistenceException` with
 * the original as `cause`.
 */
export interface ErrorHandler {
  handle(error: unknown, context: ErrorContext): KavoExceptionShape;
}
