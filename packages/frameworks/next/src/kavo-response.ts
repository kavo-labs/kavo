import type { KavoResponse } from "@kavo/core";

const NOT_MODIFIED = 304;

/**
 * The one place a `KavoResponse` envelope becomes an HTTP `Response`:
 * mirrors `@kavo/nest`'s `KavoResponseInterceptor` exactly (ADR-0020) — the
 * `ETag` header is set from the envelope, a not-modified read becomes a
 * bodyless `304`, and everything else is unwrapped to the `item` or the
 * list envelope the client expects. `status` is the route's own success
 * status (`ResolvedRoute.status`), the equivalent of Nest's static
 * `@HttpCode`.
 */
export function toResponse(response: KavoResponse, status: number): Response {
  const headers = new Headers();
  if (response.etag !== null) {
    headers.set("ETag", response.etag);
  }
  if (response.notModified) {
    return new Response(null, { status: NOT_MODIFIED, headers });
  }
  const body = response.list ?? response.item;
  if (body === null || body === undefined) {
    return new Response(null, { status, headers });
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}
