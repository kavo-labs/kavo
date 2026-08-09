<template>
  <div v-if="reduceMotion" class="flow-static">
    <p class="flow-static-line"><span class="flow-static-tag">Request</span>{{ REQUEST_LABEL }} &rarr; Kavo</p>
    <p class="flow-static-line">
      <span class="flow-static-tag flow-static-tag--event">Event</span>Kavo &rarr; SSE &middot; {{ EVENT_LABEL }}
      &rarr; Your app
    </p>
  </div>
  <div v-else class="flow-demo" role="img" :aria-label="ariaLabel">
    <div class="flow-label">{{ label }}</div>
    <div class="flow-track">
      <div class="flow-node" :class="{ 'flow-node--pulse': phase === 'client-pulse' }">Your app</div>
      <div class="flow-line">
        <div class="flow-dot" :class="{ 'flow-dot--right': dotAtRight }"></div>
      </div>
      <div class="flow-node" :class="{ 'flow-node--pulse': phase === 'server-pulse' }">Kavo</div>
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

type PhaseName = "request-idle" | "request-sending" | "server-pulse" | "event-idle" | "event-sending" | "client-pulse";

const REQUEST_LABEL = "PATCH /books/42";
const EVENT_LABEL = "SSE · book.updated";

const PHASES: { name: PhaseName; duration: number; dotAtRight: boolean; label: string }[] = [
  { name: "request-idle", duration: 900, dotAtRight: false, label: REQUEST_LABEL },
  { name: "request-sending", duration: 650, dotAtRight: true, label: REQUEST_LABEL },
  { name: "server-pulse", duration: 700, dotAtRight: true, label: REQUEST_LABEL },
  { name: "event-idle", duration: 900, dotAtRight: true, label: EVENT_LABEL },
  { name: "event-sending", duration: 650, dotAtRight: false, label: EVENT_LABEL },
  { name: "client-pulse", duration: 700, dotAtRight: false, label: EVENT_LABEL },
];

const ariaLabel = `Diagram: a ${REQUEST_LABEL} request goes from your app to Kavo, then Kavo pushes a ${EVENT_LABEL} event back to your app over SSE.`;

const phaseIndex = ref(0);
const phase = computed<PhaseName>(() => PHASES[phaseIndex.value].name);
const reduceMotion = ref(false);
const isPlaying = ref(true);
let timer: ReturnType<typeof setTimeout> | undefined;

const dotAtRight = computed(() => PHASES[phaseIndex.value].dotAtRight);

const label = computed(() => PHASES[phaseIndex.value].label);

function advance() {
  timer = setTimeout(() => {
    phaseIndex.value = (phaseIndex.value + 1) % PHASES.length;
    advance();
  }, PHASES[phaseIndex.value].duration);
}

function togglePlay() {
  isPlaying.value = !isPlaying.value;
  if (isPlaying.value) {
    advance();
  } else {
    clearTimeout(timer);
  }
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

/*
 * `left` (not `transform`) because the dot is positioned at a percentage
 * offset of the track, and a percentage `translateX` resolves against the
 * dot's own tiny box rather than the track — `left` is the property that
 * actually walks the dot across the line.
 */
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
