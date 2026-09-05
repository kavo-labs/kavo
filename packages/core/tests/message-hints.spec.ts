import { describe, expect, it } from "vitest";
// Deliberately a deep import: `message-hints` is internal, kept off the
// barrel because `detail` prose is not public API (ADR-0009 fixes the
// document shape, not its English). A test may reach its own package's src.
import { allowlistHint, nameList, suggestName } from "../src/errors/message-hints.js";

describe("suggestName", () => {
  const fields = ["email", "id", "name", "createdAt"];

  it("suggests the candidate one edit away", () => {
    expect(suggestName("emai", fields)).toBe("email");
    expect(suggestName("names", fields)).toBe("name");
  });

  it("treats a transposition as the single typo it is, even on a short name", () => {
    // Plain Levenshtein charges a swap two edits, which puts it outside a
    // four-letter name's budget — and a swap is the typo people make.
    expect(suggestName("nmae", fields)).toBe("name");
    expect(suggestName("emial", fields)).toBe("email");
  });

  it("suggests across a case difference", () => {
    expect(suggestName("Email", fields)).toBe("email");
  });

  it("suggests nothing for an unrelated name", () => {
    expect(suggestName("password", fields)).toBeUndefined();
  });

  it("suggests nothing when there are no candidates", () => {
    expect(suggestName("email", [])).toBeUndefined();
  });

  it("never suggests the input back to itself", () => {
    expect(suggestName("email", fields)).toBeUndefined();
  });

  it("holds short names to one edit, so 'id' does not become 'at'", () => {
    // At two edits every three-letter name reaches every other one, and a
    // confidently wrong suggestion is worse than none.
    expect(suggestName("idx", ["at", "on"])).toBeUndefined();
    expect(suggestName("idx", ["id"])).toBe("id");
  });

  it("picks the closest candidate when several are within reach", () => {
    expect(suggestName("titl", ["title", "titles"])).toBe("title");
  });

  it("tolerates two edits once the name is long enough", () => {
    expect(suggestName("creatdAtt", fields)).toBe("createdAt");
  });
});

describe("nameList", () => {
  it("renders a short list in sorted order", () => {
    expect(nameList(["name", "email", "id"])).toBe("email, id, name");
  });

  it("says 'none' for an empty set — the answer on an entity with no edges", () => {
    expect(nameList([])).toBe("none");
  });

  it("truncates a long list and reports the true total", () => {
    const many = Array.from({ length: 200 }, (_unused, index) => `f${String(index).padStart(3, "0")}`);
    const rendered = nameList(many);
    expect(rendered).toContain("(200 total)");
    expect(rendered.split(", ")).toHaveLength(11); // 10 names + the "… (200 total)" tail
    expect(rendered).not.toContain("f011");
  });

  it("renders exactly at the cap without truncating", () => {
    const ten = Array.from({ length: 10 }, (_unused, index) => `f${index}`);
    expect(nameList(ten)).not.toContain("total");
  });
});

describe("allowlistHint", () => {
  it("names the near miss, the permitted set, and the config key", () => {
    const hint = allowlistHint("emial", "filtering", "User", ["email", "id"]);
    expect(hint).toContain("Did you mean 'email'?");
    expect(hint).toContain("Filterable fields on User: email, id.");
    expect(hint).toContain("add it to filter.fields on the User config");
  });

  it("makes the allowlist advice conditional on the field being a real column", () => {
    // An allowlist accepts whatever the config declares — nothing checks it
    // against `EntityMetadata` — so "add it to allowed.sortable" stated
    // flatly would trade this 400 for a 500 out of the driver the next time
    // the developer sorts by their typo.
    expect(allowlistHint("nmae", "sorting", "User", ["name", "id"])).toContain("If User has a 'nmae' column");
  });

  it("omits the suggestion when nothing is close", () => {
    expect(allowlistHint("password", "filtering", "User", ["email", "id"])).not.toContain("Did you mean");
  });

  it("names the allowlist key matching the usage", () => {
    expect(allowlistHint("x", "sorting", "User", ["id"])).toContain("sort.fields");
    expect(allowlistHint("x", "selection", "User", ["id"])).toContain("select.fields");
    expect(allowlistHint("x", "sorting", "User", ["id"])).toContain("Sortable fields on User");
    expect(allowlistHint("x", "selection", "User", ["id"])).toContain("Selectable fields on User");
  });
});
