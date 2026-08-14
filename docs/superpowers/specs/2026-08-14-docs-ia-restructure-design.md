# Docs IA restructure: MikroORM-style category tree (Phase 1 — reorganize existing content)

Date: 2026-08-14

## Problem

Kavo's docs currently have a flat, thin adopter-facing structure: `getting-started.md`,
`using-the-api.md`, 4 ORM integration pages, and a 4-page configuration subtree
(added in the previous restructure, see
`docs/superpowers/specs/2026-08-14-docs-restructure-design.md`). This doesn't
scale as adopter-facing content grows, and doesn't give a returning reader a
mental map of the surface the way a category-based docs site does (e.g.
MikroORM's `Getting Started / Core Concepts / Modeling / Querying / ... /
Reference` sidebar).

Goal: adopt a MikroORM-style multi-category sidebar, reinterpreted for what
Kavo actually is (a REST/GraphQL/MCP CRUD framework wrapping an ORM, not an
ORM itself) rather than copied verbatim. Categories that only make sense for
an ORM's own internals (query builder, schema generator, migrations) have no
Kavo equivalent and are excluded.

## Target category tree (North Star — spans all phases)

```
Getting Started
├── Introduction
├── Requirements
├── Installation
└── Quick Start

Core
├── Entities
├── CRUD Operations
├── DTOs
├── Services
├── Routes & Controllers
└── Custom Operations

Querying
├── Filtering
├── Search
├── Sorting
├── Pagination
└── Field Selection & Includes

Features
├── Relations
├── Soft Delete
├── Bulk Operations
├── Realtime Events
├── Caching & ETags
└── Allowlists & Computed Fields

Integrations
├── ORMs
│   ├── TypeORM
│   ├── Prisma
│   ├── Mongoose
│   └── MikroORM
├── Frameworks
│   └── NestJS
└── Protocols
    ├── OpenAPI/Swagger
    ├── GraphQL
    └── MCP

Guides
├── Configuration
│   ├── Module Setup
│   ├── Settings
│   ├── Entity Config
│   └── Operations
├── Wiring Your Own Auth
├── Error Handling
└── Custom Adapter

Reference
├── Config Keys
├── Errors
└── Decorators
```

Explicitly excluded, and why (confirmed against `packages/`):

- **Frameworks**: Express, Fastify, Hono — no binding exists (`packages/frameworks/` has only `nest`).
- **ORMs**: Drizzle, Sequelize — no adapter exists (`packages/orms/` has only `typeorm`, `prisma`, `mongoose`, `mikroorm`).
- **Protocols**: WebSocket — no transport exists (`packages/realtime/` has only `sse`).
- **Multi-Tenancy, Audit Logs, RBAC**: no built-in feature.
- **Authentication / Authorization** as native Kavo features: deliberately out of scope by design (`principal` is BYO-auth wiring; Kavo never scopes rows or guards operations itself). Represented instead as the single `Guides/Wiring Your Own Auth` page.
- **Hooks** as a distinct lifecycle system: Kavo has no `beforeCreate`/`afterUpdate`-style hooks; the equivalent extension points (handler replacement, `@Override`) are covered under `Core/Custom Operations`.

## Phase 1 scope: pure reorganization, no new prose

Phase 1 stands up the sidebar/category structure and relocates **existing**
content into it. It does not write new pages. A page is in Phase 1 only if
it is a straight move or a split-along-existing-section-boundaries of
content that already exists; if the target tree calls for combining two
separate source files into one narrative, Phase 1 keeps them as two
cross-linked pages instead (deferred merge is Phase 2+ work, since merging
requires editorial judgment, not just relocation).

### File mapping

| New location | Source | Operation |
|---|---|---|
| `getting-started/introduction.md` | `getting-started.md` (opening 2 paragraphs) | split |
| `getting-started/requirements.md` | `getting-started.md` §Requirements | split |
| `getting-started/installation.md` | `getting-started.md` §Install, §Peer dependencies, §GraphQL and MCP | split |
| `getting-started/quick-start.md` | `getting-started.md` §Zero-config `@Kavo()`, §Wiring it into a Nest app | split |
| `querying/filtering.md` | `using-the-api.md` §Filtering | split |
| `querying/search.md` | `using-the-api.md` §Search | split |
| `querying/sorting.md` | `using-the-api.md` §Sorting | split |
| `querying/pagination.md` | `using-the-api.md` §Pagination, §Cursor, §Since | split |
| `querying/field-selection-and-includes.md` | `using-the-api.md` §Field selection, §Includes | split |
| `features/relations.md` | `configuration/settings.md` §relations (moved, not copied) | move |
| `features/soft-delete.md` | `getting-started.md` §Soft delete (walkthrough) | move; `configuration/settings.md` §softDelete stays under Guides/Configuration/Settings, cross-linked both ways |
| `features/realtime-events.md` | `configuration/settings.md` §realtime | move |
| `features/caching-and-etags.md` | `using-the-api.md` §ETags and conditional requests (+4 subsections) | move; `configuration/settings.md` §caching stays under Guides/Configuration/Settings, cross-linked both ways |
| `features/allowlists-and-computed-fields.md` | `configuration/entity-config.md` §allowlists + §computed (moved) | move; `using-the-api.md` §Computed fields (caller-facing usage) is prepended to this page as its own subsection |
| `integrations/orms/{typeorm,prisma,mongoose,mikroorm}.md` | `integrations/nest/{typeorm,prisma,mongoose,mikroorm}.md` | move (path only, content unchanged) |
| `guides/configuration/index.md` | `integrations/nest/configuration.md` | move |
| `guides/configuration/module-setup.md` | `integrations/nest/configuration/module-setup.md` minus §The principal | move + split |
| `guides/configuration/settings.md` | `integrations/nest/configuration/settings.md` | move (content unchanged; still holds §relations/§softDelete/§realtime/§caching alongside the new Features pages — cross-linked, not deleted) |
| `guides/configuration/entity-config.md` | `integrations/nest/configuration/entity-config.md` minus §allowlists/§computed | move + split |
| `guides/configuration/operations.md` | `integrations/nest/configuration/operations.md` | move |
| `guides/wiring-your-own-auth.md` | `integrations/nest/configuration/module-setup.md` §The principal | move |

### Left in place for now (no existing content to move)

`using-the-api.md` §The response envelope and §Errors have no clean single-page
destination in the target tree without editorial merging (`Core` and
`Reference/Errors` are both Phase 2+, net-new categories). Phase 1 leaves
these two sections in `using-the-api.md`, and leaves `using-the-api.md` itself
in the sidebar as a holdover page (labeled informally, not part of the new
category tree) until Phase 2 gives them a real home.

### Sidebar reality in Phase 1

`docs/.vitepress/config.mts`'s sidebar, after Phase 1, contains only:
`Getting Started` (4 pages), `Querying` (5 pages), `Features` (6 pages),
`Integrations` (ORMs only — no Frameworks or Protocols subcategory yet, since
NestJS is folded into the ORM pages today and OpenAPI/GraphQL/MCP are Phase
2+ writing), `Guides` (Configuration 4-page subtree + Wiring Your Own Auth).
`Core` and `Reference` are not created as sidebar categories yet — there is
nothing to put in them — and get added when Phase 2+ delivers their first
real page. This keeps every sidebar entry pointing at a real page (required
for `pnpm docs:links` to pass) rather than shipping dead links or "coming
soon" stubs.

## Out of scope (this spec)

- Any new prose. Every Phase 1 page's content is either unchanged or
  concatenated from existing sources at their existing section boundaries.
- Core, Reference, GraphQL, MCP, Bulk Operations, Error Handling, Custom
  Adapter — all net-new, planned as separate specs in later phases.
- Changing `docs/internals/**` (contributor docs stay as-is, per the prior
  restructure's ADR-equivalent decision).
- The Stack Picker component's behavior — reused as-is from the prior
  restructure; Phase 1 only adds it to newly-relocated pages that already had
  it (the 4 ORM pages) and does not add it to any new category.

## Later phases (not specced here)

Phase 2+: author `Core` (Entities, CRUD Operations, DTOs, Services, Routes &
Controllers, Custom Operations) and `Reference` (Config Keys, Errors,
Decorators) as net-new content, each its own spec/plan. Phase N: `Bulk
Operations`, `GraphQL`/`MCP` adopter-facing pages (currently only in
`docs/internals/`), `Guides/Error Handling`, `Guides/Custom Adapter`.
