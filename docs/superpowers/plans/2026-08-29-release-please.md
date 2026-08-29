# release-please Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-run `/publish` routine-release path with a `release-please` bot that keeps one release PR (version bump + `CHANGELOG.md`) open on `main`; merging that PR cuts the tag/GitHub Release, which triggers the existing `publish.yml`.

**Architecture:** `release-please` runs on every push to `main` (new `release-please.yml` workflow, default `GITHUB_TOKEN`). It is configured as a **single logical package at the repo root** — one tag `vX.Y.Z`, one root `CHANGELOG.md`, and the other eight published `package.json` versions bumped via `extra-files` JSON-path. `publish.yml` gains an `on: release: { types: [published] }` trigger (keeping its `push: tags` trigger) because a tag pushed by `GITHUB_TOKEN` does not fire `on: push: tags`. `/publish` is cut down to a brand-new-package bootstrap procedure only.

**Tech Stack:** `googleapis/release-please-action@v4`, GitHub Actions, pnpm workspace, Vitest (`tests/release-workflow.spec.ts` is the wiring gate).

**Spec:** `docs/superpowers/specs/2026-08-29-release-please-design.md`

## Global Constraints

- **Lockstep versioning (ADR-0004):** every published `@kavo/*` package ships on one version. `PACKAGE_DIRS` in `.github/workflows/publish.yml` is the single source of truth for the released set (currently 9 dirs). Config that lists package paths must be checked against `PACKAGE_DIRS`, never hand-maintained as a second authority.
- **The 9 package directories:** `packages/core`, `packages/orms/typeorm`, `packages/orms/prisma`, `packages/orms/mongoose`, `packages/orms/mikroorm`, `packages/realtime/sse`, `packages/protocols/graphql`, `packages/protocols/mcp`, `packages/frameworks/nest`.
- **Current released version:** `0.14.6` (`packages/core/package.json`). At implementation time, re-read `packages/core/package.json` `version` — it is authoritative if it differs.
- **Tag shape:** `vX.Y.Z` exactly, no package-name component (`publish.yml` matches `v*.*.*` and reads `${GITHUB_REF_NAME#v}`).
- **Conventional Commits type vocabulary** (`conventions` skill, normative): `feat`, `fix`, `chore`, `test`, `docs`, `refactor`, `perf`, `ci`. No other types exist in this repo.
- **`pnpm check` is the gate** and is never worked around. Run it before considering the work done.
- **Commit messages:** Conventional Commits, `<type>(<scope>): <subject>`, imperative, subject < ~72 chars.
- **`npm publish` / `pnpm publish` stay OUT of `.claude/commands/publish.md`'s `allowed-tools`** — the permission prompt is a deliberate human gate.

---

### Task 1: release-please config + seed manifest

**Files:**
- Create: `release-please-config.json` (repo root)
- Create: `.release-please-manifest.json` (repo root)
- Test: `tests/release-workflow.spec.ts` (add a `describe("release-please config")` block)

**Interfaces:**
- Consumes: `PACKAGE_DIRS` parsed from `.github/workflows/publish.yml` — the spec file already has `readPackageDirs(workflow)` and exports `const packageDirs`. Reuse it.
- Produces: `release-please-config.json` with `packages["."].extra-files` (array of `{ type: "json", path, jsonpath: "$.version" }`) and top-level `include-component-in-tag: false`, `bump-minor-pre-major: true`, `bump-patch-for-minor-pre-major: true`. `.release-please-manifest.json` is `{ ".": "<core version>" }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/release-workflow.spec.ts` (near the other top-level `describe`s; it already imports `readFileSync`, `resolve`, `REPO_ROOT`, `packageDirs`, `readManifest`):

