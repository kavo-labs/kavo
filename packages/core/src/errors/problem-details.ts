import type { KavoErrorCode } from "./kavo-exception-shape.js";

/**
 * One `errors[]` entry. Query-grammar issues (from `QueryValidationException`)
 * carry a `code` naming their precise sub-code; issues from a source with no
 * Kavo error code of its own (a framework-level body-validation failure,
 * issue #437) omit it — the array stays homogeneous either way, one entry
 * per offending field.
 */
export interface QueryIssueDto {
  /** The offending field or parameter as it appeared on the wire. */
  readonly field: string;
  readonly code?: KavoErrorCode;
  readonly detail: string;
}

/**
 * Default serialized error shape: an RFC 9457 problem-details document
 * with Kavo extensions. The `@kavo/nest` exception filter maps it 1:1;
 * anyone who wants a different wire shape swaps the serializer, not the
 * exception hierarchy.
 */
export interface ProblemDetailsDto {
  /** URI reference identifying the problem type. */
  readonly type: string;
  readonly title: string;
  /** HTTP status code. */
  readonly status: number;
  readonly detail: string;
  /** URI reference identifying this occurrence (correlation). */
  readonly instance?: string;
  /** Kavo extension: the stable catalog code. */
  readonly code: KavoErrorCode;
  /** Kavo extension: field-level query issues (400s from query validation). */
  readonly errors?: readonly QueryIssueDto[];
}
