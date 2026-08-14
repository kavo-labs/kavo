# Docs Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a framework/ORM Stack Picker to the adopter docs, split the 569-line `integrations/nest/configuration.md` into four topic pages, and simplify the adopter-facing docs' tone from API-reference style to task-based prose.

**Architecture:** A new VitePress Vue component (`StackPicker.vue`) is imported directly into each framework/ORM-scoped markdown page via `<script setup>` (the pattern `docs/index.md` already uses — no global theme registration). `integrations/nest/configuration.md` is split by existing `##`/`###` topic boundaries into `integrations/nest/configuration/{module-setup,settings,entity-config,operations}.md`, with `configuration.md` itself becoming a short landing page. Every touched page gets a tone pass converting field-by-field reference tables into task-based prose, while safety-critical and ADR-linked content is preserved verbatim.

**Tech Stack:** VitePress (Vue 3, `<script setup>`), Markdown, `pnpm docs:build` / `pnpm docs:links` / `pnpm format:check` as the doc-only verification gate (none of this is covered by `pnpm check`, `pnpm typecheck`, or `pnpm test` — docs are not compiled TypeScript or tested code).

**Spec:** `docs/superpowers/specs/2026-08-14-docs-restructure-design.md`

## Global Constraints

- Scope is adopter-facing docs only: `docs/getting-started.md`, `docs/using-the-api.md`, `docs/integrations/**`. `docs/internals/**` (architecture docs, ADRs) is untouched — do not edit any file under `docs/internals/`.
- Every safety-critical or correctness-critical block must survive verbatim (content may move to a new file, but its wording must not be shortened or dropped): the `::: danger` box under `allowlists` (the "selectable alone is not a credential control" table), the ADR-0028 pre-v0.10 migration notes under `relations`, and every `[ADR-NNNN](...)` cross-reference link anywhere in the moved/edited content.
- Every internal link that points at `/integrations/nest/configuration#<anchor>` must be updated to point at the new subpage that anchor moved to — heading text (and therefore the VitePress-generated anchor id) must not change during the split, only the file it lives in.
- `getting-started.md` stays TypeORM-example-based; do not rewrite it per-ORM.
- The chooser's Framework dropdown has exactly one option (`nest`) today — do not invent a second framework.
- Run `pnpm format:check` (or `pnpm prettify` before that) and `pnpm docs:links` after every task that touches a `.md` file, and `pnpm docs:build` after every task that touches a `.vue` or `.mts` file. These are the only verification commands available for docs changes — `pnpm check`/`pnpm test` do not cover `docs/`.

---

### Task 1: `StackPicker.vue` component

**Files:**

- Create: `docs/.vitepress/theme/components/StackPicker.vue`

**Interfaces:**

- Produces: a Vue component with props `{ orm?: string; framework?: string }`. When `orm` is passed, the component treats the page as bound to that ORM (displays it, writes it to `localStorage`, never overrides it from storage). When `orm` is omitted, the component reads its initial selection from `localStorage` (falling back to `"typeorm"`), for use on ORM-agnostic pages like the getting-started banner. Later tasks import it as `import StackPicker from "../.vitepress/theme/components/StackPicker.vue"` (path relative to the importing `.md` file) and use it as `<StackPicker orm="typeorm" />` (or with no `orm` prop for the banner).

- [ ] **Step 1: Write the component**

