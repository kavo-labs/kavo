<template>
  <div class="mcp-window">
    <div class="mcp-window-header">
      <span class="mcp-window-dot mcp-window-dot--red"></span>
      <span class="mcp-window-dot mcp-window-dot--yellow"></span>
      <span class="mcp-window-dot mcp-window-dot--green"></span>
      <span class="mcp-window-title">MCP client: {{ tabLabels[activeConvo] }}</span>
    </div>
    <div class="mcp-window-body">
      <TransitionGroup tag="div" name="mcp-msg" class="mcp-feed">
        <template v-for="(msg, i) in visibleMessages" :key="`${activeConvo}-${i}`">
          <div v-if="msg.kind === 'user'" class="mcp-turn mcp-turn--user">
            <span class="mcp-turn-tag">You</span>
            <p class="mcp-turn-text">{{ msg.text }}</p>
          </div>
          <div v-else-if="msg.kind === 'agent'" class="mcp-turn mcp-turn--agent">
            <span class="mcp-turn-tag mcp-turn-tag--agent">Agent</span>
            <p class="mcp-turn-text">{{ msg.text }}</p>
          </div>
          <div v-else-if="msg.kind === 'call'" class="mcp-call">
            <span class="mcp-call-tag">call</span>
            <span class="mcp-call-name">{{ msg.name }}</span>
            <span class="mcp-call-args">{{ msg.args }}</span>
          </div>
          <div v-else class="mcp-result">{{ msg.text }}</div>
        </template>
      </TransitionGroup>
    </div>
  </div>
  <div class="mcp-controls">
    <div class="mcp-dots" role="tablist" aria-label="MCP demo conversations">
      <button
        v-for="(label, i) in tabLabels"
        :key="label"
        type="button"
        role="tab"
        class="mcp-dot"
        :class="{ 'mcp-dot--active': activeConvo === i }"
        :aria-selected="activeConvo === i"
        :aria-label="`Show ${label} conversation`"
        @click="selectConvo(i)"
      ></button>
    </div>
    <button
      v-if="!reduceMotion"
      type="button"
      class="mcp-play-btn"
      :aria-label="isPlaying ? 'Pause' : 'Play'"
      :aria-pressed="isPlaying"
      @click="togglePlay"
    >
      <svg v-if="isPlaying" class="mcp-play-icon" viewBox="0 0 16 16" fill="currentColor">
        <rect x="3" y="2" width="4" height="12" rx="1.5" />
        <rect x="9" y="2" width="4" height="12" rx="1.5" />
      </svg>
      <svg v-else class="mcp-play-icon" viewBox="0 0 16 16" fill="currentColor">
        <polygon points="4,2 13,8 4,14" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";

type ChatMessage =
  | { kind: "user" | "agent"; text: string }
  | { kind: "call"; name: string; args: string }
  | { kind: "result"; text: string };

/**
 * Each conversation is its own standard-operation showcase, kept at or
 * under the length of the first (6 messages) so no replay in the loop
 * runs longer than the others.
 */
