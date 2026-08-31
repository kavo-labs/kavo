---
description: Split working changes into multiple logical git commits
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git reset:*), Bash(git restore:*), Bash(git commit:*), Bash(git rev-parse:*)
---

You are creating one or more well-scoped git commits from the current working changes.

## Context

- Current status: !`git status --short`
- Current branch: !`git rev-parse --abbrev-ref HEAD`
- Staged diff stat: !`git diff --cached --stat`
- Unstaged diff stat: !`git diff --stat`
- Recent commits (for style): !`git log --oneline -10`

## Your task

Split every change in the working tree — staged and unstaged — into cohesive
logical commits, grouped by intent rather than by folder, until the tree is
clean or only intentionally-excluded files remain.

Message format is Conventional Commits; the type vocabulary is in the
`conventions` skill.

## Rules

These are the parts that are specific to this repo, or that differ from what
you would otherwise do by default:

- **Stage with explicit pathspecs.** `git reset` to clear the index, then
  `git add <specific files>` per group. Never `git add -A` or `git add .` —
  they silently sweep in whatever else is in the tree.
- **Config and tooling go in their own commit**, ahead of the code that
  depends on them, and docs stay separate from implementation unless the two
  are trivially coupled.
- **Do NOT push, and do NOT amend.** This command only ever creates new
  commits; `/pr` is what pushes.
- **No co-author trailers** unless this repo's recent commits already use them
  — check `git log`, do not assume.
- **Keep nested parentheses out of commit messages.** release-please parses
  the whole message and a `outer(inner())` code span can defeat its parser
  (`fix commit could not be parsed` → the commit is dropped from the
  changelog). Write `metadataFor` of `relation.target()`, not
  `metadataFor(relation.target())`.
- Keep a file whole in its best-fitting commit rather than reaching for patch
  staging; split a single file across commits only when its changes are
  genuinely unrelated.
- Finish by printing each commit (hash + subject) and confirming
  `git status` is clean.

$ARGUMENTS