```ts
describe("release-please config", () => {
  const config = JSON.parse(readFileSync(resolve(REPO_ROOT, "release-please-config.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, ".release-please-manifest.json"), "utf8"));

  it("produces a bare vX.Y.Z tag, matching publish.yml's trigger", () => {
    expect(config["include-component-in-tag"]).toBe(false);
  });

  it("keeps a pre-1.0 breaking change at a minor bump, not 1.0.0", () => {
    expect(config["bump-minor-pre-major"]).toBe(true);
  });

  it("bumps every published package.json in lockstep via extra-files", () => {
    const rootPkg = config.packages["."];
    expect(rootPkg).toBeDefined();
    const extraPaths = (rootPkg["extra-files"] ?? [])
      .filter((f: { type: string }) => f.type === "json")
      .map((f: { path: string }) => f.path.replace(/\/package\.json$/, ""));
    // "." bumps the root package.json itself; extra-files must cover the
    // eight non-root PACKAGE_DIRS. PACKAGE_DIRS stays the only authority.
    expect([...extraPaths].sort()).toEqual([...packageDirs.filter((d) => d !== ".")].sort());
    for (const f of rootPkg["extra-files"].filter((f: { type: string }) => f.type === "json")) {
      expect(f.jsonpath, `${f.path} jsonpath`).toBe("$.version");
    }
  });

  it("seeds the manifest at the current released version and never lets it drift", () => {
    expect(manifest["."]).toBe(readManifest("packages/core").version);
  });

  it("only names changelog sections for types the repo actually uses", () => {
    const KNOWN = new Set(["feat", "fix", "chore", "test", "docs", "refactor", "perf", "ci"]);
    for (const section of config["changelog-sections"] ?? []) {
      expect(KNOWN.has(section.type), `unknown changelog type: ${section.type}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/release-workflow.spec.ts -t "release-please config"`
Expected: FAIL — `release-please-config.json` does not exist (`ENOENT`).

- [ ] **Step 3: Create `release-please-config.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "include-component-in-tag": false,
  "separate-pull-requests": false,
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": true,
  "packages": {
    ".": {
      "package-name": "kavo",
      "changelog-path": "CHANGELOG.md",
      "extra-files": [
        { "type": "json", "path": "packages/core/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "packages/orms/typeorm/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "packages/orms/prisma/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "packages/orms/mongoose/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "packages/orms/mikroorm/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "packages/realtime/sse/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "packages/protocols/graphql/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "packages/protocols/mcp/package.json", "jsonpath": "$.version" },
        { "type": "json", "path": "packages/frameworks/nest/package.json", "jsonpath": "$.version" }
      ]
    }
  },
  "changelog-sections": [
    { "type": "feat", "section": "Features" },
    { "type": "fix", "section": "Bug Fixes" },
    { "type": "perf", "section": "Performance" },
    { "type": "refactor", "section": "Refactoring" },
    { "type": "docs", "section": "Documentation" },
    { "type": "test", "section": "Tests" },
    { "type": "ci", "section": "CI" },
    { "type": "chore", "section": "Chores", "hidden": true }
  ]
}
```

Note: the `.` root entry bumps the root `package.json` (private, but it carries a `version` today — keeping it in lockstep is harmless and keeps one number authoritative). The eight `extra-files` entries cover every other `PACKAGE_DIRS` directory. If `PACKAGE_DIRS` has changed since this plan was written, make the `extra-files` list match it (minus `packages/core`, which is covered — wait: `packages/core` is NOT the root. See Step 3a.)

- [ ] **Step 3a: Decide the root-vs-core question explicitly**

The `.` package is the **repo root** (`./package.json`), which is `private` and unpublished. `packages/core/package.json` is a separate file and IS in the `extra-files` list above. So `extra-files` must list **all nine** `PACKAGE_DIRS` entries (the root `.` is extra, on top of the nine). Adjust the test in Step 1 accordingly:

```ts
    expect([...extraPaths].sort()).toEqual([...packageDirs].sort());
