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
    expect(supported).not.toMatch(/\b\d+\.\d+\.(\d+|x)\b/);
  });

  it("supports the latest release and nothing older", () => {
    expect(supported).toMatch(/Latest release[^|]*\|\s*:white_check_mark:/);
    expect(supported).toMatch(/Any earlier release[^|]*\|\s*:x:/);
  });
});
