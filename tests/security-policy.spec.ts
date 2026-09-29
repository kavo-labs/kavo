import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `SECURITY.md`'s supported-versions table decides which findings go through
 * a private advisory, so a stale table misroutes vulnerabilities. It used to
 * pin `0.21.x` while the packages shipped `0.23.x`: release-please bumps every
 * package.json (ADR-0041) but never this file. The table therefore states a
 * policy rather than a number, and this test keeps it that way.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const policy = readFileSync(resolve(REPO_ROOT, "SECURITY.md"), "utf8");
const start = policy.indexOf("## Supported Versions");
const end = policy.indexOf("## Reporting a Vulnerability");
const supported = policy.slice(start, end);

describe("SECURITY.md supported versions", () => {
  it("has the section this test reads", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
  });

  it("pins no concrete version, so a release bump can never leave it stale", () => {
    // No leading `\b`: in the repo's own tag format, `v0.23.4`, there is no
    // word boundary between `v` and `0`, so `\b` would let it through.
    expect(supported).not.toMatch(/\d+\.\d+\.(?:\d+|x|\*)/i);
  });

  it("supports the latest release and nothing older", () => {
    expect(supported).toMatch(/^\|\s*Latest release[^|]*\|\s*:white_check_mark:\s*\|\s*$/m);
    expect(supported).toMatch(/^\|\s*Any earlier release\s*\|\s*:x:\s*\|\s*$/m);
  });

  it("has exactly those two rows, so no extra version line can creep back in", () => {
    // Header, separator, and the two rows above: a `< 0.23` or `1.x` row would
    // pin a version without ever matching the three-part pattern.
    const tableLines = supported.split(/\r?\n/).filter((line) => line.trimStart().startsWith("|"));
    expect(tableLines).toHaveLength(4);
  });
});
