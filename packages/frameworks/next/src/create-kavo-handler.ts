import type { DefaultKavoService, KavoRequest, RequestPreconditions } from "@kavo/core";
import { WireQuery } from "@kavo/core";
import { toErrorResponse } from "./error-response.js";
import { matchRoute } from "./match-route.js";
import { toResponse } from "./kavo-response.js";
import { parseWireParams } from "./query-params.js";
import { readPreconditions } from "./preconditions.js";
import { BODYLESS_WRITES, resolveRoute } from "./resolve-route.js";
import type { KavoHttpMethod } from "./route-metadata.js";

/**
 * One entity's bound service — what `createCrud(Entity, config?, runtime?)`
 * returns. Keyed by the App Router segment that addresses it
 * (`{ users: usersCrud }` → `/api/<mount>/users/...`). `DefaultKavoService<object>`
 * is the same erased-generics shape `@kavo/nest` binds its own
 * `KAVO_SERVICE_PROPERTY` as — the entity type is not statically known at
 * this boundary either way.
 */
export type KavoHandlerEntities = Readonly<Record<string, DefaultKavoService<object>>>;

export interface KavoHandlerOptions {
  /**
   * Whether a problem-details body includes internal detail (an unexpected
   * error's message, a validation issue's raw context) — the same knob
   * `@kavo/nest`'s `KavoModuleOptions.defaults.errors.exposeInternals`
   * gates. Defaults to `false`.
   */
  readonly exposeInternals?: boolean;
}

export type KavoRouteHandler = (
  request: Request,
  context: { params: Record<string, string | readonly string[]> | Promise<Record<string, string | readonly string[]>> },
) => Promise<Response>;

export interface KavoRouteHandlers {
  readonly GET: KavoRouteHandler;
  readonly POST: KavoRouteHandler;
  readonly PUT: KavoRouteHandler;
  readonly PATCH: KavoRouteHandler;
  readonly DELETE: KavoRouteHandler;
}

const NOT_FOUND = new Response(JSON.stringify({ title: "Not Found", status: 404 }), {
  status: 404,
  headers: { "Content-Type": "application/problem+json" },
});

async function resolveSegments(context: Parameters<KavoRouteHandler>[1]): Promise<readonly string[]> {
  const params = await context.params;
  for (const value of Object.values(params)) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

/**
 * The App Router equivalent of `@kavo/nest`'s registry-driven route
 * generation (ADR-0006), for a mount with no decorator/DI container to
 * generate static routes at all: every call walks each entity's operation
 * registry — the same one `createCrud` built and `@Kavo` would read — and
 * resolves the first enabled entry whose route matches the request's
 * method and remaining path segments.
 *
 * ```ts
 * // app/api/[...kavo]/route.ts
 * export const { GET, POST, PATCH, DELETE } = createKavoHandler({
 *   users: usersCrud,
 *   projects: projectsCrud,
 * });
 * ```
 *
 * An unknown entity key, or a method/segment combination no enabled
 * operation resolves to, answers `404` — never `500`, and never a bare
 * `405`, since a route that was never configured for this entity is
 * indistinguishable, from the outside, from one that does not exist.
 *
 * Custom operations (`operations.<id>` outside the standard eight) dispatch
 * exactly like standard ones — same registry, same `meta.routes`
 * convention (`resolveRoute`) — addressed by their configured route
 * segment. There is no manual-method-wins here: with no class to override,
 * a caller who wants a custom path wins by Next.js's own routing rules
 * instead — a sibling, more specific route file (e.g.
 * `app/api/users/[id]/activate/route.ts`) is matched by Next.js before this
 * catch-all ever runs.
 */
export function createKavoHandler(entities: KavoHandlerEntities, options: KavoHandlerOptions = {}): KavoRouteHandlers {
  const handle = async (request: Request, context: Parameters<KavoRouteHandler>[1]): Promise<Response> => {
    try {
      const segments = await resolveSegments(context);
      const [entityKey, ...rest] = segments;
      if (entityKey === undefined) {
        return NOT_FOUND;
      }
      const service = entities[entityKey];
      if (service === undefined) {
        return NOT_FOUND;
      }

      const method = request.method as KavoHttpMethod;
      const registry = service.engine.registry;
      let matched: { readonly id: string | null; readonly status: number; readonly operation: string } | null = null;
      let matchedKind: "read" | "write" | null = null;
      for (const descriptor of registry.all()) {
        if (!descriptor.enabled) {
          continue;
        }
        const route = resolveRoute(descriptor);
        if (route === null || route.method !== method) {
          continue;
        }
        const match = matchRoute(route, rest);
        if (match === null) {
          continue;
        }
        matched = { id: match.id, status: route.status, operation: descriptor.id };
        matchedKind = descriptor.kind;
        break;
      }
      if (matched === null || matchedKind === null) {
        return NOT_FOUND;
      }

      const bodylessWrite = BODYLESS_WRITES.has(matched.operation as never);
      const body = method === "GET" || method === "DELETE" || bodylessWrite ? null : await readBody(request);
      const url = new URL(request.url);
      const query = matchedKind === "read" ? new WireQuery(parseWireParams(url.searchParams)) : null;
      const preconditions: RequestPreconditions | null = readPreconditions(request.headers);

      const kavoRequest: KavoRequest<object> = {
        operation: matched.operation as never,
        id: matched.id as never,
        body: body as never,
        query: query as never,
        options: null,
        preconditions,
      };
      const response = await service.engine.execute(kavoRequest);
      return toResponse(response, matched.status);
    } catch (error) {
      return toErrorResponse(error, { exposeInternals: options.exposeInternals });
    }
  };

  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
}
