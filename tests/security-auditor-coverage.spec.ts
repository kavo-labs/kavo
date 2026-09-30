import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A re-audit is only as wide as the auditor's own scope (#499). When a package
 * lands in publish.yml's PACKAGE_DIRS but the `kavo-security-auditor` agent
 * definition never names it, every periodic and per-PR security pass silently
 * skips it.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const publish = readFileSync(resolve(REPO_ROOT, ".github/workflows/publish.yml"), "utf8");
const agent = readFileSync(resolve(REPO_ROOT, ".claude/agents/kavo-security-auditor.md"), "utf8");
const packageDirs = (/PACKAGE_DIRS: >-\n((?: {8}\S+\n)+)/.exec(publish)?.[1] ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

describe("kavo-security-auditor scope", () => {
  it("reads the published package list", () => {
    expect(packageDirs).toContain("packages/core");
    expect(packageDirs.length).toBeGreaterThanOrEqual(10);
  });

  it.each(packageDirs)("names %s", (dir) => {
    expect(agent).toContain(`\`${dir}\``);
  });
});
