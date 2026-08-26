import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { map } from "rxjs";
import type { KavoResponse } from "@kavo/core";

/**
 * What this needs from the outgoing response, duck-typed rather than
 * imported: `header`/`status` are spelled the same on an Express `res` and
 * a Fastify `reply`, so one interceptor serves both adapters. Same trick,
 * and same reason, as `ProblemResponse` in `kavo-exception.filter.ts`.
 */
interface ConditionalResponse {
  header(name: string, value: string): unknown;
  status(code: number): unknown;
}

const NOT_MODIFIED = 304;

/**
 * The one place a generated route's `KavoResponse` becomes an HTTP
 * response: the `ETag` header is set from the envelope, a not-modified
 * read becomes a bodyless `304`, and everything else is unwrapped to the
 * `item` or the list envelope the client actually expects (ADR-0020).
 *
 * Applied method-scoped, by `@Kavo`, to every method it routes —
 * generated and `@Override`'d alike. It acts only on an engine envelope
 * (`isKavoResponse`), and an override reaches it holding one either way:
 * `applyOverrideEtag` promotes a bare return into an envelope carrying the
 * tag before this runs (ADR-0027). What an override returning
 * `service.engine.execute(...)` gets that a bare return does not is the
 * `304`, since `notModified` is the engine's answer against the request's
 * own `If-None-Match` and the promotion has no preconditions to consult.
 * Being the innermost interceptor, it unwraps before any controller- or
 * app-level interceptor sees the result, so nothing downstream ever meets
 * the envelope.
 *
 * That position cuts the other way for the `ETag`: it is computed from the
 * representation the engine produced, and set before any outer
 * interceptor runs. An app interceptor that rewrites the body downstream
 * of this one — redacting fields per role, say — leaves a tag of the
 * *unredacted* representation next to a redacted body. Field-level
 * shaping belongs in the DTO, which the engine serializes through, not in
 * an interceptor sitting outside it.
 *
 * Setting the status here works because Nest applies the route's static
 * `@HttpCode` *before* interceptors run and does not re-apply it when
 * replying, so a later `status()` call is the one that survives.
 */
export class KavoResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((value) => unwrap(context, value)));
  }
}

function unwrap(context: ExecutionContext, value: unknown): unknown {
  if (!isKavoResponse(value)) {
    return value;
  }
  const response = context.switchToHttp().getResponse<ConditionalResponse>();
  if (value.etag !== null) {
    response.header("ETag", value.etag);
  }
  if (value.notModified) {
    response.status(NOT_MODIFIED);
    return undefined;
  }
  // Void operations leave both slots null, which becomes an empty body.
  return value.list ?? value.item;
}

/**
 * Whether a handler's return value is an engine envelope.
 *
 * Exported because `@Kavo` needs the same question answered before it
 * promotes a bare `@Override` return (ADR-0027), and two copies with
 * different key sets would drift: the looser one would treat a value as an
 * envelope, skip the promotion, and then this one would pass the raw object
 * through as the response body, envelope keys and all.
 *
 * @internal
 */
export function isKavoResponse(value: unknown): value is KavoResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "operation" in value &&
    "item" in value &&
    "list" in value &&
    "etag" in value &&
    "notModified" in value
  );
}
