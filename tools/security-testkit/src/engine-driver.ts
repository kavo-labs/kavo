import type { KavoRequest, KavoResponse } from "@kavo/core";
import { KavoException, WireQuery, toProblemDetails } from "@kavo/core";
import type { SecurityDriver, SecurityInput, SecurityResult } from "./driver.js";

/**
 * The adapter-layer driver: `engine.execute` over whatever adapter `service`
 * was built with, the query handed over as a `WireQuery` exactly as a REST
 * binding would. No HTTP, so a failure here is the engine's or the
 * adapter's, never a transport's. `status` is the thrown exception's own;
 * the body is the problem document a transport would serialize with
 * `exposeInternals` at its default.
 */
/** The one thing the driver needs from a `createCrud` service, typed loosely so any entity's service fits. */
export interface EngineOwner {
  // `never`: any entity's `execute` accepts a request this driver builds.
  readonly engine: { readonly execute: (request: never) => Promise<unknown> };
}

export function engineDriver(service: EngineOwner): SecurityDriver {
  return {
    surface: "engine",
    grammar: "wire",
    async call(operation: string, input: SecurityInput): Promise<SecurityResult> {
      try {
        const response = (await service.engine.execute({
          operation,
          id: input.id === undefined ? null : String(input.id),
          body: (input.body ?? null) as never,
          query: new WireQuery(input.query ?? {}) as never,
          options: null,
        } as KavoRequest<object> as never)) as KavoResponse;
        return { ok: true, status: 200, body: response.list ?? response.item };
      } catch (error) {
        if (error instanceof KavoException) {
          return { ok: false, status: error.status, code: error.code, body: toProblemDetails(error) };
        }
        throw error;
      }
    },
  };
}
