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

/**
 * `@kavo/nest`'s peer range spans NestJS v10/v11/v12, but `build`/`test`
 * only ever install whichever major is pinned in devDependencies — one
 * version, not all three. `nest-compat` is what actually installs each
 * supported major and re-runs @kavo/nest's suite against it, so it sits
 * outside `pnpm check` and outside the build/test assertions for the same
 * reason `coverage` and `bun-compat` do: it reinstalls dependencies mid-job.
 */
describe("the nest-compat job", () => {
  const nestCompat = jobSteps("nest-compat");

  it("runs `pnpm run test:nest-compat`", () => {
    expect(nestCompat).toContain("test:nest-compat");
  });

  it("generates the Prisma client first, like the test job", () => {
    expect(nestCompat).toContain("generate");
  });

  it("stays out of `pnpm check`, so the local gate is not doubled", () => {
    expect(gateSteps()).not.toContain("test:nest-compat");
  });

  it("is backed by a real script that runs @kavo/nest's own suite", () => {
    const script = manifest.scripts?.["test:nest-compat"] ?? "";
    expect(script).toContain("vitest run");
    expect(script).toContain("packages/frameworks/nest");
  });

  it("matrixes over every NestJS major @kavo/nest's peer range declares support for", () => {
    const body = new RegExp(`\\n  nest-compat:\\n([\\s\\S]*?)(?=\\n  \\w[\\w-]*:\\n|$)`).exec(workflow)?.[1];
    expect(body, "ci.yml declares a `nest-compat` job").toBeDefined();

    const matrix = /nest: \[([^\]]+)\]/.exec(body ?? "")?.[1] ?? "";
    const matrixed = [...matrix.matchAll(/"(\d+)"/g)].map(([, major]) => major);

    const nestPackage = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "packages/frameworks/nest/package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string | undefined> };
    const peerRange = nestPackage.peerDependencies?.["@nestjs/core"] ?? "";
    const declared = [...peerRange.matchAll(/\^(\d+)\.0\.0/g)].map(([, major]) => major);

    // v10 is deliberately excluded from the matrix (see the job's own
    // comment), so this only checks the matrix is not missing a major the
    // package.json claims support for above v10, not that the two lists are
    // identical.
    for (const major of declared.filter((version) => version !== "10")) {
      expect(matrixed, `@kavo/nest declares peer support for v${major} but nest-compat does not test it`).toContain(
        major,
      );
    }
  });

  it("installs the matrixed NestJS version scoped to @kavo/nest only", () => {
    const body = new RegExp(`\\n  nest-compat:\\n([\\s\\S]*?)(?=\\n  \\w[\\w-]*:\\n|$)`).exec(workflow)?.[1];
    expect(body).toContain("pnpm --filter @kavo/nest add -D");
    expect(body).toContain("@nestjs/common@^${{ matrix.nest }}");
  });
});

/**
 * `scorecard.yml` needs `security-events: write` and `id-token: write`, but
 * only inside its one job. Granting them at the top level would hand them to
 * any job added later, and Scorecard's own Token-Permissions check marks a
 * top-level write down, so the workflow would lower the score it reports.
 */
describe("the Scorecard workflow", () => {
  // Comments are stripped first, so prose in the file that happens to spell
  // out a key (`publish_results: true`) can never satisfy an assertion.
  const scorecard = readFileSync(resolve(REPO_ROOT, ".github/workflows/scorecard.yml"), "utf8")
    .split("\n")
    .map((line) => line.replace(/\s*#.*$/, ""))
    .filter((line) => line.trim() !== "")
    .join("\n");
  // Everything before `jobs:` is workflow-level; job-level grants come after.
  const topLevel = scorecard.slice(0, scorecard.search(/^jobs:/m));
  const jobs = scorecard.slice(topLevel.length);
  // One entry per `- uses:` step: the action reference and its `with:` inputs.
  const steps = jobs
    .split(/^ {6}- /m)
    .slice(1)
    .map((body) => ({
      uses: /^uses: (\S+)/.exec(body)?.[1] ?? "",
      with: Object.fromEntries(captures(body, /^ {10}([\w-]+: .+)$/gm).map((pair) => pair.split(": "))),
    }));
  const step = (action: string) => steps.find(({ uses }) => uses.startsWith(`${action}@`));

  it("is read-only at the workflow level", () => {
    expect(topLevel).toMatch(/^permissions: read-all$/m);
    expect(topLevel).not.toMatch(/:\s*write\b/);
  });

  it("grants the job exactly the two write scopes publishing needs", () => {
    const block = /^ {4}permissions:\n((?: {6}.+\n?)+)/m.exec(jobs)?.[1] ?? "";
    const scopes = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(scopes.sort()).toEqual(["id-token: write", "security-events: write"]);
  });

  it("runs weekly and on every push to main", () => {
    expect(topLevel).toMatch(/^ {2}schedule:\n {4}- cron: "[^"]+"$/m);
    expect(topLevel).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
  });

  it("stays inside what the Scorecard API accepts for a published run", () => {
    // No `env`/`defaults` at either level, and no containers or services.
    expect(scorecard).not.toMatch(/^(env|defaults):/m);
    expect(jobs).not.toMatch(/^ {4}(env|defaults|container|services):/m);
    expect(steps.map(({ uses }) => uses.split("@")[0])).toEqual([
      "actions/checkout",
      "ossf/scorecard-action",
      "github/codeql-action/upload-sarif",
    ]);
  });

  it("pins every action to a full commit SHA", () => {
    for (const { uses } of steps) {
      expect(uses, `scorecard.yml uses "${uses}", not an action pinned to a commit SHA`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("checks out without persisting the token", () => {
    expect(step("actions/checkout")?.with).toEqual({ "persist-credentials": "false" });
  });

  it("publishes results and uploads the SARIF file it wrote", () => {
    const analysis = step("ossf/scorecard-action")?.with;
    expect(analysis).toEqual({ results_file: "results.sarif", results_format: "sarif", publish_results: "true" });
    expect(step("github/codeql-action/upload-sarif")?.with).toEqual({ sarif_file: analysis?.results_file });
  });

  it("is badged in the README, linking to the Scorecard viewer", () => {
    expect(readme).toContain("https://api.scorecard.dev/projects/github.com/kavo-labs/kavo/badge");
    expect(readme).toContain("https://scorecard.dev/viewer/?uri=github.com/kavo-labs/kavo");
  });
});

/**
 * `autoformat.yml` commits to the branch it formats. On a PR branch that is
 * the point; on `main` the ruleset (issue #496) rejects any direct push, so a
 * push trigger there could only ever fail. Its write grant also stays on the
 * job, for the same Token-Permissions reason as `scorecard.yml` above.
 */
describe("the autoformat workflow", () => {
  const autoformat = readFileSync(resolve(REPO_ROOT, ".github/workflows/autoformat.yml"), "utf8")
    .split("\n")
    .map((line) => line.replace(/\s*#.*$/, ""))
    .join("\n");
  const topLevel = autoformat.slice(0, autoformat.search(/^jobs:/m));

  it("runs only on pull requests, never on a push to main", () => {
    expect(topLevel).toMatch(/^on:\n {2}pull_request:$/m);
    expect(topLevel).not.toMatch(/^ {2}push:/m);
  });

  it("grants `contents: write` to its job, not the whole workflow", () => {
    expect(topLevel).toMatch(/^permissions: \{\}$/m);
    expect(autoformat.slice(topLevel.length)).toMatch(/^ {4}permissions:\n {6}contents: write$/m);
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
