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

  it("decodes a percent-encoded id", () => {
    expect(matchRoute(route(":id"), ["a%20b"])).toEqual({ id: "a b" });
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