```

and remove the `.filter((d) => d !== ".")` — `packageDirs` never contains `.`. Keep the config's `extra-files` listing all nine as written above.

- [ ] **Step 4: Create `.release-please-manifest.json`**

Use the actual current `packages/core/package.json` version:

```json
{ ".": "0.14.6" }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/release-workflow.spec.ts -t "release-please config"`
Expected: PASS (all 5).

- [ ] **Step 6: Commit**

```bash
git add release-please-config.json .release-please-manifest.json tests/release-workflow.spec.ts
git commit -m "ci: add release-please config for lockstep root release"
```

---

### Task 2: release-please workflow

**Files:**
- Create: `.github/workflows/release-please.yml`
- Test: `tests/release-workflow.spec.ts` (extend the `describe("release-please config")` block or add `describe("release-please workflow")`)

**Interfaces:**
- Consumes: `release-please-config.json`, `.release-please-manifest.json` from Task 1.
- Produces: a workflow that runs on `push` to `main` and grants `contents: write` + `pull-requests: write`.

- [ ] **Step 1: Write the failing test**

```ts
describe("release-please workflow", () => {
  const wf = readFileSync(resolve(REPO_ROOT, ".github/workflows/release-please.yml"), "utf8");

  it("runs on pushes to main", () => {
    expect(wf).toMatch(/on:\s*[\s\S]*push:[\s\S]*branches:\s*\[?\s*main/);
  });

  it("grants the permissions release-please needs to open its PR and tag", () => {
    expect(wf).toMatch(/contents:\s*write/);
    expect(wf).toMatch(/pull-requests:\s*write/);
  });

  it("points release-please at the repo's config and manifest files", () => {
    expect(wf).toContain("release-please-config.json");
    expect(wf).toContain(".release-please-manifest.json");
    expect(wf).toContain("googleapis/release-please-action@v4");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/release-workflow.spec.ts -t "release-please workflow"`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Create `.github/workflows/release-please.yml`**

```yaml
name: release-please

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/release-workflow.spec.ts -t "release-please workflow"`
Expected: PASS (3).

- [ ] **Step 5: Lint the workflow if the repo lints workflows**

Run: `pnpm lint`
Expected: PASS (oxlint covers `.github/scripts/` — a pure-YAML file is not linted, but run it to be sure nothing else regressed).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release-please.yml tests/release-workflow.spec.ts
git commit -m "ci: add release-please workflow on main"
```

---

### Task 3: point publish.yml at the GitHub Release

**Files:**
- Modify: `.github/workflows/publish.yml` (the `on:` block only, lines ~3-6)
- Test: `tests/release-workflow.spec.ts` (add to `describe("publish.yml wiring")`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `publish.yml` triggers on **both** `release: { types: [published] }` and `push: { tags: ["v*.*.*"] }`. Job body unchanged — `GITHUB_REF_NAME` is the tag name on a release event too.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("publish.yml wiring", () => { ... })`:

```ts
  it("triggers on a published GitHub Release (release-please creates it with GITHUB_TOKEN)", () => {
    // A tag pushed by GITHUB_TOKEN does not fire `on: push: tags`; the
    // Release event does. See the release-please design doc.
    expect(workflow).toMatch(/on:\s*[\s\S]*release:\s*[\s\S]*types:\s*\[\s*published\s*\]/);
  });

  it("still triggers on a manually pushed vX.Y.Z tag as an escape hatch", () => {
    expect(workflow).toMatch(/push:\s*[\s\S]*tags:\s*[\s\S]*v\*\.\*\.\*/);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/release-workflow.spec.ts -t "publish.yml wiring"`
Expected: the "published GitHub Release" test FAILS; the escape-hatch test PASSES (already true).

- [ ] **Step 3: Edit the `on:` block of `.github/workflows/publish.yml`**

Replace:

```yaml
on:
  push:
    tags:
      - "v*.*.*"
```

with:

```yaml
on:
  release:
    types: [published]
  push:
    tags:
      - "v*.*.*"
```

Leave `permissions:` and everything below untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/release-workflow.spec.ts -t "publish.yml wiring"`
Expected: PASS (all, including the two new assertions).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/publish.yml tests/release-workflow.spec.ts
git commit -m "ci: trigger publish.yml on published GitHub Release"
```

---

### Task 4: cut /publish down to a bootstrap-only procedure

**Files:**
- Modify: `.claude/commands/publish.md` (large rewrite)
- Modify: `tests/release-workflow.spec.ts` — the test `it("keeps /publish's package table in the order PACKAGE_DIRS publishes", ...)` currently asserts a `| \`packages/...\` |` markdown table exists in `publish.md`. The rewrite removes that table.

**Interfaces:**
- Consumes: nothing.
- Produces: `publish.md` whose stated purpose is "bootstrap the first published version of a brand-new `@kavo/*` package". It retains the `pnpm pack` → `npm publish <tarball>` bootstrap steps, the trusted-publisher setup, and the `--dry-run` resolution check that already live in the file. It drops: version-bump classification, the nine-manifest bump table + walk, `pnpm install && pnpm check` for a routine release, the "confirm before irreversible" release prompt, `git commit`/`git tag`/`git push`, and "watch the release workflow". `allowed-tools` keeps `npm publish`/`pnpm publish` OUT.

- [ ] **Step 1: Decide what the table test becomes**

The table asserted "the `/publish` doc lists `PACKAGE_DIRS` in publish order — this is what notices drift." That guarantee still has value for the config we just added. Replace the test body so it asserts the **`release-please-config.json` `extra-files`** cover `PACKAGE_DIRS` (Task 1 already added an equivalent assertion — so this test is now redundant). Delete `it("keeps /publish's package table in the order PACKAGE_DIRS publishes", ...)` entirely and its `PUBLISH_COMMAND_PATH` read if nothing else uses it.

- [ ] **Step 2: Grep for other `publish.md` references in the spec file**

Run: `grep -n "PUBLISH_COMMAND_PATH\|publish.md" tests/release-workflow.spec.ts`
Expected: after Step 1, only the `const PUBLISH_COMMAND_PATH = ...` line (if unused) remains — remove it too. If any other test reads it, leave the constant and adjust that test to the rewritten doc's actual content.

- [ ] **Step 3: Run the spec file to see it fail / go green on the table removal**

Run: `pnpm vitest run tests/release-workflow.spec.ts`
Expected: PASS (the removed test no longer runs; everything else green).

- [ ] **Step 4: Rewrite `.claude/commands/publish.md`**

New front matter `description`: `Bootstrap the first npm publish of a brand-new @kavo/* package`. New `argument-hint`: `<package-dir>` (the `PACKAGE_DIRS` entry to bootstrap). Keep `allowed-tools` as-is (do NOT add `Bash(npm:*)` or widen `pnpm`).

Body sections, in order:
1. **When to use this.** Only when `npm view <name>` shows the package has never been published. Routine releases are a merged release-please PR — link `docs/superpowers/specs/2026-08-29-release-please-design.md` and ADR-0041.
2. **Preconditions.** On `main`, up to date, clean tree. The package's version in its `package.json` already matches the current lockstep version (release-please / the release PR sets that — a bootstrap does not bump versions).
3. **Build.** `pnpm install --frozen-lockfile && pnpm build` — `dist/` is gitignored and no package defines `prepack`, so a bare `pnpm pack` ships an empty tarball.
4. **Pack into a fresh temp dir.** `TARBALL_DIR=$(mktemp -d); (cd "$dir" && pnpm pack --pack-destination "$TARBALL_DIR")` — reuse the exact wording already in the file.
5. **Verify the tarball before publishing.** `tar -tzf "$TARBALL" | grep -q "^package/dist/"` and the `workspace:` check — reuse the existing prose about `@kavo/prisma@0.5.0` / `@kavo/mongoose@0.6.0`.
6. **Publish.** `npm publish "$TARBALL" --access public` — note the permission prompt is the intended last gate; do not widen `allowed-tools`.
7. **Configure the trusted publisher** on npmjs.com (`kavo-labs/kavo` + `publish.yml`).
8. **Verify resolution.** `(cd "$(mktemp -d)" && npm init -y >/dev/null && npm install "$NAME@$VERSION" --dry-run)` — reuse existing caveats (`--dry-run` does not unpack).
9. **Then let release-please handle the real release.** The first version lacks OIDC provenance; every later release of it through `publish.yml` has it.

Preserve verbatim the existing hard-won paragraphs about `workspace:^` breakage, the unpublish window, and why `pnpm pack` (not a bare `npm publish`) is mandatory — they are the reason this file still exists.

- [ ] **Step 5: Run the full spec file**

Run: `pnpm vitest run tests/release-workflow.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .claude/commands/publish.md tests/release-workflow.spec.ts
git commit -m "docs: reduce /publish to a brand-new-package bootstrap procedure"
```

---

### Task 5: ADR-0041 + architecture doc + prose sweep

**Files:**
- Create: `docs/internals/adr/0041-releases-are-cut-by-release-please.md`
- Modify: `docs/internals/architecture/02-monorepo-and-packages.md` (§7, lines ~248-254)
- Modify: any file a grep turns up that tells a maintainer to run `/publish` for a routine release
- Test: `pnpm docs:links` (every `docs/**.md` reference resolves)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: ADR-0041, cross-linked from ADR-0004 and architecture doc §7.

- [ ] **Step 1: Write ADR-0041**

Follow the house format (see `docs/internals/adr/0004-lockstep-versioning.md`): `# ADR-0041 — Releases are cut by release-please`, `**Status:** accepted`, then `## Context`, `## Decision`, `## Consequences`.

- **Context:** the `/publish` skill hand-computed the bump, edited nine manifests, committed straight to `main`, and pushed the tag — error-prone toil (v0.6.0 shipped `@kavo/prisma` one version behind). We want the version math, changelog, and tag to be automated, while a human still decides *when* a release goes out.
- **Decision:** `release-please` (single logical package at the repo root, `include-component-in-tag: false`) keeps one release PR open on `main` with the computed lockstep bump (all nine `package.json`s via `extra-files`) and a generated root `CHANGELOG.md`. Merging that PR is the release trigger: release-please then creates tag `vX.Y.Z` and the GitHub Release, and `publish.yml` runs on `release: published`. `/publish` is retained only to bootstrap a brand-new package's first version, which release-please cannot do (no npm trusted-publisher page exists until the package has a version). Pre-1.0 bump rule: `bump-minor-pre-major` keeps a breaking change at a minor bump; `bump-patch-for-minor-pre-major` makes a plain `feat:` a **patch** bump — a deliberate change from `/publish`, which bumped the minor for any `feat:` on `0.x`. `1.0.0` is reached only by an explicit `Release-As: 1.0.0`.
- **Consequences:** no hand-run version math; lockstep still enforced (by `extra-files` and, as backstop, `verify-lockstep-versions.mjs` in `publish.yml`); a `feat:` on `0.x` now bumps the patch not the minor; `publish.yml` keeps its `push: tags` trigger as a manual escape hatch; `tests/release-workflow.spec.ts` gates the config/manifest/workflow wiring. Cross-reference ADR-0004.

- [ ] **Step 2: Add a back-reference in ADR-0004**

In `docs/internals/adr/0004-lockstep-versioning.md`, in the Consequences list where it says "trivially cheap in an automated pipeline (`.github/workflows/publish.yml`; changesets was considered and never adopted)", append: " — releases themselves are cut by release-please (ADR-0041)."

- [ ] **Step 3: Update architecture doc §7**

In `docs/internals/architecture/02-monorepo-and-packages.md`, after the paragraph ending "...fails the release unless every listed package is already at the tag's version." add:

```markdown
Those mechanics are *triggered* by release-please (ADR-0041), not run by
hand: a single release PR on `main` carries the computed lockstep bump
(every `package.json` via `extra-files`) and the generated root
`CHANGELOG.md`, and merging it creates the `vX.Y.Z` tag and GitHub
Release — which is what `publish.yml` now runs on (`release: published`,
with the `vX.Y.Z` tag trigger kept as a manual fallback).
`.claude/commands/publish.md` is now only the procedure for bootstrapping
a brand-new package's first publish.
```

- [ ] **Step 4: Prose sweep**

Run: `grep -rn "/publish\b\|publish command\|run .publish" docs/ CONTRIBUTING.md README.md 2>/dev/null`
For each hit that describes cutting a routine release, repoint it to "merge the release-please PR (ADR-0041)". Leave hits that are about the bootstrap procedure or about `publish.yml` internals.

- [ ] **Step 5: Verify doc links**

Run: `pnpm docs:links`
Expected: PASS — all new ADR-0041 and spec references resolve. The ADR list lives in the VitePress sidebar (`docs/.vitepress/config.mts`); add the 0041 row there next to 0040.

- [ ] **Step 6: Build the docs**

Run: `pnpm docs:build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs(adr): ADR-0041 releases are cut by release-please"
```

---

### Task 6: full gate + rollout notes

**Files:**
- Modify: `docs/superpowers/specs/2026-08-29-release-please-design.md` — flip the status line to note the plan is executed (optional housekeeping)
- No code.

- [ ] **Step 1: Run the full gate**

Run: `pnpm check`
Expected: PASS — generate + build + typecheck + depcruise + lint + test all green. `tests/release-workflow.spec.ts` in particular must be green.

- [ ] **Step 2: Run the format check**

Run: `pnpm format:check`
Expected: PASS. If it fails on the new JSON/YAML/MD files, run `pnpm prettify` and amend the relevant commit.

- [ ] **Step 3: Sanity-check the release-please config locally (optional, no network needed for `--dry-run` of the config parse)**

Run: `npx release-please@latest manifest-pr --dry-run --repo-url=kavo-labs/kavo --config-file=release-please-config.json --manifest-file=.release-please-manifest.json --token=dummy 2>&1 | head -30`
Expected: it parses the config without a schema error (it will fail later on the dummy token / network — that is fine; a config *parse* error is not).

- [ ] **Step 4: Write the rollout note into the PR description (for `/pr`)**

The PR body must state:
- After merge, release-please opens a release PR against `main` computing the bump from commits since `v0.14.6`.
- A reviewer must check that PR: version correct, `CHANGELOG.md` readable, all nine `package.json` versions bumped in lockstep.
- Merging that release PR creates the tag + GitHub Release and triggers `publish.yml` → npm.
- One manual GitHub setting to confirm: repo **Settings → Actions → General → Workflow permissions** must allow GitHub Actions to create and approve pull requests (release-please needs it to open its PR). Note this explicitly — it is not something a workflow file can set.

- [ ] **Step 5: Commit any housekeeping**

```bash
git add docs/superpowers/specs/2026-08-29-release-please-design.md
git commit -m "docs(specs): mark release-please design as implemented"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| `release-please-config.json` (root logical release, extra-files) | Task 1 |
| `.release-please-manifest.json` seed | Task 1 |
| Pre-1.0 bump rules in config | Task 1 (config), Task 5 (ADR rationale) |
| `changelog-sections` ⊆ conventions vocabulary | Task 1 |
| `.github/workflows/release-please.yml` | Task 2 |
| `publish.yml` `release: published` trigger, keep `push: tags` | Task 3 |
| `/publish` rewritten to bootstrap-only | Task 4 |
| ADR-0041 | Task 5 |
| architecture doc §7 edit + ADR-0004 back-ref | Task 5 |
| adopter-facing prose sweep | Task 5 Step 4 |
| `tests/release-workflow.spec.ts` updates (trigger asserts, config/manifest consistency, workflow asserts, drop `/publish` table test) | Tasks 1, 2, 3, 4 |
| Rollout (first release PR, manual Actions setting) | Task 6 Step 4 |
| Non-goals (no per-package versioning/changelogs, no backfill, no `publish.yml` body change) | respected — no task touches those |

**Placeholder scan:** none — every config file, workflow, and test block is given in full. The ADR and doc prose are specified as concrete text to write, with the house format referenced by file.

**Type consistency:** `packageDirs` / `readPackageDirs` / `readManifest` / `REPO_ROOT` / `workflow` all reused from the existing `tests/release-workflow.spec.ts` (verified against the file). `extra-files` entry shape `{ type, path, jsonpath }` is consistent across Task 1 config, Task 1 test, and Task 4 Step 1. Tag name `vX.Y.Z` and `include-component-in-tag: false` consistent across Tasks 1, 3, 5.

**Open item resolved during review:** Task 1 Step 3a settles the root-vs-`packages/core` ambiguity from the spec — `.` is the repo root, `extra-files` lists all nine `PACKAGE_DIRS`, and the Task 1 test asserts equality with `packageDirs` (no filter).
