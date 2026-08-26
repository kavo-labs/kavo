import type { ExecutionContext } from "@nestjs/common";
import { createParamDecorator } from "@nestjs/common";
import type { RequestPreconditions } from "@kavo/core";

/**
 * The only shape this needs from the incoming request. Node lower-cases
 * every header name it parses, and both Express and Fastify expose the
 * bag under `headers`, so no adapter-specific branch is needed.
 */
interface ConditionalRequestShape {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * One entity-tag: a quoted opaque tag (optionally weak), the wildcard, or
 * — as a forgiving last resort — a bare unquoted token, which is
 * non-conformant but common enough in hand-rolled clients that silently
 * dropping it would be worse than comparing it and failing to match.
 *
 * Matching quoted tags as a unit is what makes a comma *inside* a tag
 * safe, which a plain `split(",")` would get wrong.
 */
const ENTITY_TAG = /(?:W\/)?"[^"]*"|\*|[^\s,]+/g;

/**
 * `'"a", W/"b"'` → `['"a"', 'W/"b"']`; absent stays absent.
 *
 * A header that is *present* but yields no tags — `If-Match:` with an
 * empty value, or `If-Match: ,,,` — returns an empty array, **not**
 * `undefined`. The distinction is load-bearing: `undefined` means "the
 * client asked for no guard", while `[]` means "the client asked for a
 * guard and named nothing that can match", which RFC 9110 §13.1.1 makes a
 * condition that evaluates false. Collapsing the two would turn a
 * guarded write into an unguarded 2xx whenever a buggy client or an
 * intermediary normalized the value away.
 */
export function parseEntityTags(raw: string | string[] | undefined): readonly string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return (Array.isArray(raw) ? raw.join(",") : raw).match(ENTITY_TAG) ?? [];
}

/** @internal shared by the decorator and its tests. */
export function readPreconditions(request: ConditionalRequestShape): RequestPreconditions | null {
  const headers = request.headers ?? {};
  const ifMatch = parseEntityTags(headers["if-match"]);
  const ifNoneMatch = parseEntityTags(headers["if-none-match"]);
  if (ifMatch === undefined && ifNoneMatch === undefined) {
    return null;
  }
  return {
    ...(ifMatch === undefined ? {} : { ifMatch }),
    ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
  };
}

/**
 * `If-Match` / `If-None-Match` as a `RequestPreconditions`, for the
 * generated routes to hand the engine (ADR-0020). Applied programmatically
 * by `@Kavo` as the last parameter of every generated method, the same way
 * `@Param`/`@Query`/`@Body` are — an `@Override`'d method may declare it
 * too, and gets the identical value.
 */
export const ConditionalRequest = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestPreconditions | null =>
    readPreconditions(context.switchToHttp().getRequest<ConditionalRequestShape>()),
);