```vue
<template>
  <div class="kavo-stack-picker">
    <label>
      <span class="kavo-stack-picker__label">Framework</span>
      <select v-model="selectedFramework" @change="navigate">
        <option value="nest">NestJS</option>
      </select>
    </label>
    <label>
      <span class="kavo-stack-picker__label">ORM</span>
      <select v-model="selectedOrm" @change="navigate">
        <option value="typeorm">TypeORM</option>
        <option value="prisma">Prisma</option>
        <option value="mongoose">Mongoose</option>
        <option value="mikroorm">MikroORM</option>
      </select>
    </label>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vitepress";

const props = defineProps<{
  framework?: string;
  orm?: string;
}>();

const router = useRouter();
const isPageBound = props.orm !== undefined;
const selectedFramework = ref(props.framework ?? "nest");
const selectedOrm = ref(props.orm ?? "typeorm");

const STORAGE_KEY_FRAMEWORK = "kavo-docs-framework";
const STORAGE_KEY_ORM = "kavo-docs-orm";

onMounted(() => {
  if (isPageBound) {
    localStorage.setItem(STORAGE_KEY_FRAMEWORK, selectedFramework.value);
    localStorage.setItem(STORAGE_KEY_ORM, selectedOrm.value);
    return;
  }

  const storedFramework = localStorage.getItem(STORAGE_KEY_FRAMEWORK);
  const storedOrm = localStorage.getItem(STORAGE_KEY_ORM);
  if (storedFramework) selectedFramework.value = storedFramework;
  if (storedOrm) selectedOrm.value = storedOrm;
});

function navigate() {
  localStorage.setItem(STORAGE_KEY_FRAMEWORK, selectedFramework.value);
  localStorage.setItem(STORAGE_KEY_ORM, selectedOrm.value);
  router.go(`/integrations/${selectedFramework.value}/${selectedOrm.value}`);
}
</script>

<style scoped>
.kavo-stack-picker {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: center;
  margin: 1rem 0 1.5rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}

.kavo-stack-picker label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}

.kavo-stack-picker__label {
  color: var(--vp-c-text-2);
  font-weight: 500;
}

.kavo-stack-picker select {
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.9rem;
}
</style>
```

- [ ] **Step 2: Verify it builds**

Run: `pnpm docs:build`
Expected: build succeeds (no Vue/TS compile error). The component isn't imported anywhere yet, so this only checks the file itself is valid.

- [ ] **Step 3: Commit**

```bash
git add docs/.vitepress/theme/components/StackPicker.vue
git commit -m "docs: add Stack Picker component"
```

---

### Task 2: Embed the picker in the four ORM integration pages

**Files:**

- Modify: `docs/integrations/nest/typeorm.md`
- Modify: `docs/integrations/nest/prisma.md`
- Modify: `docs/integrations/nest/mongoose.md`
- Modify: `docs/integrations/nest/mikroorm.md`

**Interfaces:**

- Consumes: `StackPicker.vue` from Task 1, imported as `import StackPicker from "../../.vitepress/theme/components/StackPicker.vue"` (these files are two directories below `docs/`).

These four pages are already short, task-based zero-config walkthroughs — no tone rewrite needed here, just the picker.

- [ ] **Step 1: Add the picker to each page**

For each of the four files, insert immediately after the page's `# Nest + <ORM>` title line and its one-line intro paragraph (before the `If you haven't yet, read [Getting started]...` sentence), a `<script setup>` block and the component tag. Example for `typeorm.md` (apply the same pattern to the other three, changing only `orm="..."`):

```markdown
# Nest + TypeORM

Kavo's engine (`@kavo/core`) is ORM-agnostic — it talks to your data through a small adapter seam. `@kavo/nest` generates the routes; `@kavo/typeorm` adapts Kavo to a TypeORM `DataSource`. This is the complete, minimal wiring for that combination.

<script setup lang="ts">
import StackPicker from "../../.vitepress/theme/components/StackPicker.vue";
</script>

<StackPicker orm="typeorm" />

If you haven't yet, read [Getting started](/getting-started) first — this page assumes you already know what `@Kavo()` does and just needs the app-wiring.
```

Use `orm="prisma"`, `orm="mongoose"`, `orm="mikroorm"` respectively for the other three files. Leave the rest of each file unchanged.

- [ ] **Step 2: Verify links and build**

Run: `pnpm docs:links && pnpm docs:build`
Expected: both succeed.

- [ ] **Step 3: Format**

Run: `pnpm prettify` then `pnpm format:check`
Expected: `format:check` passes clean.

- [ ] **Step 4: Commit**

```bash
git add docs/integrations/nest/typeorm.md docs/integrations/nest/prisma.md docs/integrations/nest/mongoose.md docs/integrations/nest/mikroorm.md
git commit -m "docs: embed Stack Picker in ORM integration pages"
```

---

### Task 3: Split out `configuration/module-setup.md`

**Files:**

- Create: `docs/integrations/nest/configuration/module-setup.md`

**Interfaces:**

- Produces: a page reachable at `/integrations/nest/configuration/module-setup`, headings `## Global config (KavoModule.forRoot / forRootAsync)` and `### The principal` — anchor ids `#global-config-kavomodule-forroot-forrootasync` and `#the-principal` must be preserved (heading text unchanged) since other tasks/pages will link to `#the-principal`... actually nothing links there today, but keep the text stable regardless as a rule for this whole plan.