const conversations: ChatMessage[][] = [
  [
    { kind: "user", text: "Archive book #42 and tell me who wrote it." },
    { kind: "call", name: "book.patchOne", args: '{ id: 42, status: "archived" }' },
    { kind: "result", text: '{ "id": 42, "status": "archived" }' },
    { kind: "call", name: "book.findOne", args: '{ id: 42, include: "author" }' },
    { kind: "result", text: '{ "author": { "name": "Ursula K. Le Guin" } }' },
    { kind: "agent", text: "Done. Book #42 is archived. It was written by Ursula K. Le Guin." },
  ],
  [
    { kind: "user", text: "Add a new book: Dune by Frank Herbert." },
    { kind: "call", name: "book.createOne", args: '{ title: "Dune", author: "Frank Herbert" }' },
    { kind: "result", text: '{ "id": 43, "title": "Dune" }' },
    { kind: "agent", text: "Created Book #43: Dune by Frank Herbert." },
  ],
  [
    { kind: "user", text: "How many books are published?" },
    { kind: "call", name: "book.findMany", args: '{ filter: { status: { eq: "published" } } }' },
    { kind: "result", text: '{ "total": 128 }' },
    { kind: "agent", text: "128 books are currently published." },
  ],
  [
    { kind: "user", text: "What are the 3 most popular romance books?" },
    {
      kind: "call",
      name: "book.findMany",
      args: '{ filter: { genre: { eq: "romance" } }, sort: "-views", limit: 3 }',
    },
    {
      kind: "result",
      text:
        '{ "items": [{ "title": "The Notebook", "views": 84200 }, ' +
        '{ "title": "Pride and Prejudice", "views": 79500 }, ' +
        '{ "title": "Outlander", "views": 71300 }] }',
    },
    {
      kind: "agent",
      text: "Top 3: The Notebook (84,200), Pride and Prejudice (79,500), and Outlander (71,300).",
    },
  ],
  [
    { kind: "user", text: "I accidentally deleted book #17, can you bring it back?" },
    { kind: "call", name: "book.restoreOne", args: "{ id: 17 }" },
    { kind: "result", text: '{ "id": 17, "deletedAt": null }' },
    { kind: "agent", text: "Restored Book #17." },
  ],
  [
    { kind: "user", text: "Fix the titles on books #8 and #15, both have typos." },
    { kind: "call", name: "book.updateOne", args: '{ id: 8, title: "Foundation and Empire" }' },
    { kind: "result", text: '{ "id": 8, "title": "Foundation and Empire" }' },
    { kind: "call", name: "book.updateOne", args: '{ id: 15, title: "Foundation\'s Edge" }' },
    { kind: "result", text: '{ "id": 15, "title": "Foundation\'s Edge" }' },
    { kind: "agent", text: "Updated both: Book #8 and Book #15 now have corrected titles." },
  ],
  [
    { kind: "user", text: "Delete book #12, we're pulling it from the catalog." },
    { kind: "call", name: "book.findOne", args: "{ id: 12 }" },
    { kind: "result", text: '{ "id": 12, "title": "The Dispossessed" }' },
    { kind: "call", name: "book.deleteOne", args: "{ id: 12 }" },
    { kind: "result", text: '{ "deleted": true }' },
    { kind: "agent", text: "Deleted Book #12: The Dispossessed." },
  ],
];

const tabLabels = ["Archive", "Create", "Count", "Find", "Restore", "Update", "Delete"];

const STEP_MS = 300;
const HOLD_MS = 7000;
const RESET_PAUSE_MS = 200;

const activeConvo = ref(0);
const visibleCount = ref(0);
const isPlaying = ref(true);
const visibleMessages = computed(() => conversations[activeConvo.value].slice(0, visibleCount.value));
let timer: ReturnType<typeof setTimeout> | undefined;

function tick() {
  const convo = conversations[activeConvo.value];
  if (visibleCount.value < convo.length) {
    visibleCount.value += 1;
    timer = setTimeout(tick, STEP_MS);
    return;
  }
  timer = setTimeout(async () => {
    // Advance the dot on its own frame first, then clear the feed — doing
    // both in the same Vue patch lets the TransitionGroup's message-clear
    // repaint eat the dot's crossfade, so the active dot reads as an
    // instant flash instead of a smooth transition.
    activeConvo.value = (activeConvo.value + 1) % conversations.length;
    await nextTick();
    visibleCount.value = 0;
    timer = setTimeout(tick, RESET_PAUSE_MS);
  }, HOLD_MS);
}

const reduceMotion = ref(false);

async function selectConvo(i: number) {
  clearTimeout(timer);
  activeConvo.value = i;
  if (reduceMotion.value) {
    visibleCount.value = conversations[i].length;
    return;
  }
  await nextTick();
  visibleCount.value = 0;
  isPlaying.value = true;
  timer = setTimeout(tick, STEP_MS);
}

