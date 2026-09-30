import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Supply-chain hardening for every GitHub Actions workflow, as assertions.
 *
 * Two properties, checked across the whole `.github/workflows/` directory so a
 * workflow added later is covered the day it lands:
 *
 *   1. Every action is pinned to a full commit SHA. A tag (`@v7`) is a mutable
 *      pointer: whoever controls the action's repository can move it, and the
 *      next run executes whatever it now points at, with this workflow's
 *      token. The SHA carries a `# vX.Y.Z` comment so a human can still read
 *      which release it is.
 *   2. Write scopes are granted per job, never at the workflow level, and
 *      `id-token: write` only to the three jobs that exchange an OIDC token
 *      for something: npm trusted publishing, the Pages deployment, and the
 *      Scorecard upload. A workflow-level grant hands the scope to every job,
 *      including the ones that install dependencies and run third-party code.
 *
 * `ci-workflow.spec.ts` and `release-workflow.spec.ts` pin each workflow's
 * behavior; this file pins only what every workflow must share.
 */

const WORKFLOWS_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)), ".github/workflows");

// Comments are stripped, so a key spelled out in prose never counts as a
// grant — except on `uses:` lines, whose trailing `# vX.Y.Z` is asserted on.
const workflows = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.endsWith(".yml"))
  .map((file) => {
    const raw = readFileSync(resolve(WORKFLOWS_DIR, file), "utf8");
    const code = raw
      .split("\n")
      .map((line) => line.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, ""))
      .filter((line) => line.trim() !== "")
      .join("\n");
    const jobsAt = code.search(/^jobs:$/m);
    const topLevel = code.slice(0, jobsAt);
    const jobs = [...code.slice(jobsAt).matchAll(/^ {2}([\w-]+):\n((?:(?: {3,}.*)\n?)*)/gm)].map(([, name, body]) => ({
      name: name ?? "",
      body: body ?? "",
    }));
    return { file, raw, topLevel, jobs };
  });

/** Every scope a job-level `permissions:` block grants `write` on. */
function jobWriteScopes(body: string): string[] {
  const block = /^ {4}permissions:\n((?: {6}.+\n?)+)/m.exec(body)?.[1] ?? "";
  return [...block.matchAll(/^ {6}([\w-]+): write$/gm)].map(([, scope]) => scope ?? "");
}

describe("GitHub Actions workflows", () => {
  it("finds the workflows it guards", () => {
    expect(workflows.map(({ file }) => file)).toEqual(
      expect.arrayContaining(["ci.yml", "pages.yml", "publish.yml", "release-please.yml"]),
    );
    for (const { file, jobs } of workflows) {
      expect(jobs.length, file).toBeGreaterThan(0);
    }
  });

  it.each(workflows.map((workflow) => [workflow.file, workflow] as const))(
    "%s pins every action to a full commit SHA with its release tag in a comment",
    (_file, { raw }) => {
      const uses = [...raw.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].filter(([, ref]) => !ref?.startsWith("./"));
      expect(uses.length).toBeGreaterThan(0);
      for (const [line, ref, rest] of uses) {
        expect(ref, line).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(rest, line).toMatch(/^ # v\d+(\.\d+){0,2}$/);
      }
    },
  );

  it.each(workflows.map((workflow) => [workflow.file, workflow] as const))(
    "%s grants no write scope at the workflow level",
    (_file, { topLevel }) => {
      expect(topLevel).toMatch(/^permissions:/m);
      expect(topLevel).not.toMatch(/:\s*write\b/);
      expect(topLevel).not.toMatch(/^permissions:\s*write-all$/m);
    },
  );

  it("grants id-token: write only to the jobs that exchange an OIDC token", () => {
    const holders = workflows.flatMap(({ file, jobs }) =>
      jobs.filter(({ body }) => jobWriteScopes(body).includes("id-token")).map(({ name }) => `${file}#${name}`),
    );
    expect(holders.sort()).toEqual(["pages.yml#deploy", "publish.yml#publish", "scorecard.yml#analysis"]);
  });

  it("keeps the Pages deployment token off the job that builds the docs", () => {
    const pages = workflows.find(({ file }) => file === "pages.yml");
    const build = pages?.jobs.find(({ name }) => name === "build");
    expect(build?.body).toContain("pnpm install");
    expect(jobWriteScopes(build?.body ?? "")).toEqual([]);
  });

  it("gives release-please's two jobs only the write scopes each uses", () => {
    const releasePlease = workflows.find(({ file }) => file === "release-please.yml");
    const scopes = Object.fromEntries(
      (releasePlease?.jobs ?? []).map(({ name, body }) => [name, jobWriteScopes(body).sort()]),
    );
    expect(scopes).toEqual({ "release-please": ["contents", "pull-requests"], publish: ["actions"] });
  });
});
