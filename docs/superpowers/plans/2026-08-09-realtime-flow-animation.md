# Realtime Flow Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small looping animated diagram to the homepage's "Realtime, without a second system" section that shows a mutation request going from the client to Kavo, followed by the resulting event arriving back over SSE.

**Architecture:** A single new Vue SFC, `RealtimeFlowDemo.vue`, rendered inside the existing `RealtimeSection.vue` above the current category grid. It uses a `setTimeout`-driven phase state machine (the same pattern `McpChatDemo.vue` already uses on this page) with CSS `transition` doing the visual interpolation — no new animation library.

**Tech Stack:** Vue 3 `<script setup>` SFC, VitePress theme (`--vp-c-*` CSS custom properties), no new dependencies.

## Global Constraints

- No new animation library, canvas, or JS frame-by-frame tweening — only `setTimeout` phase state + CSS `transition`, matching `McpChatDemo.vue`'s existing pattern (per the spec's "Mechanism" section).
- Single fixed scenario (`PATCH /books/42` → `SSE · book.updated`) — no multi-example cycling.
- No play/pause control.
- Must check `prefers-reduced-motion` on mount (same check as `McpChatDemo.vue`: `window.matchMedia("(prefers-reduced-motion: reduce)").matches`) and render a static, motion-free end-state summary instead of animating.
- Styling must use existing `--vp-c-*` VitePress theme tokens so light/dark theme both work with no extra theme code.
- Existing `.realtime-categories` grid and its styles are untouched.
- Verification command for this whole plan: `pnpm docs:build` (there is no vue-tsc/typecheck step for docs components; this is the actual gate the docs site build runs, per `package.json`'s `docs:build` script).

---

### Task 1: Create `RealtimeFlowDemo.vue`

**Files:**

- Create: `docs/.vitepress/theme/components/RealtimeFlowDemo.vue`

**Interfaces:**

- Consumes: nothing from other components — self-contained, no props.
- Produces: a default-exported Vue SFC importable as `RealtimeFlowDemo` from `./components/RealtimeFlowDemo.vue`, usable as `<RealtimeFlowDemo />` with no props. Task 2 imports and renders it.

- [ ] **Step 1: Write the component file**

```vue
<template>
  <div v-if="reduceMotion" class="flow-static">
    <p class="flow-static-line"><span class="flow-static-tag">Request</span>PATCH /books/42 &rarr; Kavo</p>
    <p class="flow-static-line">
      <span class="flow-static-tag flow-static-tag--event">Event</span>Kavo &rarr; SSE &middot; book.updated &rarr; Your
      app
    </p>
  </div>
  <div
    v-else
    class="flow-demo"
    role="img"
    aria-label="Diagram: a PATCH request goes from your app to Kavo, then Kavo pushes a book.updated event back to your app over SSE."
  >
    <div class="flow-label">{{ label }}</div>
    <div class="flow-track">
      <div class="flow-node" :class="{ 'flow-node--pulse': phase === 'client-pulse' }">Your app</div>
      <div class="flow-line">
        <div class="flow-dot" :class="{ 'flow-dot--right': dotAtRight }"></div>
      </div>
      <div class="flow-node" :class="{ 'flow-node--pulse': phase === 'server-pulse' }">Kavo</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

type PhaseName = "request-idle" | "request-sending" | "server-pulse" | "event-idle" | "event-sending" | "client-pulse";

const PHASES: { name: PhaseName; duration: number }[] = [
  { name: "request-idle", duration: 900 },
  { name: "request-sending", duration: 650 },
  { name: "server-pulse", duration: 700 },
  { name: "event-idle", duration: 900 },
  { name: "event-sending", duration: 650 },
  { name: "client-pulse", duration: 700 },
];

const REQUEST_LABEL = "PATCH /books/42";
const EVENT_LABEL = "SSE · book.updated";

const phaseIndex = ref(0);
const phase = computed<PhaseName>(() => PHASES[phaseIndex.value].name);
const reduceMotion = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const dotAtRight = computed(
  () => phase.value === "request-sending" || phase.value === "server-pulse" || phase.value === "event-idle",
);

const label = computed(() =>
  phase.value === "event-idle" || phase.value === "event-sending" || phase.value === "client-pulse"
    ? EVENT_LABEL
    : REQUEST_LABEL,
);

function advance() {
  timer = setTimeout(() => {
    phaseIndex.value = (phaseIndex.value + 1) % PHASES.length;
    advance();
  }, PHASES[phaseIndex.value].duration);
}

onMounted(() => {
  reduceMotion.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion.value) {
    advance();
  }
});

onUnmounted(() => {
  clearTimeout(timer);
});
</script>

<style scoped>
.flow-demo {
  max-width: 420px;
  margin: 0 auto 28px;
}

.flow-label {
  min-height: 16px;
  margin-bottom: 14px;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.flow-track {
  display: flex;
  align-items: center;
  gap: 10px;
}

.flow-node {
  flex-shrink: 0;
  padding: 10px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  transition:
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}

.flow-node--pulse {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--vp-c-brand-1) 20%, transparent);
}

.flow-line {
  position: relative;
  flex: 1;
  height: 2px;
  background: var(--vp-c-divider);
  border-radius: 999px;
}

.flow-dot {
  position: absolute;
  top: 50%;
  left: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
  transform: translate(-50%, -50%);
  transition: left 0.6s ease;
}

.flow-dot--right {
  left: 100%;
}

.flow-static {
  max-width: 420px;
  margin: 0 auto 28px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}

.flow-static-line {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  color: var(--vp-c-text-2);
}

.flow-static-tag {
  display: inline-block;
  min-width: 64px;
  margin-right: 8px;
  font-weight: 700;
  color: var(--vp-c-brand-1);
}

.flow-static-tag--event {
  color: var(--vp-c-text-2);
}

@media (max-width: 480px) {
  .flow-node {
    padding: 8px 10px;
    font-size: 11px;
  }

  .flow-label {
    font-size: 11px;
  }
}
</style>
```

- [ ] **Step 2: Verify the file has no syntax errors by running the docs build**

Run: `pnpm docs:build`
Expected: build succeeds with no errors referencing `RealtimeFlowDemo.vue` (the component isn't wired into any page yet, so this only confirms the SFC itself parses/compiles — VitePress does a full Vite build of the theme's `components/` directory as part of `docs:build`, so a syntax error in the file surfaces here even before it's used).

- [ ] **Step 3: Commit**

```bash
git add docs/.vitepress/theme/components/RealtimeFlowDemo.vue
git commit -m "feat(docs): add RealtimeFlowDemo animated diagram component"
```

---

### Task 2: Wire `RealtimeFlowDemo` into `RealtimeSection.vue`

**Files:**

- Modify: `docs/.vitepress/theme/components/RealtimeSection.vue`

**Interfaces:**

- Consumes: `RealtimeFlowDemo` default export from `./RealtimeFlowDemo.vue` (Task 1), rendered as `<RealtimeFlowDemo />` with no props.
- Produces: nothing consumed by further tasks — this is the last task in the plan.

- [ ] **Step 1: Add the import and render the component above the category grid**

In `docs/.vitepress/theme/components/RealtimeSection.vue`, change the `<template>` block from:

```vue
<template>
  <div class="realtime-categories"></div>
</template>
```

to:

```vue
<template>
  <RealtimeFlowDemo />
  <div class="realtime-categories"></div>
</template>
```

And add the import at the top of the `<script setup lang="ts">` block, before the `categories` constant:

```ts
import RealtimeFlowDemo from "./RealtimeFlowDemo.vue";
```

So the full script block reads:

```vue
<script setup lang="ts">
import RealtimeFlowDemo from "./RealtimeFlowDemo.vue";

const categories = [
  {
    title: "Client-facing UI",
    features: ["Live dashboards", "Badge counts", "Presence", "Scoped inventory views", "Job progress"],
  },
  {
    title: "Service-to-service",
    features: ["Cache invalidation", "Search index sync", "Audit trails", "Analytics pipelines"],
  },
  {
    title: "External-facing",
    features: ["Partner webhooks", "Mobile push"],
  },
];
</script>
```

Leave the rest of `RealtimeSection.vue` (the `.realtime-categories` grid markup and its `<style scoped>` block) unchanged.

- [ ] **Step 2: Build the docs site**

Run: `pnpm docs:build`
Expected: build succeeds with no errors.

- [ ] **Step 3: Manually verify in the dev server**

Run: `pnpm docs:dev`

Open the homepage in a browser and scroll to the "Realtime, without a second system" section. Confirm:

- The diagram appears above the three-column category grid.
- The cycle runs: `PATCH /books/42` label with dot moving left→right, "Kavo" box pulses, label swaps to `SSE · book.updated`, dot moves right→left, "Your app" box pulses, then it repeats.
- Toggling `prefers-reduced-motion: reduce` in devtools (Rendering tab → "Emulate CSS media feature prefers-reduced-motion") and reloading shows the static two-line summary with no motion.
- Both light and dark theme (VitePress theme toggle, top right) render the diagram legibly.
- At a narrow viewport (< 480px), the boxes and label shrink but the layout doesn't break.

Stop the dev server once confirmed (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add docs/.vitepress/theme/components/RealtimeSection.vue
git commit -m "feat(docs): render RealtimeFlowDemo above the realtime category grid"
```
