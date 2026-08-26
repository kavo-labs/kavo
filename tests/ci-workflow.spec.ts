import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The CI split, and the README badges that report it, as assertions.
 *
 * `pnpm check` is the gate and is never worked around, but CI cannot run it
 * as one job and still say anything useful on a badge: a status badge reports
 * a job, never a step, so a single combined job can only ever say "CI
 * failing". `ci.yml` therefore splits the gate into `build` and `test`, and
 * the README badges each point at one of them by check-run name.
 *
 * That buys two ways to drift silently, which is what these tests close:
 *
 *   1. A step added to `pnpm check` that nobody adds to either CI job. The
 *      gate would still be green locally while CI quietly stopped running it.
 *   2. A job renamed in `ci.yml`. Shields matches a check run by exact name,
 *      so the badge does not go red — it goes blank ("check run not found"),
 *      which reads as "no signal" rather than "broken".
 *
 * Both files are read as text on purpose: they are the artifacts under test,
 * and a test that reimplemented their contents would pass while the real
 * pipeline drifted. That is the same reasoning as
 * `tests/release-workflow.spec.ts`.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/ci.yml");
const README_PATH = resolve(REPO_ROOT, "README.md");
const MANIFEST_PATH = resolve(REPO_ROOT, "package.json");

const workflow = readFileSync(WORKFLOW_PATH, "utf8");
const readme = readFileSync(README_PATH, "utf8");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { scripts?: Record<string, string | undefined> };

/** The node versions `ci.yml` fans its matrix jobs out over. */
const NODE_MATRIX = ["lts/-1", "lts/*", "current"];

const PNPM_RUN = /pnpm run ([\w:-]+)/g;

/** Every first capture group of `pattern` across `source`. */
function captures(source: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const [, capture] of source.matchAll(pattern)) {
    if (capture !== undefined) {
      found.push(capture);
    }
  }
  return found;
}

/** The script names `pnpm check` chains, in order: `pnpm run x && pnpm run y`. */
function gateSteps(): string[] {
  return captures(manifest.scripts?.check ?? "", PNPM_RUN);
}

/** The `pnpm run x && …` chain a named job executes, flattened to script names. */
function jobSteps(jobName: string): string[] {
  // Each job body runs from its own `jobs:` key to the next one (two-space
  // indent at column 0), which keeps this from swallowing the whole file.
  const body = new RegExp(`\\n  ${jobName}:\\n([\\s\\S]*?)(?=\\n  \\w[\\w-]*:\\n|$)`).exec(workflow)?.[1];
  expect(body, `ci.yml declares a \`${jobName}\` job`).toBeDefined();
  return captures(body ?? "", PNPM_RUN);
}

/** Every check-run name `ci.yml` can produce, with the node matrix expanded. */
function checkRunNames(): string[] {
  return captures(workflow, /^ {4}name: (.+)$/gm).flatMap((jobName) =>
    jobName.includes("${{ matrix.node }}")
      ? NODE_MATRIX.map((node) => jobName.replace("${{ matrix.node }}", node))
      : [jobName],
  );
}

/** The check-run name every shields.io badge in the README filters on. */
function badgedCheckRunNames(): string[] {
  return captures(readme, /img\.shields\.io\/github\/check-runs\/[^"\s]*?nameFilter=([^&"\s]+)/g).map((name) =>
    decodeURIComponent(name),
  );
}

describe("the CI split covers the whole gate", () => {
  const steps = gateSteps();
  const build = jobSteps("build");
  const test = jobSteps("test");

  it("runs every step of `pnpm check` in at least one job", () => {
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect([...build, ...test], `\`pnpm run ${step}\` is part of the gate but no CI job runs it`).toContain(step);
    }
  });

  it("adds no step to CI that the gate does not run", () => {
    for (const step of new Set([...build, ...test])) {
      expect(steps, `CI runs \`pnpm run ${step}\`, which is not part of \`pnpm check\``).toContain(step);
    }
  });

  it("runs the test suite only in the `test` job, so its badge means tests", () => {
    expect(test).toContain("test");
    expect(build).not.toContain("test");
  });

  it("runs compilation, boundaries and lint only in the `build` job", () => {
    for (const step of ["build", "typecheck", "depcruise", "lint"]) {
      expect(build).toContain(step);
      expect(test).not.toContain(step);
    }
  });

  it("generates the Prisma client in both jobs, since neither can compile or run without it", () => {
    expect(build).toContain("generate");
    expect(test).toContain("generate");
  });
});

