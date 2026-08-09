# Realtime section flow animation — design

## Goal

The homepage's "Realtime, without a second system" section (`docs/index.md`, rendered via `RealtimeSection.vue`) currently shows only a static grid of realtime-use-case tags. Add a small animated diagram above that grid that visually demonstrates the section's claim: a mutation request goes through the same engine, and the resulting event arrives over SSE — one pipeline, not two.

## Scope

- New component: `docs/.vitepress/theme/components/RealtimeFlowDemo.vue`.
- Rendered inside `RealtimeSection.vue`, above the existing `.realtime-categories` grid. The grid itself is unchanged.
- No changes to `docs/index.md` beyond what's already there (it already imports and renders `<RealtimeSection />`).

## Visual design

Two rounded boxes connected by a horizontal track:

- Left box: **"Your app"**
- Right box: **"Kavo"**
- A small dot travels along the track between them.
- A single label above the track shows the current step's text.

### Animation cycle (repeats)

1. **Idle / request pending** — label: `PATCH /books/42`. Dot sits at the left box.
2. **Request in flight** — dot animates left → right along the track (CSS transform transition). On arrival, the Kavo box gets a brief pulse/glow (the write landing in the engine).
3. **Hold**, then label swaps to `SSE · book.updated`; dot resets to the right box.
4. **Event in flight** — dot animates right → left. On arrival, the "Your app" box gets a brief pulse/glow (the event arriving client-side).
5. **Hold**, then fade/reset back to step 1 and repeat.

Single fixed scenario — no cycling through multiple examples (unlike `McpChatDemo.vue`'s multi-conversation carousel). This stays a small decorative diagram, not a second interactive demo surface.

## Mechanism

Reuses the same animation approach already established by `McpChatDemo.vue` on this homepage — a `setTimeout`-driven phase state machine in Vue, with CSS `transition` doing the actual visual interpolation. This is a deliberate constraint: no new animation library, no canvas, no JS-driven frame-by-frame tweening — just the existing "ref phase + CSS transition" pattern already proven on this page.

- A `ref` holds the current phase (e.g. `"idle-request" | "sending" | "server-pulse" | "idle-event" | "pushing" | "client-pulse"`).
- `setTimeout` advances phases on a fixed cadence (values TBD at implementation time, in the same ballpark as `McpChatDemo`'s `STEP_MS`/`HOLD_MS`).
- The dot's horizontal position is a CSS class/inline style keyed off phase, animated via `transition: transform`.
- Box pulse is a CSS class toggled on arrival, removed after the pulse's CSS animation duration.
- Styling uses the existing `--vp-c-*` VitePress theme tokens (matches `homepage-sections.css` / `RealtimeSection.vue`'s existing scoped styles), so it inherits light/dark theme support for free.

### Reduced motion

On mount, check `window.matchMedia("(prefers-reduced-motion: reduce)").matches`, same as `McpChatDemo.vue`. If true:

- No `setTimeout` loop starts.
- The diagram renders statically in an end-state that communicates both steps at once (e.g. request label + event label both visible, no dot motion) rather than being stuck mid-animation.

### No play/pause control

Unlike `McpChatDemo.vue`, this diagram gets no play/pause button — it's a small ambient illustration, not a demo the user is expected to step through.

## Out of scope

- No changes to the SSE example app, `@kavo/sse`, or any non-docs package.
- No changes to the existing category grid content or its styles.
- No new homepage-wide animation infrastructure — this reuses the existing per-component `setTimeout` + CSS-transition pattern.

## Testing / verification

This is a docs-site visual change with no unit-testable logic beyond the phase state machine (which has no branching worth a Vitest spec — it's a linear timer sequence, same as `McpChatDemo`'s, which itself has no test file). Verification is: `pnpm docs:build` succeeds, and manual visual check via `pnpm --filter docs docs:dev` (or repo's actual docs dev script) confirming:

- Animation cycles correctly (request → server pulse → event → client pulse → reset).
- `prefers-reduced-motion: reduce` (via browser/OS emulation) shows the static end-state with no motion.
- Light and dark theme both render legibly.
- Layout doesn't break at the existing grid's mobile breakpoint (`max-width: 719px`).
