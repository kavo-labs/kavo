# Docs restructure: framework/ORM chooser, configuration split, simpler tone

Date: 2026-08-14

## Problem

The adopter-facing docs (`docs/getting-started/introduction.md`, `docs/using-the-api.md`,
`docs/integrations/`) read like an API reference: exhaustive field-by-field
tables, edge-case enumeration, full type signatures restated in prose. There
is no way for a visitor to pick their framework/ORM stack and see only what's
relevant to it — `integrations/nest/configuration.md` in particular is 569
lines covering both global module setup and every per-entity config option in
one page.

Goal: make the adopter docs read as a simpler, task-based guide, let visitors
pick their stack once, and split the oversized configuration page along
existing topic boundaries. `docs/internals/` (architecture docs, ADRs) is
contributor-facing and is out of scope — untouched by this change.

## 1. Framework/ORM chooser

A VitePress custom Vue component ("Stack Picker") renders at the top of every
framework/ORM-scoped page: the integration pages (`getting-started.md`'s
banner and the 4 ORM pages). It does NOT render on the 4 configuration
subpages under `integrations/nest/configuration/` — those document Nest
module/entity config that is the same regardless of ORM, so an ORM switcher
there would misleadingly imply otherwise.

- Two dropdowns: **Framework** (`Nest` — only option today, rendered as a
  single-item select so the UI doesn't need rework when a second framework
  binding ships) and **ORM** (`TypeORM` / `Prisma` / `Mongoose` /
  `MikroORM`).
- Selecting a combination navigates to `/integrations/<framework>/<orm>`.
  This reuses the existing `integrations/<framework>/<orm>.md` file layout —
  no file moves for the ORM pages themselves.
- The choice persists in `localStorage` so it's pre-selected on return
  visits and on other pages that embed the picker.
- `getting-started.md` gets a banner/callout using the same component so a
  first-time visitor can pick their stack before reading, but the page's
  body stays TypeORM-example-based as it is today (with pointers to the
  other ORM pages) — a full per-ORM rewrite of `getting-started.md` is out
  of scope.
- Nav/sidebar in `docs/.vitepress/config.mts` stay as explicit link lists
  (as now) — the picker is additive navigation, not a replacement for the
  sidebar.

## 2. Splitting `integrations/nest/configuration.md`

Current page has 20 headings under two top-level scopes (global `KavoModule`
config, and per-entity `@Kavo(Entity, config)`). Split into
`integrations/nest/configuration/`:

- **`module-setup.md`** — `KavoModule.forRoot`/`forRootAsync` fields, the
  `principal` extractor.
- **`settings.md`** — the app-wide `KavoSettings` knobs: pagination, query,
  errors, relations, arrayMutation, caching, softDelete, realtime. Written
  as task-based "how do I turn on X" sections rather than one table per
  field.
- **`entity-config.md`** — `@Kavo(Entity, config)`: `dto`, `allowed`,
  `computed`.
- **`operations.md`** — per-entity `operations`, custom operations, reaching
  the database from a handler, custom list metadata.

`configuration.md` itself becomes a short landing page: the precedence-chain
diagram (`built-in defaults → global → entity → operation → per-call`) plus
links to the four subpages. Sidebar in `config.mts` nests the four subpages
under a "Configuration" entry, replacing the current single link.

## 3. Tone simplification

Applies to: `getting-started.md`, `using-the-api.md`, and everything under
`integrations/` (including the new configuration subpages). Does **not**
apply to `docs/internals/` (architecture docs, ADRs stay as-is — they are
contributor-facing, not adopter-facing).

Per page:

- Keep short code examples for the common cases.
- Convert field-by-field tables and prose enumeration into task-based
  sections ("to do X, set Y").
- Drop rare edge-case callouts and restated type signatures. Replace with a
  one-line pointer to the actual TypeScript type (e.g. "see the
  `KavoSettings` type for the full field list") instead of re-documenting
  every field in prose.

## Out of scope

- Rewriting `getting-started.md` per ORM.
- Any change to `docs/internals/` (architecture docs, ADRs).
- A framework axis with more than one real option (Nest is the only
  framework binding today; the picker's framework dropdown is scaffolding
  for when a second one ships).

## Files touched

- `docs/.vitepress/config.mts` — sidebar/nav updates for the new
  configuration subpages; no structural nav change otherwise.
- `docs/.vitepress/theme/` — new Stack Picker Vue component (exact location
  per existing theme conventions).
- `docs/getting-started/introduction.md` — tone pass, add Stack Picker banner.
- `docs/using-the-api.md` — tone pass.
- `docs/integrations/orms/typeorm.md`, `prisma.md`, `mongoose.md`,
  `mikroorm.md` — tone pass, embed Stack Picker.
- `docs/guides/configuration/index.md` — becomes landing page.
- `docs/guides/configuration/module-setup.md`,
  `settings.md`, `entity-config.md`, `operations.md` — new, split from the
  old `configuration.md`, tone pass. Do NOT embed Stack Picker (see §1).
