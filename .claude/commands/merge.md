---
description: Verify CI, merge the PR, delete the branch, and return to an updated main
argument-hint: "[PR number — omit to use the current branch's PR]"
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*), Read
---

## Context

- Branch: !`git rev-parse --abbrev-ref HEAD`
- Working tree: !`git status --short`
- PR: !`gh pr view $ARGUMENTS --json number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,url 2>/dev/null || echo "NO PR"`
- Checks: !`gh pr checks $ARGUMENTS 2>/dev/null || echo "no checks reported"`

## Your task

Close the loop on this PR. Argument: **$ARGUMENTS**

1. **Refuse to merge if any of these hold.** Report which one and stop:
   - there is no matching PR;
   - the PR is still a **draft**;
   - any required check is **failing or still running** — wait for it, do not
     merge past it;
   - `mergeable` is false, or there are conflicts with `main`;

   If the only problem is that checks are still running, say so and offer to
   wait rather than merging blind.

2. **Say what you are about to merge** — PR number, title, commit count, and the
   issue it closes — and get the user's go-ahead before the merge itself. This
   is the irreversible step.

3. **Merge with squash**, keeping history linear and one commit per issue.
   **Always pass an authored `--subject` and `--body`** — never let `gh` fall
   back to its default squash body, which is the concatenated list of branch
   commit messages (`* feat(scope): …` bullets and all). release-please parses
   the whole merged message, and a body full of pseudo-headers and nested
   `call(inner())` code spans has silently defeated its parser before
   (`fix commit could not be parsed` → the commit is dropped from the
   changelog and triggers no bump; commit 9fa1434 / #354).

   ```bash
   gh pr merge <n> --squash --delete-branch \
     --subject "feat(core): …" \
     --body "$(cat <<'EOF'
   One or two plain-prose paragraphs summarizing the change.

   Refs #<n>
   EOF
   )"
   ```

   Write the subject as a Conventional Commit matching this repo's style
   (`feat(core): …`). Keep the body plain prose: no `* type(scope):` bullet
   lines, and rephrase any `outer(inner())` nesting (`metadataFor` of
   `relation.target()`, not `metadataFor(relation.target())`).

4. **Return to a clean main.** If the session is inside a worktree created by
   `/implement` (`EnterWorktree`), exit it first — the merge already landed on
   `origin/main` and the local branch is being deleted remotely, so it's safe
   to discard: `ExitWorktree` with `action: "remove"`,
   `discard_changes: true`. This returns the session to the main checkout.
   Then, from the main checkout:

   ```bash
   git checkout main && git pull --ff-only
   git remote prune origin
   ```

   Confirm the local branch is gone; delete it with `git branch -d <branch>` if
   it survived the remote deletion or the worktree removal.

5. **Verify main is green** after the merge:

   ```bash
   pnpm check
   pnpm docs:links
   ```

   If `main` is broken by the merge, say so immediately and treat fixing it as
   the next task — do not move on to another issue. `docs:links` is a separate
   CI job, so `pnpm check` alone does not cover it.

6. **Confirm the issue closed.** `Closes #<n>` in the PR body should have done
   it; if the issue is still open, close it with a comment pointing at the PR.
