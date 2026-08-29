# Release automation with release-please

**Status:** design approved (2026-08-29)
**Scope:** architectural — replaces the routine-release path currently driven by the `/publish` skill.

## Goal

Stop cutting `@kavo/*` releases by hand. A bot (`release-please`) watches
`main`, keeps a single **release PR** open with the computed version bump and
generated changelog, and cutting a release becomes "merge that PR". The
existing `publish.yml` (pack + OIDC `npm publish` + safeguards) is unchanged
except for how it is triggered.

The human action is: review the release PR, merge it. Nothing publishes on an
ordinary merge to `main`.

## Decisions

1. **One logical release at the repo root.** release-please is configured with
   a single package rooted at `.`. The other eight published `package.json`
   files are bumped as `extra-files` (`type: json`, `jsonpath: $.version`).
   One release PR, one root `CHANGELOG.md`, one tag `vX.Y.Z`
   (`include-component-in-tag: false`). Inter-package deps are `workspace:^`
   (no literal versions), so nothing else needs rewriting in the tarball —
   `pnpm pack` in `publish.yml` still does that.

2. **`publish.yml` triggers on `release: published`.** release-please creates
   the GitHub Release with the default `GITHUB_TOKEN`; a tag pushed that way
   does not fire `on: push: tags`, but the Release does fire
   `on: release: { types: [published] }`. The existing `push: tags: v*.*.*`
   trigger is kept as a manual escape hatch. `GITHUB_REF_NAME` is the tag name
   on a release event, so the job body is untouched. `publish.yml`'s
   already-published guard makes a double fire (manual tag + release) safe.

3. **`/publish` shrinks to bootstrap-only.** release-please cannot publish a
   package that has never existed on npm (no npmjs trusted-publisher page to
   configure yet). `/publish` is rewritten to cover only "bootstrap a brand
   new `@kavo/*` package's first version"; the routine version-math /
   9-manifest-edit / tag-push content is deleted.

4. **Pre-1.0 bump rules live in config.** `bump-minor-pre-major: true` keeps
   a breaking change on `0.x` at a minor bump rather than `1.0.0`, matching
   `/publish`. `bump-patch-for-minor-pre-major: true` makes a plain `feat:` on
   `0.x` a patch bump — this is the one deliberate deviation from `/publish`,
   detailed in "Bump semantics" below.

## Components

### `release-please-config.json` (new, repo root)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "release-type": "node",
  "include-component-in-tag": false,
  "tag-separator": "-",
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": true,
  "separate-pull-requests": false,
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

The root `.` entry bumps the root `package.json` too. The root manifest is
private (never published) but carries a `version` field today — release-please
will keep it in lockstep with the rest, which is harmless and keeps one number
authoritative.

Open question for implementation: whether the `extra-files` list should be
generated / asserted from `PACKAGE_DIRS` rather than hand-copied. Resolved by
a test (below), not by generation — `PACKAGE_DIRS` stays the single source of
truth and the test fails if the config drifts from it.

### `.release-please-manifest.json` (new, repo root)

```json
{ ".": "0.14.6" }
```

Seeded to the current released version. release-please updates it on every
release PR merge.

### `.github/workflows/release-please.yml` (new)

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

Default `GITHUB_TOKEN`. No PAT, no GitHub App.

### `.github/workflows/publish.yml` (edit — trigger only)

```yaml
on:
  release:
    types: [published]
  push:
    tags:
      - "v*.*.*"
```

Everything from `permissions:` down is unchanged.

### `CHANGELOG.md` (new, repo root)

Created by the first release-please run. Not seeded by hand. History before
adoption is not backfilled (the GitHub Releases already carry `--generate-notes`
bodies for prior tags).

### `.claude/commands/publish.md` (rewrite)

Reduced to: preconditions, build, `pnpm pack` + `npm publish` of a single
named tarball, npm trusted-publisher configuration, `--dry-run` resolution
check. All version-bump math, the 9-manifest table walk, the
commit-to-`main` + tag + push steps, and the "watch publish.yml" steps are
removed — those are release-please's job now. The `allowed-tools` line keeps
`npm publish` OUT (unchanged — the permission prompt is the last human gate).

### `docs/internals/adr/0041-releases-are-cut-by-release-please.md` (new)

One ADR. Records: routine releases are a merged release PR; `publish.yml` is
triggered by the GitHub Release; lockstep (ADR-0004) is enforced by
`extra-files` + the existing lockstep tests; `/publish` is bootstrap-only.
Cross-links ADR-0004. Referenced from
`docs/internals/architecture/02-monorepo-and-packages.md`.

