---
name: writing-kavo-docs
description: Use when writing a new page under docs/ or editing an existing one — new feature/guide/reference pages, ADR-adjacent architecture notes, or prose edits to docs already in the tree. Covers matching Kavo's dense, code-first doc voice and running a humanizer pass before landing the page.
---

# Writing Kavo docs

## Overview

Kavo's docs are dense and code-first, not tutorial-shaped. A page states the behavior, shows it in one runnable snippet, and links out for depth instead of restating it. **REQUIRED SUB-SKILL:** run humanizer:humanizer (file mode) on the finished prose before landing it — the voice rules below stop AI tells from being written; humanizer catches what slips through.

## When to use

- Adding a new page under `docs/` (feature, guide, reference, or an `docs/internals/architecture/*` note).
- Editing prose in an existing `docs/**.md` file.
- Not for ADRs themselves — use `add-adr` for those; this skill is for the docs that describe behavior, not the decision record that justified it.

## Voice, in one paragraph

Second person is rare; most pages describe the system ("Kavo stops actually deleting rows"), not the reader. Sentences run long and packed rather than choppy — subordinate clauses over "rule of three" bullet lists. Headers are sentence case, minimal, and often skipped entirely for a short page (`soft-delete.md` has zero `##` headers). No "Overview" or "Introduction" throat-clearing paragraph — the first sentence is the first fact. No promotional adjectives (rich, powerful, seamless, robust) and no "-ing" tacked-on justification clauses. A page can end mid-fact, on a config note or a `See [X](path)` link — never on an upbeat summary.

## Structural conventions

- **One code block does the explaining.** Show the entity/config/request once, real and copy-pasteable (an actual entity name like `Book`, not `Entity`/`Foo`), then describe what it produces in prose. Don't add a second example that says the same thing a different way.
- **Tables for enumerations**, not bullet lists: generated routes, config keys, operator mappings. See the routes table in `docs/getting-started/quick-start.md`.
- **Cross-references are inline sentences that name what's on the other end**, not "see also" appendices: `See [Soft delete, restore & purge](/internals/architecture/11-soft-delete) for the full behavior: unique-index caveats, cascades, and what's deliberately not built.` The link text is the page title; the clause after the colon previews what the reader gets there, so they can decide whether to follow it.
- **Config-key references point at the anchor**, not just the page: `` `/guides/configuration/settings#softdelete` ``, matching the heading `## softDelete` would produce.
- **Links are root-relative and extensionless** (`/features/soft-delete`, not `./soft-delete.md`), matching VitePress `cleanUrls`.
- A page lives under the section its sidebar entry already has in `docs/.vitepress/config.mts` — check the sidebar array before inventing a new section for one page.

## Process

1. Skim one or two existing pages in the same `docs/` subdirectory before writing — the voice above is a description of what's already there, not a substitute for reading it.
2. Draft the page: one real code example, prose that states behavior directly, tables for anything enumerable, cross-references where a related page already covers depth this page shouldn't duplicate.
3. Run humanizer:humanizer on the draft in file mode, scoped to prose only — leave code blocks, frontmatter, and link targets untouched.
4. Add the page to the sidebar in `docs/.vitepress/config.mts` if it's new.
5. Run `pnpm docs:links` (dead-link check across the repo, not just this page) and `pnpm docs:build` before calling it done — neither is part of `pnpm check`, so they're easy to skip by accident.

## Quick reference: phrases that don't belong in a Kavo doc

| Tell                                             | Kavo equivalent                                             |
| ------------------------------------------------ | ----------------------------------------------------------- |
| "This powerful feature allows you to..."         | Say what it does: "Kavo stops actually deleting rows on..." |
| "In order to enable this functionality"          | "To turn this on"                                           |
| "It's important to note that X supports Y"       | "X supports Y"                                              |
| Bulleted "Key Features:" list with bold lead-ins | A sentence, or a table if it's truly enumerable data        |
| "Let's walk through how this works"              | Just show the code block                                    |
| A closing "Summary" or "Conclusion" section      | End on the last concrete fact, or a cross-reference link    |

## Common mistakes

- **Writing the tutorial instead of the reference.** Kavo docs assume a working example and explain what it does; they don't build up to it step by step with "First, do X. Next, do Y."
- **Restating the sidebar section in prose.** A page under `docs/querying/` doesn't need to say "This is part of Kavo's querying system" — the sidebar already says that.
- **Skipping the humanizer pass because the draft "already sounds fine."** The voice conventions above prevent gross AI-isms; they don't catch em dashes, hedging, or a stray "Conclusion" paragraph. Run the pass anyway.
- **Inventing behavior instead of reading the code/ADR first.** Per `CLAUDE.md`: docs are not the authoritative source, code and ADRs are — a doc that describes intended-but-unbuilt behavior is a bug, not documentation.
