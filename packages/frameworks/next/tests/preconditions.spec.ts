import { describe, expect, it } from "vitest";
import { parseEntityTags, readPreconditions } from "@kavo/next";

describe("parseEntityTags", () => {
  it("returns undefined for an absent header", () => {
    expect(parseEntityTags(null)).toBeUndefined();
  });

  it("parses one or more quoted tags, weak tags included", () => {
    expect(parseEntityTags('"a", W/"b"')).toEqual(['"a"', 'W/"b"']);
  });

  it("parses the wildcard", () => {
    expect(parseEntityTags("*")).toEqual(["*"]);
  });

  it("returns an empty array — not undefined — for a present but empty header", () => {
    expect(parseEntityTags("")).toEqual([]);
    expect(parseEntityTags(",,,")).toEqual([]);
  });
});

describe("readPreconditions", () => {
  it("returns null when neither header is present", () => {
    expect(readPreconditions(new Headers())).toBeNull();
  });

  it("reads If-Match and If-None-Match independently", () => {
    const headers = new Headers({ "If-Match": '"abc"', "If-None-Match": '"def", "ghi"' });
    expect(readPreconditions(headers)).toEqual({ ifMatch: ['"abc"'], ifNoneMatch: ['"def"', '"ghi"'] });
  });

  it("omits a key whose header is absent rather than defaulting it", () => {
    const headers = new Headers({ "If-Match": '"abc"' });
    expect(readPreconditions(headers)).toEqual({ ifMatch: ['"abc"'] });
  });
});
