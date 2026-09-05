import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `wagoid/commitlint-github-action` bundles its own `@commitlint/*` inside
 * its Docker image, separate from the `commitlint` `pnpm install` puts in
 * this repo's `node_modules` — the one `commitlint.config.mjs` is written
 * against and `tests/commitlint-config.spec.ts` actually exercises. That
 * bundled parser fails to extract `type`/`subject` from a
 * `type(scope)!: subject` header at all (`type-empty`/`subject-empty`),
 * even though this repo's own pinned `commitlint` accepts it — so a commit
 * `commitlint-config.spec.ts` swears is fine could still fail the real CI
 * check (issue #384). This file pins that the workflow lints with the
 * repo's own tool instead of a third-party action's bundled one, so the
 * local test's claim is actually true of CI as run.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/commitlint.yml");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

describe("commitlint.yml wiring", () => {
  it("never delegates to a third-party action bundling its own commitlint", () => {
    expect(workflow).not.toContain("wagoid/commitlint-github-action");
  });

  it("installs dependencies before linting, so `commitlint` resolves to this repo's pinned version", () => {
    const installIndex = workflow.indexOf("pnpm install");
    const lintIndex = workflow.indexOf("pnpm exec commitlint");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(lintIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeLessThan(lintIndex);
  });

  it("lints the pull request's own commit range, not just HEAD", () => {
    // A bare `pnpm exec commitlint` with no --from/--to lints nothing (it
    // reads stdin), and `--last`/`--edit` would lint only the tip commit,
    // missing every other commit in a multi-commit PR.
    expect(workflow).toMatch(/pnpm exec commitlint --from \S.* --to \S/);
    expect(workflow).toContain("github.event.pull_request.base.sha");
    expect(workflow).toContain("github.event.pull_request.head.sha");
  });

  it("still fetches full history, which --from/--to needs to walk the commit range", () => {
    expect(workflow).toMatch(/fetch-depth:\s*0/);
  });
});