/**
 * Coverage sits outside the `build`/`test` split on purpose: it re-runs the
 * whole suite instrumented, so it is not part of `pnpm check` and the two
 * assertions above deliberately do not see it. That exemption is exactly
 * what would let the job be deleted without anything going red, so its
 * existence is asserted here instead.
 */
describe("the coverage job", () => {
  const coverage = jobSteps("coverage");

  it("runs `pnpm run test:coverage`", () => {
    expect(coverage).toContain("test:coverage");
  });

  it("generates the Prisma client first, like the test job", () => {
    expect(coverage).toContain("generate");
  });

  it("stays out of `pnpm check`, so the local gate is not doubled", () => {
    expect(gateSteps()).not.toContain("test:coverage");
  });

  it("is backed by a real script and a config that sets thresholds", () => {
    // A job running a script that no longer exists fails loudly; a script
    // running a config with no thresholds passes while measuring nothing.
    const script = manifest.scripts?.["test:coverage"] ?? "";
    expect(script).toContain("vitest.coverage.config.ts");

    const config = readFileSync(resolve(REPO_ROOT, "vitest.coverage.config.ts"), "utf8");
    expect(config).toContain("thresholds");
  });
});

/**
 * Same exemption, same reasoning, as the coverage job above: `bun-compat`
 * re-runs the whole suite with Bun as the runtime instead of Node, so it
 * sits outside `pnpm check` and outside the two build/test assertions. Its
 * step deliberately calls `pnpm run test:bun` rather than a bare `bun run
 * vitest run`, so that if root `scripts.test` ever changes, this job's own
 * `pnpm run <script>` invocation is visible to `jobSteps()` the same way
 * every other job's is — a bare shell command here would be invisible to
 * that extraction and could drift from what `test` actually runs without
 * anything going red.
 */
describe("the bun-compat job", () => {
  const bunCompat = jobSteps("bun-compat");

  it("runs `pnpm run test:bun`", () => {
    expect(bunCompat).toContain("test:bun");
  });

  it("generates the Prisma client first, like the test job", () => {
    expect(bunCompat).toContain("generate");
  });

  it("stays out of `pnpm check`, so the local gate is not doubled", () => {
    expect(gateSteps()).not.toContain("test:bun");
  });

  it("is backed by a real script that actually runs vitest under Bun", () => {
    const script = manifest.scripts?.["test:bun"] ?? "";
    expect(script).toContain("bun run");
    expect(script).toContain("vitest run");
  });

  it("sets up the Bun toolchain before running it", () => {
    const body = new RegExp(`\\n  bun-compat:\\n([\\s\\S]*?)(?=\\n  \\w[\\w-]*:\\n|$)`).exec(workflow)?.[1];
    expect(body, "ci.yml declares a `bun-compat` job").toBeDefined();
    expect(body).toContain("setup-bun");
  });
});

describe("the README status badges point at real check runs", () => {
  it("filters on a check-run name ci.yml actually produces", () => {
    const badged = badgedCheckRunNames();
    const produced = checkRunNames();

    expect(badged.length, "README carries at least one per-job status badge").toBeGreaterThan(0);
    for (const name of badged) {
      expect(produced, `README badges the check run "${name}", which ci.yml never produces`).toContain(name);
    }
  });

  it("badges both halves of the gate", () => {
    const badged = badgedCheckRunNames();
    expect(badged.some((name) => name.startsWith("build ("))).toBe(true);
    expect(badged.some((name) => name.startsWith("test ("))).toBe(true);
  });
});
