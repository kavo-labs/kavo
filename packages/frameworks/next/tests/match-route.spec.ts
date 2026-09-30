import { describe, expect, it } from "vitest";
import { matchRoute } from "@kavo/next";
import type { ResolvedRoute } from "@kavo/next";

function route(path: string): ResolvedRoute {
  return { method: "GET", path, status: 200, hasIdParam: path.includes(":id") };
}

describe("matchRoute", () => {
  it("matches an empty (collection) template against no remaining segments", () => {
    expect(matchRoute(route(""), [])).toEqual({ id: null });
  });

  it("matches a bare :id template and captures the segment", () => {
    expect(matchRoute(route(":id"), ["42"])).toEqual({ id: "42" });
  });

  it("captures an id exactly as Next.js decoded it, never decoding it a second time", () => {
    // Next.js has already decoded the URL's `%2531` to `%31`; a second decode
    // would serve the id `1` instead.
    expect(matchRoute(route(":id"), ["%31"])).toEqual({ id: "%31" });
    expect(matchRoute(route(":id"), ["a b"])).toEqual({ id: "a b" });
    expect(matchRoute(route(":id"), ["..%2F..%2Fetc"])).toEqual({ id: "..%2F..%2Fetc" });
  });

  it("keeps an id that is not valid percent-encoding verbatim instead of throwing", () => {
    // Decoding `%` used to throw URIError, a 500 (issue #493).
    expect(matchRoute(route(":id"), ["%"])).toEqual({ id: "%" });
    expect(matchRoute(route(":id"), ["100%off"])).toEqual({ id: "100%off" });
  });

  it("matches literal segments alongside :id", () => {
    expect(matchRoute(route(":id/restore"), ["7", "restore"])).toEqual({ id: "7" });
  });

  it("rejects a mismatched literal segment", () => {
    expect(matchRoute(route(":id/restore"), ["7", "purge"])).toBeNull();
  });

  it("rejects a different segment count", () => {
    expect(matchRoute(route(":id"), [])).toBeNull();
    expect(matchRoute(route(""), ["extra"])).toBeNull();
    expect(matchRoute(route(":id/restore"), ["7"])).toBeNull();
  });

  it("matches a custom operation's single literal segment", () => {
    expect(matchRoute(route("markPaidOne"), ["markPaidOne"])).toEqual({ id: null });
    expect(matchRoute(route("markPaidOne"), ["other"])).toBeNull();
  });
});
