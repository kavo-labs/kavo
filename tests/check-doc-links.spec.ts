import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/check-doc-links.sh`, as a set of assertions.
 *
 * The script is a guard, and the failure mode that matters for a guard is not
 * "it missed a dead link" — it is "it stopped looking and still said OK".
 * Review found three ways it did exactly that: a regex that matched nothing, a
 * `git grep` that hard-errored, and a renamed VitePress config that skipped the
 * sidebar pass entirely. All three printed `doc links OK` and exited 0, because
 * bash discards a process substitution's exit status where `set -euo pipefail`
 * cannot see it.
 *
 * So every pass here is pinned from both directions: it reports a planted dead
 * link, *and* it refuses to report success when it has nothing to look at. The
 * second half is the one that would have caught the original bug.
 *
 * Each case runs the real script against a throwaway git repo rather than a
 * mock, because the thing under test is its interaction with `git grep` and the
 * filesystem — a reimplementation would pass while the script rotted.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_PATH = resolve(REPO_ROOT, "scripts/check-doc-links.sh");

/** Files every fixture starts with — one live reference per pass, so all three floors are met. */
const BASE_FIXTURE: Record<string, string> = {
  "docs/guide.md": "# Guide\n",
  "docs/README.md": "- [Guide](guide.md)\n",
  "docs/.vitepress/config.mts": 'export default { themeConfig: { sidebar: [{ text: "Guide", link: "/guide" }] } };\n',
  "packages/core/src/a.ts": "// See docs/guide.md for the contract.\nexport const a = 1;\n",
};

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Builds a git repo with the given files. `git grep` searches tracked files, so
 * everything is staged — a commit is not needed and would only cost time.
 */
function fixture(overrides: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "kavo-doc-links-"));
  fixtures.push(root);

  const files = { ...BASE_FIXTURE, ...overrides };
  for (const [relative, contents] of Object.entries(files)) {
    if (contents === null) {
      continue;
    } // explicitly omitted from this fixture
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  run("git", ["init", "-q"], root);
  run("git", ["add", "-A"], root);
  return root;
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && command === "git") {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

/** Runs the real script against a fixture. It `cd`s to the git toplevel itself, so cwd is enough. */
function check(root: string) {
  const result = spawnSync("bash", [SCRIPT_PATH], { cwd: root, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("check-doc-links.sh", () => {
  it("passes when every reference resolves", () => {
    const result = check(fixture());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("doc links OK");
  });

  describe("reports dead references", () => {
    it("pass 1: a docs path referenced from outside docs/", () => {
      const result = check(fixture({ "packages/core/src/a.ts": "// See docs/gone.md for the contract.\n" }));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("packages/core/src/a.ts:1: dead docs reference -> docs/gone.md");
    });

    it("pass 2: a relative link between docs pages", () => {
      const result = check(fixture({ "docs/README.md": "- [Guide](gone.md)\n" }));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("docs/README.md:1: dead docs reference -> gone.md");
    });

    it("pass 3: an extensionless VitePress sidebar link", () => {
      const config = 'export default { themeConfig: { sidebar: [{ text: "Guide", link: "/gone" }] } };\n';
      const result = check(fixture({ "docs/.vitepress/config.mts": config }));

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("dead docs reference -> docs/gone.md");
    });
  });

  describe("refuses to report success when it cannot see anything", () => {
    // Each of these left the script printing "doc links OK" and exiting 0 before
    // the fix. A pass that matches nothing means the scanner broke, not that the
    // tree is clean — every pass has something to match in a real repo.
    it("fails when pass 1 matches nothing", () => {
      const result = check(fixture({ "packages/core/src/a.ts": "export const a = 1;\n" }));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pass 1");
      expect(result.stderr).toContain("matched nothing");
      expect(result.stdout).not.toContain("doc links OK");
    });

    it("fails when pass 2 matches nothing", () => {
      const result = check(fixture({ "docs/README.md": "No links here.\n" }));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pass 2");
      expect(result.stdout).not.toContain("doc links OK");
    });

    it("fails when pass 3 matches nothing", () => {
      const result = check(fixture({ "docs/.vitepress/config.mts": "export default {};\n" }));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pass 3");
      expect(result.stdout).not.toContain("doc links OK");
    });

    it("fails when the VitePress config is renamed away, rather than skipping the sidebar pass", () => {
      // Splitting the sidebar into its own module is a normal thing to do as it
      // grows, and it used to silently delete this pass's coverage.
      const result = check(
        fixture({ "docs/.vitepress/config.mts": null, "docs/.vitepress/config.ts": "export default {};\n" }),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("config.mts not found");
      expect(result.stdout).not.toContain("doc links OK");
    });
  });

  describe("does not fire on references that are not repo-root paths", () => {
    it("accepts a docs path nested inside a package", () => {
      const result = check(
        fixture({
          "packages/core/docs/design.md": "# Design\n",
          "packages/core/src/a.ts": "// See docs/guide.md and packages/core/docs/design.md.\n",
        }),
      );

      expect(result.status).toBe(0);
    });

    it("ignores an external URL that happens to end in .md", () => {
      const source = "// See docs/guide.md and https://example.com/docs/other.md.\n";
      const result = check(fixture({ "packages/core/src/a.ts": source }));

      expect(result.status).toBe(0);
    });

    it("accepts a docs path written relative to the mentioning file", () => {
      const readme = "Full notes: [design](../../docs/guide.md).\n";
      const result = check(fixture({ "packages/core/README.md": readme }));

      expect(result.status).toBe(0);
    });

    it("allows the add-adr template placeholder", () => {
      const source = "// See docs/guide.md; new ADRs go in docs/internals/adr/00NN-kebab-title.md.\n";
      const result = check(fixture({ "packages/core/src/a.ts": source }));

      expect(result.status).toBe(0);
    });
  });
});
