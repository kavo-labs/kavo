---
name: conventions
description: The canonical `type:` scheme shared by issue labels, branch names, and commit message prefixes. Use when labeling an issue, naming a branch, or writing a commit message.
---

# Commit and branch conventions

One `type` vocabulary is shared across three surfaces in this repo — an
issue's label, its branch prefix, and the Conventional Commit prefix used for
work on it:

| Type       | Meaning                                | Issue label     |
| ---------- | -------------------------------------- | --------------- |
| `feat`     | New capability                         | `type:feat`     |
| `fix`      | Bug fix                                | `type:fix`      |
| `chore`    | Tooling, deps, housekeeping            | `type:chore`    |
| `test`     | Test coverage work                     | `type:test`     |
| `docs`     | Documentation                          | `type:docs`     |
| `refactor` | Code restructuring, no behavior change | `type:refactor` |
| `perf`     | Performance improvements               | `type:perf`     |
| `ci`       | CI/build pipeline changes              | `type:ci`       |

## Creating a branch from an issue

An issue's `type:` label is also its branch prefix. Off an up-to-date `main`:

```bash
git checkout main && git pull --ff-only
git checkout -b <type>/<issue-number>-<short-slug>
```

If the issue has no `type:` label, ask the user which one applies before
branching; do not guess.

## Writing commit messages

Commits follow Conventional Commits using the same type vocabulary:
`<type>(<scope>): <subject>` (e.g. `feat(core): add cursor pagination`), scope
optional but preferred when the change is package-scoped. Subject line under
~72 chars, imperative mood. Add a short body only when the "why" isn't
obvious. A breaking change adds `!` right before the colon —
`type(scope)!: subject` — instead of (or alongside) a `BREAKING CHANGE:`
footer.

`commitlint.config.mjs` additionally accepts `build`, `revert`, and `style`
as commit types, since @commitlint/config-conventional supports them out of
the box. They have no issue label or branch prefix — those three surfaces
stay pinned to the eight types above — so use them only for a commit message
on work already branched and labeled under one of those eight.
