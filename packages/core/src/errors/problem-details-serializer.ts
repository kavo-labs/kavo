import type { KavoExceptionShape } from "./kavo-exception-shape.js";
import type { ProblemDetailsDto } from "./problem-details.js";
import { ERROR_CATALOG } from "./error-catalog.js";
import { QueryValidationException } from "./exceptions.js";

/** Base URI under which every problem `type` lives (ADR-0009). */
const PROBLEM_TYPE_BASE = "https://kavo.dev/errors/";

/** `KAVO_NOT_FOUND` → `https://kavo.dev/errors/kavo-not-found`. */
function problemTypeFor(code: string): string {
  return PROBLEM_TYPE_BASE + code.toLowerCase().replace(/_/g, "-");
}

export interface ProblemDetailsOptions {
  /**
   * Leak driver-level `cause` details into the response (the
   * `errors.exposeInternals` setting) — off by default.
   */
  readonly exposeInternals?: boolean;
}

/**
 * Serialize a Kavo exception into the RFC 9457 problem-details document
 * This is the default wire shape; a consumer wanting a
 * different one swaps this serializer, never the exception hierarchy.
 */
export function toProblemDetails(
  exception: KavoExceptionShape,
  options: ProblemDetailsOptions = {},
): ProblemDetailsDto {
  const catalog = ERROR_CATALOG[exception.code as keyof typeof ERROR_CATALOG];
  const detail =
    options.exposeInternals && exception.cause !== undefined
      ? `${exception.detail} [cause: ${describeCause(exception.cause)}]`
      : exception.detail;

  return {
    type: problemTypeFor(exception.code),
    title: catalog?.title ?? "Error",
    status: exception.status,
    detail,
    ...(exception.context.correlationId !== undefined && {
      instance: `urn:kavo:request:${exception.context.correlationId}`,
    }),
    code: exception.code,
    ...(exception instanceof QueryValidationException && {
      errors: exception.issues,
    }),
  };
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}
