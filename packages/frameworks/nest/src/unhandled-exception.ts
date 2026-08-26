import { HttpException } from "@nestjs/common";
import type { KavoExceptionShape } from "@kavo/core";
import { renderMessage } from "@kavo/core";

/** `HttpException.getResponse()`'s shape when Nest built it from a string/object body. */
interface HttpExceptionBody {
  readonly message?: unknown;
}

function isHttpExceptionBody(value: unknown): value is HttpExceptionBody {
  return typeof value === "object" && value !== null;
}

/**
 * `HttpException.getResponse()` is a string for `new HttpException("msg", status)`,
 * or `{ statusCode, message, error }` for Nest's built-ins (`NotFoundException`,
 * a `ValidationPipe`'s `BadRequestException` with `message: string[]`). Either way
 * it is text the throw site meant a client to see — Nest's own default handler
 * would have shown it verbatim, with no `exposeInternals`-equivalent gate of
 * its own — so surfacing it here regardless of `exposeInternals` mirrors
 * Nest's existing behavior rather than exposing anything new. It is *not*
 * governed by `errors.exposeInternals` the way `KAVO_UNEXPECTED_ERROR`'s
 * `cause` is below — an app throwing `HttpException`s with internal detail
 * in the message was already showing that detail before this filter existed.
 */
function messageFrom(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === "string") {
    return response;
  }
  if (isHttpExceptionBody(response)) {
    const { message } = response;
    if (typeof message === "string") {
      return message;
    }
    if (Array.isArray(message)) {
      return message.join(" ");
    }
  }
  return exception.message;
}

/**
 * Wraps whatever reaches `KavoExceptionFilter` that is not a `KavoException`
 * into the same `KavoExceptionShape` contract `toProblemDetails` serializes,
 * so problem-details stays the one wire error shape (ADR-0009) even for
 * errors that never passed through `KavoEngine.execute` — a global
 * `ValidationPipe`, an unmatched route, a guard, or a bug in application
 * code outside a Kavo handler.
 *
 * Never adds a `KavoException` subclass for this: these are framework-level
 * errors Kavo did not raise and does not own the shape of, so the mapping
 * lives at the HTTP boundary, not in the hierarchy (see doc 06 §6).
 */
export function toKavoExceptionShape(exception: unknown): KavoExceptionShape {
  if (exception instanceof HttpException) {
    const detail = messageFrom(exception);
    return {
      code: "KAVO_HTTP_ERROR",
      // The catalog's status for this code is nominal (see its comment) —
      // this is the one place a shape's status legitimately disagrees with
      // its code's catalog entry, because the original `HttpException`
      // already picked the correct one.
      status: exception.getStatus(),
      messageKey: "KAVO_HTTP_ERROR",
      messageParams: { detail },
      detail: renderMessage("KAVO_HTTP_ERROR", { detail }),
      context: {},
    };
  }

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