### `docs/internals/architecture/02-monorepo-and-packages.md` (edit)

The section describing `publish.yml` / the release flow gets a paragraph on
the release PR and a link to ADR-0041. `.github/scripts/verify-lockstep-versions.mjs`
stays exactly as-is — it is now the backstop behind `extra-files` rather than
behind `/publish`.

### `CONTRIBUTING.md` / `docs` adopter-facing release notes

Grep during implementation for any prose that tells a maintainer to run
`/publish` for a routine release and repoint it at "merge the release PR".

## Bump semantics — the one behavior change

`/publish` today classifies commits with the `conventions` type vocabulary and
caps at minor while `0.x`:

| commit                                   | `/publish` today | release-please with the config above |
| ---------------------------------------- | ---------------- | ------------------------------------- |
| `feat!:` / `BREAKING CHANGE:` on `0.x`   | minor            | minor (`bump-minor-pre-major`)        |
| `feat:` on `0.x`                         | minor            | **patch** (`bump-patch-for-minor-pre-major`) |
| `fix:` / `chore:` / `docs:` / ...        | patch            | patch                                 |
| `1.0.0`                                  | only on explicit `major` arg + human confirm | never automatic; `bump-minor-pre-major` keeps it `0.x` until a human sets `Release-As: 1.0.0` |

**The change:** under `/publish`, any `feat:` on `0.x` bumped the *minor*
(`0.14.6` → `0.15.0`). With `bump-patch-for-minor-pre-major: true`, a `feat:`
bumps the *patch* (`0.14.6` → `0.14.7`) and only a breaking change bumps the
minor. This is the standard release-please pre-1.0 behavior and is, I think,
the more defensible reading of semver-zero — but it is a deviation from
current practice and must be called out in the ADR and confirmed.

Alternative if we want to keep exact parity: drop
`bump-patch-for-minor-pre-major`, keep only `bump-minor-pre-major`. Then
`feat:` → minor and breaking → minor (indistinguishable), matching `/publish`.
Recommendation: take the standard behavior (patch for `feat:` on `0.x`);
it is what the wider ecosystem expects from a release-please repo.

`1.0.0` is reached by adding `Release-As: 1.0.0` to a commit body (or the
release PR), a deliberate one-time human act — same spirit as today's
"explicit `major` arg + confirm".

## Tests — `tests/release-workflow.spec.ts`

Existing assertions that must be updated:

- The `publish.yml` trigger is currently implied. Add assertions:
  - `publish.yml` has `on.release.types` containing `published`.
  - `publish.yml` still has the `push.tags` `v*.*.*` trigger.
- The `/publish` package-table assertion (`keeps /publish's package table in
  the order PACKAGE_DIRS publishes`) — the table is being removed from
  `publish.md`. Replace with an assertion that
  `release-please-config.json`'s `extra-files` paths, plus the `.` root, cover
  exactly `PACKAGE_DIRS` (order-independent; `PACKAGE_DIRS` remains the source
  of truth).

New assertions:

- `.release-please-manifest.json`'s `"."` value equals
  `packages/core/package.json`'s `version` (the manifest never drifts from the
  released tree).
- `release-please-config.json` sets `include-component-in-tag: false` and
  `bump-minor-pre-major: true` (the tag shape `publish.yml` expects, and the
  pre-1.0 rule).
- `.github/workflows/release-please.yml` exists, triggers on `push` to `main`,
  and grants `contents: write` + `pull-requests: write`.
- `release-please-config.json`'s `changelog-sections` types are a subset of
  the `conventions` skill's type vocabulary (guard against a section for a
  type the repo doesn't use).

The lockstep-version tests, engines-lockstep tests, optional-peer tests, and
all `publish.yml` pack/publish/tarball assertions are untouched.

## Rollout

1. Land config + workflows + `publish.yml` trigger edit + `/publish` rewrite +
   ADR + doc edits + test updates in one PR (`pnpm check` green).
2. After merge, release-please opens its first release PR against `main`
   (version computed from commits since `v0.14.6`).
3. Verify that PR: version is right, `CHANGELOG.md` reads well, all 9
   `package.json` versions bumped.
4. Merge it → tag `vX.Y.Z` + GitHub Release created → `publish.yml` runs on
   `release: published` → npm.
5. Confirm the published versions and provenance.

## Non-goals

- Per-package independent versioning (ADR-0004 lockstep stays).
- Per-package changelogs.
- Backfilling `CHANGELOG.md` with pre-adoption history.
- Automating the first publish of a brand-new package (stays manual via the
  slimmed `/publish`).
- Any change to `publish.yml`'s pack / OIDC / safeguard steps.
