---
description: Bootstrap the first npm publish of a brand-new @kavo/* package
argument-hint: "<package-dir> (a PACKAGE_DIRS entry, e.g. packages/orms/mikroorm)"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(node:*), Bash(pnpm install:*), Bash(pnpm build:*), Bash(pnpm check:*), Bash(pnpm pack:*), Bash(npm view:*), Bash(tar:*), Read, Grep, Glob
---

## Context

- Branch: !`git rev-parse --abbrev-ref HEAD`
- Working tree: !`git status --short`
- Current lockstep version: !`node -p "require('./packages/core/package.json').version"`
- Remote: !`git remote -v | head -1 || echo "NO REMOTE"`
- Package dir argument: **$ARGUMENTS**

## When to use this

**Only** to bootstrap a package that has never been published — `npm view <name>`
returns nothing. It exists because npm's trusted-publisher settings are
per-package and configured on npmjs.com, and a package with zero versions has
no settings page to configure, so `.github/workflows/publish.yml` cannot be
the thing that first publishes it.

**Routine releases are not this command.** They are a merged release-please
PR: release-please keeps one release PR open on `main` with the computed
lockstep version bump (every `package.json`) and the generated `CHANGELOG.md`;
merging it creates the `vX.Y.Z` tag + GitHub Release, and `publish.yml` runs
on `release: published`. See
[`docs/internals/adr/0041-releases-are-cut-by-release-please.md`](../../docs/internals/adr/0041-releases-are-cut-by-release-please.md)
and the design doc
[`docs/superpowers/specs/2026-08-29-release-please-design.md`](../../docs/superpowers/specs/2026-08-29-release-please-design.md).
Do not bump versions, commit to `main`, or push a `vX.Y.Z` tag from this
command — that is release-please's job.

## Your task

Bootstrap the first published version of the package in **$ARGUMENTS**.

1. **Preconditions.** Refuse and stop unless: the branch is `main` and up to
   date with `origin/main`; the working tree is clean; `$ARGUMENTS` is one of
   the directories listed in `PACKAGE_DIRS` in
   `.github/workflows/publish.yml`; and `npm view "<name>"` for that package
   reports no versions (if it has any, this command does not apply — the
   package is already bootstrapped and goes out through release-please like
   every other). The package's `version` in its `package.json` must already
   equal the current lockstep version — bootstrapping never bumps versions.

2. **Build.** `dist/` is gitignored and no package defines a `prepack`,
   `prepare` or `prepublishOnly` script, so `pnpm pack` builds nothing on its
   own. Packing an unbuilt tree ships a tarball whose `"files": ["dist"]`
   matches nothing: it publishes, it becomes `latest`, and every import of it
   fails.

   ```bash
   pnpm install --frozen-lockfile && pnpm build || echo "BUILD FAILED — stop here"
   ```

3. **Pack into a fresh private directory**, so the glob below cannot pick up a
   tarball left by an earlier attempt.

   ```bash
   dir=$ARGUMENTS
   NAME=$(node -p "require('./$dir/package.json').name")
   VERSION=$(node -p "require('./$dir/package.json').version")
   TARBALL_DIR=$(mktemp -d)
   (cd "$dir" && pnpm pack --pack-destination "$TARBALL_DIR")
   TARBALL=$(echo "$TARBALL_DIR"/*.tgz)
   ```

4. **Verify the tarball before publishing.** `pnpm pack` is the only thing
   that rewrites `workspace:^` into a real semver range — a directly-published
   package ships `"@kavo/core": "workspace:^"` verbatim and every
   `npm install` of it fails with `EUNSUPPORTEDPROTOCOL`. That mistake is
   unfixable after npm's unpublish window: the version has to be superseded by
   the next release. `@kavo/prisma@0.5.0`, `@kavo/mongoose@0.6.0` and
   `@kavo/graphql@0.4.0` were all bootstrapped with a bare `npm publish` and
   none of the three can be installed; the first two are still their
   package's `latest`.

   ```bash
   tar -tzf "$TARBALL" | grep -q "^package/dist/" || echo "NO dist/ — DO NOT PUBLISH"
   tar -xzOf "$TARBALL" package/package.json | node -e '
     let raw = ""; process.stdin.on("data", (c) => (raw += c));
     process.stdin.on("end", () => {
       const pkg = JSON.parse(raw);
       for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
         for (const [n, r] of Object.entries(pkg[field] ?? {})) {
           if (String(r).includes("workspace:")) { console.log(`${field}.${n}: ${r}`); process.exitCode = 1; }
         }
       }
     });
   ' || echo "ships unresolved workspace: ranges — DO NOT PUBLISH"
   ```

5. **Publish.** `npm publish` is deliberately **not** in this file's
   `allowed-tools`, and `pnpm` is granted per subcommand so `pnpm publish` is
   not either. `.claude/settings.json` backs the same gate with a
   `permissions.ask` entry for both spellings. The permission prompt is the
   last human gate before an irreversible public write — do not widen the
   entry to `Bash(pnpm:*)` or add `Bash(npm:*)`.

   ```bash
   echo "publishing $NAME@$VERSION from $TARBALL"
   npm publish "$TARBALL" --access public
   ```

6. **Configure the trusted publisher** on npmjs.com for the new package:
   `kavo-labs/kavo` + `publish.yml`. Until this is done, the next release will
   die on this package.

7. **Verify the bootstrap resolves.** `npm view` only proves the version
   exists, not that it installs. `--dry-run` exercises resolution — the
   `workspace:^` failure class above — but never unpacks the tarball, so it
   passes on a package published with an empty `dist/`; step 4's `tar -tzf`
   check is what covers that.

   ```bash
   (cd "$(mktemp -d)" && npm init -y >/dev/null && npm install "$NAME@$VERSION" --dry-run)
   ```

8. **Then let release-please handle every future release of it.** This first
   version will lack OIDC provenance; every later release through `publish.yml`
   will have it. Nothing else to do here — do not tag, do not commit.
