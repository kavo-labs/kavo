import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * commitlint.config.mjs pins the type vocabulary to the `conventions` skill's
 * eight types (feat, fix, chore, test, docs, refactor, perf, ci) plus the
 * rest of @commitlint/config-conventional's own default list (build, revert,
 * style). That override must not break the one thing type-enum overrides are
 * notorious for breaking: the `!` breaking-change marker
 * (`type(scope)!: subject`), which conventional-commits-parser strips out
 * of the header before type-enum ever sees it.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function lint(message: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync("pnpm", ["exec", "commitlint"], {
      cwd: REPO_ROOT,
      input: message,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("commitlint.config.mjs", () => {
  it("accepts a breaking-change header with a scope", () => {
    const result = lint("feat(core)!: add unified defaults block for sort, select, and include");
    expect(result.ok, result.output).toBe(true);
  });

  it("accepts a breaking-change header without a scope", () => {
    const result = lint("fix!: drop the deprecated legacy pagination fallback");
    expect(result.ok, result.output).toBe(true);
  });

  it("accepts the full config-conventional type list", () => {
    for (const type of ["build", "revert", "style"]) {
      const result = lint(`${type}: exercise a type outside the core eight`);
      expect(result.ok, result.output).toBe(true);
    }
  });

  it("still rejects a type outside the allowed vocabulary", () => {
    const result = lint("wip(core): should not be an allowed type");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("type-enum");
  });
}, 30_000);