Source content: `docs/integrations/nest/configuration.md` lines 15–90 (the `## Global config` section through the end of `### The principal`, i.e. everything between `## Global config` and `## Settings fields`).

- [ ] **Step 1: Write the page**

Create the file with:

1. `# Module setup` as the H1.
2. A one-line intro: "How your app hands Kavo its infrastructure and app-wide options: `KavoModule.forRoot`/`forRootAsync`, and moving the authenticated caller onto `KavoContext.principal`."
3. The `## Global config (\`KavoModule.forRoot\` / \`forRootAsync\`)` section (source lines 15–40): keep the code sample and the field table as-is — this table is the module's whole options surface and is not being converted to prose (it is short and is the natural reference shape for an options object, not exhaustive per-nested-field documentation).
4. The `### The principal` section (source lines 42–90) verbatim, including the `@Override` code example and the closing "Authorization stays out of scope" paragraph. This section is already task-based prose (not a reference table) and needs no tone changes.

- [ ] **Step 2: Verify links and build**

Run: `pnpm docs:links && pnpm docs:build`
Expected: `docs:links` will still fail at this point because `configuration.md` hasn't been rewritten to link to the new subpages yet and old anchors still exist there too — that's expected until Task 7. For this task, just confirm `pnpm docs:build` succeeds (the new page compiles) and there is no *new* dead link introduced by this file itself (it introduces none, since it has no outgoing links yet beyond what's inherited from the source text — none are anchor-only self-references).

- [ ] **Step 3: Format**

Run: `pnpm prettify` then `pnpm format:check`
Expected: passes clean.

- [ ] **Step 4: Commit**

```bash
git add docs/integrations/nest/configuration/module-setup.md
git commit -m "docs: split module-setup out of configuration.md"
```

---

### Task 4: Split out `configuration/settings.md`

**Files:**

- Create: `docs/integrations/nest/configuration/settings.md`

**Interfaces:**

- Produces: `/integrations/nest/configuration/settings`, with headings (and therefore anchors) `## pagination`, `## query`, `## errors`, `## relations`, `## arrayMutation`, `## caching`, `## softDelete`, `## realtime`, `## operations (global scope only)` — note these become `##` (page-level) headings here, not `###` as they were nested under `## Settings fields` in the old page. This changes their anchor ids from e.g. `#pagination` (was already `#pagination` as an `###`, VitePress anchors don't include parent headings, so **the anchor ids are unchanged** by the promotion from `###` to `##`.

Source content: `docs/integrations/nest/configuration.md` lines 92–246 (`## Settings fields (KavoSettings)` through the end of the `### operations (global scope only)` subsection, i.e. everything before `## @Kavo(Entity, config)`).

- [ ] **Step 1: Write the page**

Create the file with:

1. `# Settings` as the H1.
2. Intro: "The app-wide `KavoSettings` shape — the same schema at every scope (global `defaults`, entity, operation, per-call), just merged in precedence order. See [Configuration](/integrations/nest/configuration) for how the scopes combine."
3. For each of the eight subsections below, promote the source `###` heading to `##` (keep the exact heading text so anchors don't move) and apply this tone rule: **convert the field table into a short paragraph or bullet list stating what each field does and its default inline** (e.g. "`defaultLimit` (default `20`) is the page size when a request supplies no `limit`.") instead of a markdown table, *except* where the source table cell contains a load-bearing cross-reference or caveat longer than one sentence — keep those as their own sentence/bullet rather than compressing them away. Preserve every `[ADR-NNNN](...)` and `[Using the API](...)`-style link exactly. Preserve every code block verbatim.

   - `pagination` (source lines 96–104): keep the `strategy` field's full explanation of `offset`/`page`/`cursor`/`since` — it's dense but every clause is load-bearing (index requirements, `count: false` pairing, GraphQL/MCP refusal) — you may split it into one short paragraph per strategy value instead of one table cell, but do not drop any of the constraints it states.
   - `query` (source lines 106–115).
   - `errors` (source lines 117–121).
   - `relations` (source lines 123–164): this section has two parts — the `relations`/`relations.edges.<name>` field descriptions (convert to prose per the rule above), and the **"Migrating from before v0.10" block** (source lines 144–164, including the nested "`defaultInclude` needs its own care" callout). Copy the migration block **verbatim, unshortened** — it is safety-critical upgrade guidance, not reference filler.
   - `arrayMutation` (source lines 166–182): keep the code example and the `replaceRelation`/ADR-0029 paragraph.
   - `caching` (source lines 184–203): keep the `::: danger`-adjacent safety paragraphs verbatim — "Redaction belongs in the DTO, not in an interceptor", the `@Override`/ETag split, the pre-v0.9 failure-mode paragraph, and the "One limit survives" paragraph are all correctness-critical; convert only the plain one-row field table (`etag`) to a sentence.
   - `softDelete` (source lines 205–212).
   - `realtime` (source lines 214–223).
   - `operations` (global scope only) (source lines 225–246): keep the code example; the operation-id-to-default-enabled table may stay a table (it's a lookup table by nature, not narrative reference) or become a bullet list — either is fine, keep all eight operation ids and their defaults.

- [ ] **Step 2: Verify build**

Run: `pnpm docs:build`
Expected: succeeds. (Link checking happens after Task 7 rewires the anchors that point here.)

- [ ] **Step 3: Format**

Run: `pnpm prettify` then `pnpm format:check`
Expected: passes clean.

- [ ] **Step 4: Commit**

```bash
git add docs/integrations/nest/configuration/settings.md
git commit -m "docs: split settings out of configuration.md"
```

---

### Task 5: Split out `configuration/entity-config.md`

**Files:**

- Create: `docs/integrations/nest/configuration/entity-config.md`

**Interfaces:**

- Produces: `/integrations/nest/configuration/entity-config` with headings `## dto`, `## allowlists`, `## computed` — anchors `#dto`, `#allowlists`, `#computed` unchanged from source (same reasoning as Task 4: `###`→`##` promotion doesn't change VitePress anchor ids).

Source content: `docs/integrations/nest/configuration.md` lines 248–373 (`## @Kavo(Entity, config) — entity-scope config` through the end of `### computed`, i.e. everything before `### operations`).

- [ ] **Step 1: Write the page**

Create the file with:

1. `# Entity config` as the H1.
2. Intro (adapt source lines 248–250): "`@Kavo(Entity, config)` accepts every settings field from [Settings](/integrations/nest/configuration/settings) one level above global, plus four fields that only make sense per entity: `dto`, `allowlists`, `computed`, and `operations` (its own page, see [Operations](/integrations/nest/configuration/operations))."
3. `## dto` (source lines 252–276): keep the code example and the slot-default table — it's a short lookup table (6 rows), not exhaustive field reference, so it can stay a table. Keep the ADR-free wording as-is, tone-simplify only the surrounding prose sentence if it reads like reference copy.
4. `## allowlists` (source lines 278–331): keep the code example. Convert the `filterable`/`sortable`/`selectable`/`includable`/`searchable` field table (lines 294–300) to prose bullets, one per field, preserving every link (`[ADR-0028]`, `[Search]`). Keep **verbatim, unshortened**:
   - The `{ exclude: [...] }` semantics paragraph (line 302).
   - The "`includable` is the one key here that does not default to everything" paragraph (line 304).
   - The Swagger/`ApiQuery` description paragraph (line 306).
   - The "How to keep a column out of every response" example (lines 308–316).
   - The entire `::: danger` box (lines 318–329) — table and all. This is the single most safety-critical block in the whole document (mass-assignment/field-exposure guidance); do not summarize or shorten it.
   - The "Two more edges" closing paragraph (line 331).
5. `## computed` (source lines 333–373): keep the code example. Convert the two-row `resolve`/`selectable` field table (lines 346–349) to two sentences. Keep **verbatim**: the "`resolve` must be total, not merely pure" paragraph, the principal-dependency paragraph, the "Keep it a pure function" paragraph, the "`resolve` receives the full fetched row" paragraph, the "What `selectable: false` does and does not mean" paragraph, and the included-relation-target paragraph — every one of these states a behavior a reader could otherwise get wrong in a way that fails at runtime or leaks data, not merely a stylistic aside. The OpenAPI-schema paragraph and the "Let the computed-key type parameter be inferred" paragraph may be trimmed to their core instruction if they read verbosely, since neither is a correctness trap, only an ergonomics tip.

- [ ] **Step 2: Verify build**

Run: `pnpm docs:build`
Expected: succeeds.

- [ ] **Step 3: Format**

Run: `pnpm prettify` then `pnpm format:check`
Expected: passes clean.

- [ ] **Step 4: Commit**

```bash
git add docs/integrations/nest/configuration/entity-config.md
git commit -m "docs: split entity-config out of configuration.md"
```

---

### Task 6: Split out `configuration/operations.md`

**Files:**

- Create: `docs/integrations/nest/configuration/operations.md`

**Interfaces:**

- Produces: `/integrations/nest/configuration/operations` with headings `## operations`, `## Custom operations`, `### Reaching the database from a handler`, `## Custom list metadata` — anchors `#operations`, `#custom-operations`, `#reaching-the-database-from-a-handler`, `#custom-list-metadata` unchanged.

Source content: `docs/integrations/nest/configuration.md` lines 375–569 (`### operations` per-entity section through the end of the file).

- [ ] **Step 1: Write the page**

Create the file with:

1. `# Operations` as the H1.
2. Intro: "Per-operation overrides and fully custom operations on `@Kavo(Entity, config)`, plus how to add data to a list response's `meta` bag."
3. `## operations` (source lines 375–419, promoted from `###`): keep both code examples. Convert the `OperationConfig` field table (lines 388–394) and the `KavoRouteOptions` field table (lines 412–418) to prose bullets. Keep verbatim the `operations.<id>.dto` fallback-order paragraph (line 408) and its ADR/architecture-doc link.
4. `## Custom operations` (source lines 421–505, promoted from `###`): keep both code examples verbatim (the `markPaidOne` handler and the `run(...)` call). Convert the two field tables (lines 448–456, custom-operation fields) to prose bullets. Keep the "#### Reaching the database from a handler" subsection (lines 460–469) as a `###` under this section, verbatim — it states the `context.repository`/transaction/soft-delete contract, which is correctness-critical. Keep the "Worth knowing before you reach for one" bullet list (lines 477–505) verbatim, including the `ImportOutcomeDto`/`KAVO_CONFIG_INVALID` example — every bullet there is a distinct failure mode a reader needs to not be surprised by.
5. `## Custom list metadata` (source lines 507–569): keep all three code examples (`withListMeta` usage, the JSON response sample, the hand-rolled handler) verbatim. Convert the `withListMeta` behavior table (lines 543–550) to prose bullets. Keep the "Transport support" closing paragraph verbatim (it states a real limitation — GraphQL doesn't expose `meta`).

- [ ] **Step 2: Verify build**

Run: `pnpm docs:build`
Expected: succeeds.

- [ ] **Step 3: Format**

Run: `pnpm prettify` then `pnpm format:check`
Expected: passes clean.

- [ ] **Step 4: Commit**

```bash
git add docs/integrations/nest/configuration/operations.md
git commit -m "docs: split operations out of configuration.md"
```

---

### Task 7: Rewrite `configuration.md` as a landing page, fix sidebar and cross-links

**Files:**

- Modify: `docs/integrations/nest/configuration.md` (full rewrite)
- Modify: `docs/.vitepress/config.mts`
- Modify: `docs/using-the-api.md`

**Interfaces:**

- Consumes: the four subpages from Tasks 3–6 at `/integrations/nest/configuration/{module-setup,settings,entity-config,operations}`.

- [ ] **Step 1: Rewrite `configuration.md`**

Replace the entire file with:

```markdown
# Configuration

[Nest + TypeORM](/integrations/nest/typeorm), [Nest + Prisma](/integrations/nest/prisma), [Nest + Mongoose](/integrations/nest/mongoose), and [Nest + MikroORM](/integrations/nest/mikroorm) cover the zero-config path. Once zero-config isn't enough, configuration resolves through one precedence chain, each scope overriding the one before it:

\`\`\`
built-in defaults → global (KavoModule) → entity (@Kavo config) → operation (operations.<id>) → per-call
\`\`\`

A field you don't set at a given scope just falls through to the next one down. The full merge semantics (deep-merge rules, what "unset" means per field) are in [Configuration](/internals/architecture/08-configuration) — these pages document what each field means and where you can set it:

- **[Module setup](/integrations/nest/configuration/module-setup)** — `KavoModule.forRoot`/`forRootAsync`, and the `principal` extractor.
- **[Settings](/integrations/nest/configuration/settings)** — the app-wide `KavoSettings` fields: pagination, query, errors, relations, arrayMutation, caching, softDelete, realtime.
- **[Entity config](/integrations/nest/configuration/entity-config)** — `@Kavo(Entity, config)`'s own fields: `dto`, `allowlists`, `computed`.
- **[Operations](/integrations/nest/configuration/operations)** — per-operation overrides, custom operations, and custom list metadata.
```

(Write it without the backslash-escapes above — those are only to keep the fenced code block inside this plan's own fence; the actual file has a normal triple-backtick block with no language tag around the precedence chain.)

- [ ] **Step 2: Update the sidebar in `config.mts`**

Read the current sidebar entry (around line 137): `{ text: "Configuration", link: "/integrations/nest/configuration" }`. Replace it with a nested group:

```ts
{
  text: "Configuration",
  link: "/integrations/nest/configuration",
  items: [
    { text: "Module setup", link: "/integrations/nest/configuration/module-setup" },
    { text: "Settings", link: "/integrations/nest/configuration/settings" },
    { text: "Entity config", link: "/integrations/nest/configuration/entity-config" },
    { text: "Operations", link: "/integrations/nest/configuration/operations" },
  ],
},
```

This sits inside the existing `Nest` sidebar group alongside the `TypeORM`/`Prisma`/`Mongoose`/`MikroORM` entries — same nesting level, just replacing the single `Configuration` leaf. Leave the `nav` entry near line 111 (`{ text: "Nest configuration", link: "/integrations/nest/configuration" }`) pointing at the landing page unchanged — the nav dropdown stays flat and links to the landing page, which now fans out via its own links.

- [ ] **Step 3: Fix anchor links in `using-the-api.md`**

Update these links (grep `integrations/nest/configuration` in the file to find them all — there are 9 occurrences across 8 lines):

| Old link | New link |
| --- | --- |
| `/integrations/nest/configuration#allowlists` (×2, lines ~41 and ~76 and ~191 — 3 occurrences total) | `/integrations/nest/configuration/entity-config#allowlists` |
| `/integrations/nest/configuration` (no anchor, ~line 107, about page-based pagination) | `/integrations/nest/configuration/settings#pagination` |
| `/integrations/nest/configuration#computed` (~line 218) | `/integrations/nest/configuration/entity-config#computed` |
| `/integrations/nest/configuration#relations` (~line 226) | `/integrations/nest/configuration/settings#relations` |
| `/integrations/nest/configuration#custom-list-metadata` (~line 251) | `/integrations/nest/configuration/operations#custom-list-metadata` |
| `/integrations/nest/configuration#caching` (×3, ~lines 290, 297, 305) | `/integrations/nest/configuration/settings#caching` |

Do a literal find of every `integrations/nest/configuration` substring in the file and replace per the table above — do not do a blind global replace, since the "no anchor" case gets a different target than the anchored ones.

- [ ] **Step 4: Verify links and build**

Run: `pnpm docs:links && pnpm docs:build`
Expected: both succeed with zero broken links. This is the first point in the plan where `docs:links` can actually pass end-to-end, since Tasks 3–6 created the targets these links now point to.

- [ ] **Step 5: Format**

Run: `pnpm prettify` then `pnpm format:check`
Expected: passes clean.

- [ ] **Step 6: Commit**

```bash
git add docs/integrations/nest/configuration.md docs/.vitepress/config.mts docs/using-the-api.md
git commit -m "docs: configuration.md becomes a landing page, fix cross-links"
```

---

### Task 8: Tone pass + Stack Picker banner on `getting-started.md`

**Files:**

- Modify: `docs/getting-started.md`

**Interfaces:**

- Consumes: `StackPicker.vue` from Task 1, imported as `import StackPicker from "../.vitepress/theme/components/StackPicker.vue"` (this file is one directory below `docs/`), used with no `orm` prop (the ORM-agnostic banner variant).

This page is already mostly task-based; the changes here are narrow.

- [ ] **Step 1: Add the picker banner**

After the second paragraph (source line 5, "Today Kavo supports NestJS... see [Nest + Prisma]... for the equivalents.") and before `## Requirements`, insert:

```markdown
<script setup lang="ts">
import StackPicker from "../.vitepress/theme/components/StackPicker.vue";
</script>

Pick your stack and jump straight to its wiring guide, or keep reading — this page walks through Nest + TypeORM.

<StackPicker />
```

- [ ] **Step 2: Trim the two densest paragraphs**

Replace the `useDefineForClassFields` paragraph (source line 30) with a shorter version that keeps every load-bearing fact (the `undefined`-vs-absent hazard, that it must be `false`, and what breaks if it's `true`) but drops the restated mechanism of *why* `Object.keys` and TypeORM's diffing behave that way:

```markdown
`useDefineForClassFields: false` is load-bearing at `ES2022` and above. With it on, every declared field is emitted as a real class field set to `undefined` when not hydrated — so a partially-loaded entity looks fully populated, `undefined` values leak into responses instead of being absent, and TypeORM's persistence diffing treats them as explicit writes. With it off (what Kavo's own packages and both example apps use), only hydrated fields are set.
```

Replace the "Both hops say optional" paragraph (source line 73) with a shorter version keeping the actionable fact (both hops declare the peer optional, so nothing installs unless you ask) and dropping the historical "before this change" framing:

```markdown
Both `@kavo/nest`'s dependency on the binding and the binding's own peer declare the protocol library optional, so a REST-only install pulls in neither `graphql` nor the MCP SDK — you add the protocol library yourself only when you use it.
```

- [ ] **Step 3: Verify links and build**

Run: `pnpm docs:links && pnpm docs:build`
Expected: both succeed.

- [ ] **Step 4: Format**

Run: `pnpm prettify` then `pnpm format:check`
Expected: passes clean.

- [ ] **Step 5: Commit**

```bash
git add docs/getting-started.md
git commit -m "docs: simplify getting-started.md, add Stack Picker banner"
```

---

### Task 9: Tone pass on `using-the-api.md`

**Files:**

- Modify: `docs/using-the-api.md`

No structural split here (the page is 345 lines across 16 topic headings, already organized by task, not by field) — this task only trims reference-style density within existing sections, keeping every heading and anchor unchanged (Task 7 already updated other pages' links into this file's anchors, so anchors here must not move).

- [ ] **Step 1: Read the current file in full**

Read `docs/using-the-api.md` end to end before editing, since the exact wording of dense passages needs to be identified in the live file rather than guessed from a summary.

- [ ] **Step 2: Apply the tone rule section by section**

For each `##`/`###` section, apply this rule uniformly: keep every code/HTTP example verbatim; keep every sentence that states a hazard, a limit, or a distinct behavior a reader must know to not get a wrong result (400s, silent drops, security-relevant defaults, ADR-linked design decisions); compress sentences that only restate the mechanism behind a fact already given, or that repeat something the code example already shows. Do not shorten the `## ETags and conditional requests` section's four `###` subsections below the level of stating each of: what triggers it, what status code results, and the one caveat that makes it not a full guarantee (check-then-write, not atomic) — this mirrors the same caching/ETag correctness content Task 4 preserves on the settings page, and the two pages must not contradict each other.

- [ ] **Step 3: Verify links and build**

Run: `pnpm docs:links && pnpm docs:build`
Expected: both succeed, with the same set of headings/anchors as before this task (confirm with `grep -n '^#' docs/using-the-api.md` before and after — the list of heading lines must be identical, only body prose changes).

- [ ] **Step 4: Format**

Run: `pnpm prettify` then `pnpm format:check`
Expected: passes clean.

- [ ] **Step 5: Commit**

```bash
git add docs/using-the-api.md
git commit -m "docs: simplify using-the-api.md tone"
```

---

### Task 10: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full docs gate**

Run: `pnpm docs:build && pnpm docs:links && pnpm format:check`
Expected: all three pass clean.

- [ ] **Step 2: Run the repo's own gate to confirm nothing outside docs broke**

Run: `pnpm check`
Expected: passes (this plan touches no `packages/*` or `examples/*` source, so this should be a no-op confirmation, but `docs/.vitepress/config.mts` and the new `.vue` file are TypeScript-adjacent enough to be worth confirming).

- [ ] **Step 3: Spot-check preserved safety content survived intact**

Run: `grep -n "credential control" docs/integrations/nest/configuration/entity-config.md` — expect one match (the `::: danger` box heading survived).
Run: `grep -n "Migrating from before v0.10" docs/integrations/nest/configuration/settings.md` — expect one match.
Run: `grep -n "must be total, not merely pure" docs/integrations/nest/configuration/entity-config.md` — expect one match.

If any of these three greps come back empty, the corresponding Task (5 or 4) dropped safety-critical content — go back and fix it before continuing.

- [ ] **Step 4: No commit** — this task is verification only, nothing to stage.
