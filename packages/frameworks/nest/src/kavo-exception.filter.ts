import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, Inject, Optional } from "@nestjs/common";
import { KavoException, toProblemDetails } from "@kavo/core";
import { KAVO_MODULE_OPTIONS } from "./tokens.js";
import type { KavoModuleOptions } from "./kavo-options.js";
import { toKavoExceptionShape } from "./unhandled-exception.js";

interface ProblemResponse {
  status(code: number): ProblemResponse;
  type(contentType: string): ProblemResponse;
  json(body: unknown): void;
}

/**
 * The one boundary between HTTP and every error the app can raise: every
 * `KavoException` becomes its RFC 9457 problem-details document with the
 * status from the error catalog (ADR-0009), and everything else — a
 * framework-level `HttpException`, or a genuinely unexpected error that
 * never passed through `KavoEngine.execute` — is normalized to the same
 * shape via {@link toKavoExceptionShape} rather than falling through to
 * Nest's own `{ statusCode, message, error }` default. Kavo exceptions
 * never extend Nest's — this filter is the mapping, not inheritance.
 *
 * Registered globally by `KavoModule.forRoot`, so it governs every route in
 * the app, not only `@Kavo`-generated ones — that is what "the one wire
 * error shape" (ADR-0009) means in practice. Consumers can also apply it
 * per controller with `@UseFilters`.
 */
@Catch()
export class KavoExceptionFilter implements ExceptionFilter {
  constructor(
    @Optional()
    @Inject(KAVO_MODULE_OPTIONS)
    private readonly options?: KavoModuleOptions,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // `@Catch()` with no token runs for every context type Nest supports
    // (ws, rpc), not only http — `@kavo/nest` only ever generates HTTP
    // routes, so outside an HTTP context this filter has nothing to map and
    // must not swallow the exception Nest's own per-transport handling
    // would otherwise see.
    if (host.getType() !== "http") {
      throw exception;
    }

    const shape = exception instanceof KavoException ? exception : toKavoExceptionShape(exception);
    const response = host.switchToHttp().getResponse<ProblemResponse>();
    const body = toProblemDetails(shape, {
      exposeInternals: this.options?.defaults?.errors?.exposeInternals ?? false,
    });
    response.status(shape.status).type("application/problem+json").json(body);
  }
}
