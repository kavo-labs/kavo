import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The quarterly security re-audit (#499): a schedule that opens an issue from
 * a template, with no more token than that needs. The workflow is read as
 * text, like `release-workflow.spec.ts` does; `workflow-permissions.spec.ts`
 * separately pins its action SHAs and per-job write scopes.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(resolve(REPO_ROOT, ".github/workflows/security-reaudit.yml"), "utf8");
const templatePath = resolve(REPO_ROOT, ".github/ISSUE_TEMPLATE/security-reaudit.md");

/**
 * Every `<scope>: <level>` line under a `permissions:` key, at any indent.
 * Comments are stripped first, as `workflow-permissions.spec.ts` does, so a
 * trailing `# why` or a comment line can't end a block before a grant.
 */
function grantedScopes(yaml: string): string[] {
  const code = yaml
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, ""))
    .filter((line) => line.trim() !== "")
    .join("\n");
  return [...`${code}\n`.matchAll(/^( *)permissions:( *\S.*)?\n((?:\1 {2}\S.*\n)*)/gm)].flatMap(
    ([, , inline, block]) => [
      ...(inline === undefined ? [] : [inline.trim()]),
      ...(block ?? "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.trim()),
    ],
  );
}

describe("security re-audit workflow", () => {
  it("runs on the first day of each quarter, and on demand", () => {
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: "0 6 1 1,4,7,10 \*"$/m);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it("grants nothing beyond reading the repo and writing issues", () => {
    const scopes = new Set(grantedScopes(workflow));
    expect(scopes).toEqual(new Set(["contents: read", "issues: write"]));
  });

  it("opens the issue from the template, recording the SHA it audits", () => {
    expect(workflow).toContain("TEMPLATE: .github/ISSUE_TEMPLATE/security-reaudit.md");
    expect(workflow).toContain("MAIN_SHA: ${{ github.sha }}");
    expect(workflow).toMatch(/gh issue create --title "\$title" --label security --label type:chore/);
  });

  it("stops rather than open a second issue for the same quarter", () => {
    expect(workflow).toMatch(/grep -qxF "\$title"; then\n.*\n\s+exit 0/);
  });

  it("finds the last re-audit by its exact title shape, not by search rank", () => {
    // Title search is a loose phrase match: it also finds #499 itself.
    expect(workflow).toContain(String.raw`test("^Quarterly security re-audit [0-9]{4}-Q[1-4]$")`);
  });

  it("reads the last audited SHA back through CRLF line endings", () => {
    expect(workflow).toMatch(/--jq \.body \| tr -d '\\r' \\\n\s+\| sed -n/);
  });

  it("only opens an issue from the default branch", () => {
    expect(workflow).toContain("if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  });
});

describe("grantedScopes", () => {
  it("sees a grant behind a trailing or standalone comment", () => {
    const yaml = [
      "permissions:",
      "  contents: read",
      "  # why",
      "  pull-requests: write # why",
      "jobs:",
      "  a:",
      "    permissions: write-all",
      "",
    ].join("\n");
    expect(grantedScopes(yaml)).toEqual(["contents: read", "pull-requests: write", "write-all"]);
  });
});

describe("security re-audit issue template", () => {
  it("exists", () => {
    expect(existsSync(templatePath)).toBe(true);
  });

  const template = existsSync(templatePath) ? readFileSync(templatePath, "utf8") : "";

  it("carries every placeholder the workflow fills", () => {
    for (const placeholder of ["{{LAST_REAUDIT}}", "{{LAST_SHA}}", "{{MAIN_SHA}}"]) {
      expect(template).toContain(placeholder);
    }
  });

  it("records the audited SHA on the line the next run reads back", () => {
    expect(template).toMatch(/^- This re-audit: `main` at `\{\{MAIN_SHA\}\}`$/m);
    expect(workflow).toContain("s/^- This re-audit: `main` at `\\([0-9a-f]\\{40\\}\\)`$/\\1/p");
  });

  it("reruns #490's audit tasks and keeps its confidentiality rules", () => {
    for (const task of ["Task 2", "Task 3", "Task 4", "Task 5"]) {
      expect(template).toContain(task);
    }
    expect(template).toContain("PACKAGE_DIRS");
    expect(template).toContain("docs/internals/adr/");
    expect(template).toMatch(/counts-only summary/);
  });
});
