<template>
  <div v-if="reduceMotion" class="flow-static">
    <p class="flow-static-line"><span class="flow-static-tag">Request</span>{{ REQUEST_LABEL }} &rarr; Kavo</p>
    <p class="flow-static-line">
      <span class="flow-static-tag flow-static-tag--event">Event</span>Kavo &rarr; SSE &middot; {{ EVENT_LABEL }}
      &rarr; Your app
    </p>
  </div>
  <div v-else class="flow-window" role="img" :aria-label="ariaLabel">
    <div class="flow-window-header">
      <span class="flow-window-dot flow-window-dot--red"></span>
      <span class="flow-window-dot flow-window-dot--yellow"></span>
      <span class="flow-window-dot flow-window-dot--green"></span>
      <span class="flow-window-title">SSE &mdash; Realtime</span>
    </div>
    <div class="flow-window-body">
      <TransitionGroup tag="div" name="flow-msg" class="flow-feed">
        <div v-if="visibleCount >= 1" key="request" class="flow-row">
          <span class="flow-row-tag">request</span>
          <span class="flow-row-text">{{ REQUEST_LABEL }}</span>
        </div>
        <div v-if="visibleCount >= 2" key="event" class="flow-row flow-row--event">
          <span class="flow-row-tag flow-row-tag--event">sse</span>
          <span class="flow-row-text">event: {{ EVENT_LABEL }}</span>
        </div>
      </TransitionGroup>
    </div>
  </div>
  <button
    v-if="!reduceMotion"
    type="button"
    class="flow-play-btn"
    :aria-label="isPlaying ? 'Pause' : 'Play'"
    :aria-pressed="isPlaying"
    @click="togglePlay"
  >
    <svg v-if="isPlaying" class="flow-play-icon" viewBox="0 0 16 16" fill="currentColor">
      <rect x="3" y="2" width="4" height="12" rx="1.5" />
      <rect x="9" y="2" width="4" height="12" rx="1.5" />
    </svg>
    <svg v-else class="flow-play-icon" viewBox="0 0 16 16" fill="currentColor">
      <polygon points="4,2 13,8 4,14" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" />
    </svg>
  </button>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

const REQUEST_LABEL = "PATCH /books/42";
const EVENT_LABEL = "book.updated";

const ariaLabel = `Diagram: a ${REQUEST_LABEL} request goes from your app to Kavo, then Kavo pushes a ${EVENT_LABEL} event back to your app over SSE.`;

const STEP_MS = 900;
const HOLD_MS = 2200;
const RESET_PAUSE_MS = 500;

const visibleCount = ref(0);
const reduceMotion = ref(false);
const isPlaying = ref(true);
let timer: ReturnType<typeof setTimeout> | undefined;

function tick() {
  if (visibleCount.value < 2) {
    visibleCount.value += 1;
    timer = setTimeout(tick, STEP_MS);
    return;
  }
  timer = setTimeout(() => {
    visibleCount.value = 0;
    timer = setTimeout(tick, RESET_PAUSE_MS);
  }, HOLD_MS);
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
    visibleCount.value = 2;
    return;
  }
  timer = setTimeout(tick, STEP_MS);
});

onUnmounted(() => {
  clearTimeout(timer);
});
</script>

<style scoped>
.flow-window {
  max-width: 420px;
  margin: 0 auto 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-code-block-bg);
  text-align: left;
  box-shadow: 0 12px 32px -20px rgba(0, 0, 0, 0.4);
}

.flow-window-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}

.flow-window-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.flow-window-dot--red {
  background: #ff5f56;
}

.flow-window-dot--yellow {
  background: #ffbd2e;
}

.flow-window-dot--green {
  background: #27c93f;
}

.flow-window-title {
  margin-left: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--vp-c-text-3);
}

.flow-window-body {
  position: relative;
  height: 84px;
  overflow: hidden;
}

.flow-feed {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100%;
  gap: 10px;
  padding: 16px 18px;
}

.flow-msg-enter-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.flow-msg-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.flow-msg-leave-active {
  transition: opacity 0.15s ease;
  position: absolute;
}

.flow-msg-leave-to {
  opacity: 0;
}

.flow-msg-move {
  transition: transform 0.18s ease;
}

.flow-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--vp-c-brand-1) 40%, var(--vp-c-divider));
  background: var(--vp-c-brand-soft);
}

.flow-row--event {
  border-color: var(--vp-c-divider);
  background: transparent;
  margin-left: 12px;
  border-left: 2px solid var(--vp-c-divider);
  border-radius: 0;
}

.flow-row-tag {
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
  opacity: 0.8;
}

.flow-row-tag--event {
  color: var(--vp-c-text-3);
}

.flow-row-text {
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  color: var(--vp-c-text-1);
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

.flow-play-btn {
  appearance: none;
  -webkit-appearance: none;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
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

.flow-play-btn:hover {
  color: var(--vp-c-text-1);
}

.flow-play-icon {
  width: 14px;
  height: 14px;
}

@media (prefers-reduced-motion: reduce) {
  .flow-window-body {
    height: auto;
    overflow: visible;
  }
}
</style>
