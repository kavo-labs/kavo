import type { ResolvedRoute } from "./resolve-route.js";

/** A route's path template split into segments, `""`/`:id` included verbatim. */
function templateSegments(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

export interface RouteMatch {
  readonly id: string | null;
}

/**
 * Whether `segments` (the entity's catch-all remainder, after the entity
 * key) matches `route`'s path template — `:id` matches exactly one segment
 * and captures it, everything else must match literally. `null` when the
 * segment count or a literal segment disagrees, which the caller turns into
 * a 404 rather than a 405: an unmatched method/segment pair on a known
 * entity is indistinguishable, from the outside, from a route that was
 * never configured at all.
 *
 * Segments are used exactly as Next.js hands them over, never decoded again:
 * Next.js has already percent-decoded its catch-all params, so a second
 * `decodeURIComponent` would turn `%2531` (the id `%31`) into `1`, serving
 * a different id than the one host middleware saw in the URL.
 */
export function matchRoute(route: ResolvedRoute, segments: readonly string[]): RouteMatch | null {
  const template = templateSegments(route.path);
  if (template.length !== segments.length) {
    return null;
  }
  let id: string | null = null;
  for (let i = 0; i < template.length; i++) {
    const templateSegment = template[i] as string;
    const actual = segments[i] as string;
    if (templateSegment === ":id") {
      id = actual;
      continue;
    }
    if (templateSegment !== actual) {
      return null;
    }
  }
  return { id };
}
