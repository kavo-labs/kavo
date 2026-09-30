import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The static half of the supply-chain track (#491, threat category 7):
 * what a published tarball may contain, and that the dependency audit
 * workflow keeps running. `workflow-permissions.spec.ts` covers action
 * pinning and token scopes for every workflow, this one included.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const publishWorkflow = readFileSync(resolve(REPO_ROOT, ".github/workflows/publish.yml"), "utf8");
const publishedDirs = (/PACKAGE_DIRS: >-\n((?: {8}\S+\n)+)/.exec(publishWorkflow)?.[1] ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

describe("published tarball contents", () => {
  it("finds the package list publish.yml releases", () => {
    expect(publishedDirs).toContain("packages/core");
    expect(publishedDirs.length).toBeGreaterThan(5);
  });

  // `files` is an allowlist; npm adds package.json, README and LICENSE on its
  // own. Anything wider (a `src`, a `tests`, a stray `.env` or tsbuildinfo)
  // would ship with every release.
  it.each(publishedDirs)("%s ships dist/ and nothing else it names", (dir) => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, dir, "package.json"), "utf8")) as {
      files?: readonly string[];
    };
    expect(manifest.files).toEqual(["dist"]);
    // An .npmignore would override `files` for anything under dist/.
    expect(existsSync(resolve(REPO_ROOT, dir, ".npmignore"))).toBe(false);
  });
});

describe("dependency audit workflow", () => {
  const audit = readFileSync(resolve(REPO_ROOT, ".github/workflows/dependency-audit.yml"), "utf8");

  it("audits production dependencies", () => {
    expect(audit).toMatch(/^\s+run: pnpm audit --prod$/m);
  });

  it("runs on lockfile changes, on a schedule, and on demand", () => {
    expect(audit).toMatch(/pull_request:\n\s+paths:\n(?:\s+- .+\n)*\s+- "pnpm-lock\.yaml"/);
    expect(audit).toMatch(/schedule:\n\s+- cron: "[^"]+"/);
    expect(audit).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it("installs nothing, so no dependency lifecycle script runs with the job's token", () => {
    expect(audit).not.toMatch(/pnpm install/);
  });
});
