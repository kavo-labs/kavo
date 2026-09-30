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

/** Every `<scope>: <level>` line under a `permissions:` key, at any indent. */
function grantedScopes(yaml: string): string[] {
  return [...yaml.matchAll(/^( *)permissions:\n((?:\1 {2}[\w-]+: \w+\n)+)/gm)].flatMap(([, , block]) =>
    (block ?? "")
      .trim()
      .split("\n")
      .map((line) => line.trim()),
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