function togglePlay() {
  isPlaying.value = !isPlaying.value;
  if (isPlaying.value) {
    timer = setTimeout(tick, STEP_MS);
  } else {
    clearTimeout(timer);
  }
}

onMounted(() => {
  reduceMotion.value = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion.value) {
    visibleCount.value = conversations[0].length;
    return;
  }
  timer = setTimeout(tick, STEP_MS);
});

onUnmounted(() => {
  clearTimeout(timer);
});
</script>

<style scoped>
.mcp-controls {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  margin-top: 16px;
}

.mcp-dots {
  display: flex;
  grid-column: 2;
  justify-self: center;
}

.mcp-dot {
  box-sizing: content-box;
  appearance: none;
  -webkit-appearance: none;
  width: 11px;
  height: 11px;
  padding: 6px;
  border: none;
  border-radius: 50%;
  background: var(--vp-c-divider);
  background-clip: content-box;
  cursor: pointer;
  transition: background-color 0.15s;
}

.mcp-dot:hover {
  background: var(--vp-c-text-3);
  background-clip: content-box;
}

.mcp-dot--active,
.mcp-dot--active:hover {
  background: var(--vp-c-brand-1);
  background-clip: content-box;
}

.mcp-play-btn {
  appearance: none;
  -webkit-appearance: none;
  display: flex;
  align-items: center;
  justify-content: center;
  grid-column: 3;
  justify-self: start;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--vp-c-text-3);
  cursor: pointer;
  transition:
    color 0.15s,
    background-color 0.15s;
}

.mcp-play-btn:hover {
  color: var(--vp-c-text-1);
}

.mcp-play-icon {
  width: 14px;
  height: 14px;
}

.mcp-window {
  max-width: 620px;
  margin: 0 auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-code-block-bg);
  text-align: left;
  box-shadow: 0 12px 32px -20px rgba(0, 0, 0, 0.4);
}

.mcp-window-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.mcp-window-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.mcp-window-dot--red {
  background: #ff5f56;
}

.mcp-window-dot--yellow {
  background: #ffbd2e;
}

.mcp-window-dot--green {
  background: #27c93f;
}

.mcp-window-title {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--vp-c-text-3);
}

.mcp-window-body {
  position: relative;
  height: 345px;
  overflow: hidden;
}

@media (max-width: 600px) {
  .mcp-window-body {
    height: 455px;
  }
}

@media (max-width: 440px) {
  .mcp-window-body {
    height: 500px;
  }
}

@media (max-width: 410px) {
  .mcp-window-body {
    height: 550px;
  }
}

.mcp-feed {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-height: 100%;
  gap: 10px;
  padding: 18px 20px 22px;
}

/*
 * Durations are kept comfortably under STEP_MS (the reveal cadence)
 * so one message's enter/move transition always finishes before the
 * next tick starts another — otherwise Vue's FLIP "move" recalculates
 * mid-transition and messages can visibly overlap.
 */
.mcp-msg-enter-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.mcp-msg-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.mcp-msg-leave-active {
  transition: opacity 0.15s ease;
  position: absolute;
}

.mcp-msg-leave-to {
  opacity: 0;
}

.mcp-msg-move {
  transition: transform 0.18s ease;
}

.mcp-turn-tag {
  display: inline-block;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
  margin-bottom: 4px;
}

.mcp-turn-tag--agent {
  color: var(--vp-c-brand-1);
}

.mcp-turn-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--vp-c-text-1);
}

.mcp-call {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 40%, var(--vp-c-divider));
  background: var(--vp-c-brand-soft);
}

.mcp-call-tag {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  opacity: 0.8;
}

.mcp-call-name {
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.mcp-call-args {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.mcp-result {
  margin-left: 12px;
  padding: 6px 12px;
  border-left: 2px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-3);
}

@media (prefers-reduced-motion: reduce) {
  .mcp-window-body {
    height: auto;
    overflow: visible;
    mask-image: none;
  }
}
</style>
