import type { KavoExceptionShape } from "@kavo/core";
import { KavoException, renderMessage, toProblemDetails } from "@kavo/core";

/**
 * Wraps whatever reaches the route handler that is not a `KavoException`
 * into the same `KavoExceptionShape` contract `toProblemDetails` serializes
 * — problem-details stays the one wire error shape (ADR-0009) even for an
 * error that never passed through `KavoEngine.execute` (malformed request
 * JSON, a bug in a caller-supplied handler that escapes the engine's own
 * `errorHandler.handle`). Unlike `@kavo/nest`'s `toKavoExceptionShape`,
 * there is no `HttpException` concept here to special-case — App Router
 * route handlers only ever throw plain errors or a `KavoException`.
 */
export function toKavoExceptionShape(exception: unknown): KavoExceptionShape {
  return {
    code: "KAVO_UNEXPECTED_ERROR",
    status: 500,
    messageKey: "KAVO_UNEXPECTED_ERROR",
    messageParams: {},
    detail: renderMessage("KAVO_UNEXPECTED_ERROR", {}),
    context: {},
    cause: exception,
  };
}

/**
 * The one boundary between an error and an HTTP response: every
 * `KavoException` becomes its RFC 9457 problem-details document with the
 * status from the error catalog (ADR-0009); anything else is normalized
 * through {@link toKavoExceptionShape} first. Mirrors `@kavo/nest`'s
 * `KavoExceptionFilter`.
 */
export function toErrorResponse(exception: unknown, options: { readonly exposeInternals?: boolean } = {}): Response {
  const shape = exception instanceof KavoException ? exception : toKavoExceptionShape(exception);
  const body = toProblemDetails(shape, { exposeInternals: options.exposeInternals ?? false });
  return new Response(JSON.stringify(body), {
    status: shape.status,
    headers: { "Content-Type": "application/problem+json" },
  });
}
