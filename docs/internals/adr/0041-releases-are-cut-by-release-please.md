# ADR-0041 — Releases are cut by release-please

**Status:** accepted

## Context

Routine `@kavo/*` releases ran through the `/publish` command
(`.claude/commands/publish.md`): it classified every commit since the last
tag to compute a semver bump, wrote that version into the `package.json` of
all nine published packages by hand, committed `chore(release): vX.Y.Z`
straight to `main`, and pushed a `vX.Y.Z` tag that
`.github/workflows/publish.yml` fired on. Every step was manual and
order-sensitive — v0.6.0 shipped with `@kavo/prisma` one version behind
because a manifest was missed, and the miss was only caught after the tag
was already public.

The version math, the changelog, and the tag are all mechanically derivable
from Conventional Commit history. What is not mechanical, and should stay
human, is _deciding when a release goes out_.

## Decision

[release-please](https://github.com/googleapis/release-please) cuts routine
releases. It is configured as a **single logical package rooted at the repo**
(`release-please-config.json`, `include-component-in-tag: false`): one release
PR, one root `CHANGELOG.md`, one tag `vX.Y.Z`. Lockstep (ADR-0004) is held by
listing every `PACKAGE_DIRS` manifest in the root package's `extra-files`, so
release-please bumps all nine `package.json` versions together;
`tests/release-workflow.spec.ts` asserts that list stays equal to
`PACKAGE_DIRS`.

`release-please-action` runs on every push to `main`
(`.github/workflows/release-please.yml`, default `GITHUB_TOKEN`) and keeps one
release PR open with the pending bump and changelog. **Merging that PR is the
release trigger**: release-please then creates the `vX.Y.Z` tag and the
GitHub Release. `publish.yml` runs on `release: published` — a tag pushed by
`GITHUB_TOKEN` does not fire `on: push: tags`, but the Release does. The
`push: tags: v*.*.*` trigger is kept as a manual escape hatch.

The release PR's title is `chore: release${component} v${version}`, so the
squash-merge commit on `main` reads `chore: release vX.Y.Z (#NNN)`. Three
config details have to line up for that:

- With `separate-pull-requests: false` the repo produces a single **grouped**
  PR, so it is `group-pull-request-title-pattern` — not
  `pull-request-title-pattern` — that names it. Its default is
  `chore: release ${branch}` (i.e. `chore: release main`), so both keys are
  set explicitly.
- The pattern is **bidirectional**. release-please writes the PR title with
  it and, when the merged PR is what triggers the release, parses the title
  back through it to recover `${component}` and `${version}`. A pattern
  without `${component}` parses the component as `undefined`, which fails to
  match the configured component; release-please then reports
  `Expected 1 releases, only found 0` and aborts without cutting the tag.
  `${component}` must stay in the pattern even though this repo has only one
  package — do not "simplify" it out.
- The root package sets **neither `package-name` nor `component`**, so the
  configured component is `undefined`. `${component}` then renders empty on
  the write side (`chore: release v0.15.0`, not `chore: release kavo v0.15.0`)
  and the parse side compares `undefined` to `undefined`. Adding
  `package-name: "kavo"` back makes the configured component `kavo`, which no
  longer matches the empty component parsed from the title — release-please
  aborts with `Expected 1 releases, only found 0`. The nine package versions
  are bumped through `extra-files`, not `package-name`, so nothing needs it.

Pre-1.0 bump rules live in config: `bump-minor-pre-major` keeps a breaking
change on `0.x` at a minor bump rather than `1.0.0`, and
`bump-patch-for-minor-pre-major` makes a plain `feat:` a **patch** bump. The
second is a deliberate change from `/publish`, which bumped the minor for any
`feat:` on `0.x`. `1.0.0` is reached only by an explicit `Release-As: 1.0.0`.

`/publish` is retained solely to **bootstrap a brand-new package's first
publish** — release-please cannot, because npm's trusted-publisher settings
are per-package and a package with zero versions has no settings page to
configure.

## Consequences

- No hand-run version math, manifest edits, or tag pushes for a routine
  release. The maintainer reviews the release PR and merges it.
- Lockstep stays enforced: by `extra-files` at bump time, and as a backstop
  by `.github/scripts/verify-lockstep-versions.mjs` inside `publish.yml`
  (ADR-0004).
- A plain `feat:` on `0.x` now bumps the patch, not the minor — a visible
  change in release cadence versus prior practice.
- `publish.yml`'s pack / OIDC / tarball-verification steps are untouched; only
  its trigger changed.
- One repository setting is required and cannot be set from a workflow file:
  **Settings → Actions → General → Workflow permissions** must allow GitHub
  Actions to create and approve pull requests, or release-please cannot open
  its PR.
- `tests/release-workflow.spec.ts` gates the config, the seed manifest, the
  `release-please.yml` wiring, and the `publish.yml` triggers.
