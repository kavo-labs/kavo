import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `docs/getting-started/installation.md` and the root README list `bun` alongside npm/pnpm
 * as a supported way to install Kavo. Nothing in the repo actually verifies
 * that Bun can *run* the published output, though: Bun has its own module
 * resolver and its own ESM loader, and either can diverge from Node's in ways
 * that only show up at runtime (e.g. an `exports` map Node tolerates but Bun
 * rejects).
 *
 * This builds `@kavo/core` for real (`tsc -b`, the same command its own
 * `package.json` build script runs) and then has the actual Bun binary
 * `import { createKavo } from "@kavo/core"` — the bare specifier, resolved
 * through a scratch `node_modules/@kavo/core` symlink to the package root, so
 * Bun's resolver genuinely walks `package.json`'s `exports` map the way `bun
 * add @kavo/core` would, rather than reading `dist/index.js` off an absolute
 * path (which would silently pass even if `exports` pointed nowhere) — and
 * checks that a representative export survives the round trip. Both cases
 * skip outright when Bun isn't on PATH, so this never turns into a red gate
 * on a machine that simply lacks the binary.
 *
 * This file deliberately does NOT also spawn the whole workspace suite under
 * Bun — that runs as its own top-level step in the `bun-compat` CI job
 * instead (`bun run vitest run`, ci.yml), and here's why it isn't nested in
 * here alongside these two probes: spawning `bun run vitest run` from
 * *inside* the outer (Node) vitest process already running this file
 * reliably hangs — the inner and outer `mongodb-memory-server` instances
 * contend for the same resources, and because `spawnSync` blocks
 * synchronously, vitest's own test timeout can't even abort it. That's a
 * test-harness artifact of nesting one vitest run inside another, not a Bun
 * incompatibility, and it disappears once the Bun run is its own top-level
 * process tree, which is what the CI job gives it.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORE_PACKAGE_DIR = resolve(REPO_ROOT, "packages/core");

const bunAvailable = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!bunAvailable)("Bun compatibility", () => {
  let scratchDir: string;

  beforeAll(() => {
    const build = spawnSync("pnpm", ["exec", "tsc", "-b", "packages/core"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(`building @kavo/core failed:\n${build.stdout}\n${build.stderr}`);
    }

    scratchDir = mkdtempSync(join(tmpdir(), "kavo-bun-compat-"));

    // A real `node_modules/@kavo/core` symlink, so importing the bare
    // specifier below actually walks package.json's `exports` map through
    // Bun's own resolver, instead of reading dist/index.js off a path that
    // bypasses `exports` entirely.
    const scopeDir = join(scratchDir, "node_modules", "@kavo");
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(CORE_PACKAGE_DIR, join(scopeDir, "core"), "dir");
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("lets the Bun runtime resolve @kavo/core through its exports map and import the built barrel", () => {
    const probeScript = resolve(scratchDir, "probe.mjs");
    writeFileSync(
      probeScript,
      `
      import { createKavo } from "@kavo/core";
      if (typeof createKavo !== "function") {
        throw new Error("createKavo did not survive the Bun import as a function");
      }
      console.log("OK");
      `,
      "utf8",
    );

    const run = spawnSync("bun", ["run", probeScript], { encoding: "utf8" });

    expect(run.status, `bun stderr:\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("OK");
  });

  it("lets the Bun runtime execute @kavo/core's TypeScript source directly", () => {
    // Bun compiles TypeScript itself, with no build step. This is a
    // different code path than the dist import above (Bun's own TS/ESM
    // transform vs. tsc's output) and catches syntax Bun's transform
    // wouldn't accept even though tsc happily emits it.
    const probeScript = resolve(scratchDir, "probe-src.mjs");
    const coreEntry = resolve(REPO_ROOT, "packages/core/src/index.ts");
    writeFileSync(
      probeScript,
      `
      import { createKavo } from ${JSON.stringify(coreEntry)};
      if (typeof createKavo !== "function") {
        throw new Error("createKavo did not survive the Bun import as a function");
      }
      console.log("OK");
      `,
      "utf8",
    );

    const run = spawnSync("bun", ["run", probeScript], { encoding: "utf8" });

    expect(run.status, `bun stderr:\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("OK");
  });
});
