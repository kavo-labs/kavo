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
(`.github/workflows/release-please.yml`) and keeps one release PR open with
the pending bump and changelog. Merging that PR cuts the `vX.Y.Z` tag +
GitHub Release, and `publish.yml` publishes that release to npm — both
automatically.

**That automation depends on a GitHub App token, not `GITHUB_TOKEN`.** GitHub
suppresses workflow triggers from `GITHUB_TOKEN`-authored events to avoid
recursion, so with the default token the release PR's merge fired nothing and
the tag it created fired nothing — every release needed two manual
`workflow_dispatch` kicks. `release-please.yml` therefore mints an
installation token from a GitHub App (`actions/create-github-app-token`,
secrets `RELEASE_PLEASE_APP_ID` / `RELEASE_PLEASE_APP_PRIVATE_KEY`) and passes
it to `release-please-action` as `token:`. An App's pushes and releases _do_
cascade, so:

- Merging the release PR fires `release-please.yml`'s `push` (the release
  branch is App-authored) → the tag + GitHub Release are cut.
- That Release fires `publish.yml`'s `release: published` → npm publish.

A GitHub App was chosen over a PAT: it is repo-owned rather than tied to a
person, its per-run token is short-lived, and it has no yearly expiry to
renew. The App needs only **Contents: write** and **Pull requests: write** on
this repo. The `workflow_dispatch` hatches on both workflows are kept as a
fallback for when the token or a run fails.

The release PR's title is `chore: release${component} v${version}`, which
renders `chore: release v0.15.0` (see the empty `${component}` below), so the
squash-merge commit on `main` reads `chore: release vX.Y.Z (#NNN)`. Three
config details are load-bearing, and they were all found the hard way:

- **`package-name` is set to `""`** on the `.` package. This is the one that
  makes `createReleases` work. When a merged release PR is what triggers the
  release, release-please's node strategy computes a "branch component" and
  compares it to the component parsed from the head branch name
  (`release-please--branches--main`, which has none → empty). The branch
  component resolves via `this.packageName ?? <read package.json name>`; an
  **absent** `package-name` falls through to the root `package.json` `name`
  (`kavo`), so the comparison is `"" !== "kavo"` and release-please bails with
  `PR component: undefined does not match configured component: kavo` →
  `Expected 1 releases, only found 0` → no tag. An **empty-string**
  `package-name` is non-nullish, short-circuits the `??` before
  `package.json` is read, and the comparison becomes `"" === ""`. Do not
  remove this key or give it a real value.
- **`${component}` stays in both title patterns.** The pattern is
  bidirectional — release-please parses the merged PR title back through it
  to recover `${version}`. With `package-name: ""` the component renders
  empty, so `chore: release${component} v${version}` → `chore: release
v0.15.0`; the token still has to be present for the parse to line up.
- With `separate-pull-requests: false` the repo produces a single **grouped**
  PR, and that PR is named by `group-pull-request-title-pattern`, _not_
  `pull-request-title-pattern`. Both are set to
  `chore: release${component} v${version}` so the PR title is
  `chore: release vX.Y.Z`. Left unset, `group-pull-request-title-pattern`
  defaults to the branch name (`chore: release main`) — which is the bug this
  replaced, so it must stay set.

The nine package versions are bumped through `extra-files`, independent of
all of the above.

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
