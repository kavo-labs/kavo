<template>
  <div v-if="reduceMotion" class="flow-static">
    <p class="flow-static-line">
      <span class="flow-static-tag">Broadcast</span>Kavo pushes {{ EVENT_LABEL }} to 3 connected clients over SSE,
      simultaneously.
    </p>
  </div>
  <div v-else class="flow-broadcast" role="img" :aria-label="ariaLabel">
    <div class="flow-broadcast-label">event: {{ EVENT_LABEL }}</div>
    <div class="flow-canvas">
      <svg class="flow-lines" viewBox="0 0 320 170" aria-hidden="true">
        <line
          v-for="(c, i) in clients"
          :key="i"
          :x1="hubX"
          :y1="hubY"
          :x2="c.x"
          :y2="c.y"
          class="flow-line-svg"
          :class="{ 'flow-line-svg--flowing': phase === 'broadcasting' || phase === 'client-pulse' }"
        />
      </svg>

      <div
        class="flow-hub"
        :class="{ 'flow-hub--pulse': phase === 'server-pulse' }"
        :style="{ left: `${hubX}px`, top: `${hubY}px` }"
      >
        Kavo <span class="flow-node-role">server</span>
      </div>

      <div
        v-for="(c, i) in clients"
        :key="`client-${i}`"
        class="flow-client"
        :class="{ 'flow-client--pulse': phase === 'client-pulse' }"
        :style="{ left: `${c.x}px`, top: `${c.y}px` }"
      >
        {{ c.label }}
      </div>
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

type PhaseName = "idle" | "server-pulse" | "broadcasting" | "client-pulse" | "hold";

const EVENT_LABEL = "book.updated";
const ariaLabel = `Diagram: Kavo (the server) broadcasts a ${EVENT_LABEL} event to Client A, Client B, and Client C simultaneously over SSE.`;

const hubX = 160;
const hubY = 26;
const clients = [
  { x: 45, y: 150, label: "Client A" },
  { x: 160, y: 150, label: "Client B" },
  { x: 275, y: 150, label: "Client C" },
];

const PHASES: { name: PhaseName; duration: number }[] = [
  { name: "idle", duration: 900 },
  { name: "server-pulse", duration: 450 },
  { name: "broadcasting", duration: 650 },
  { name: "client-pulse", duration: 700 },
  { name: "hold", duration: 1200 },
];

const phaseIndex = ref(0);
const phase = computed<PhaseName>(() => PHASES[phaseIndex.value].name);

const reduceMotion = ref(false);
const isPlaying = ref(true);
let timer: ReturnType<typeof setTimeout> | undefined;

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
.flow-broadcast {
  max-width: 420px;
  margin: 0 auto 12px;
  text-align: center;
}

.flow-broadcast-label {
  margin-bottom: 8px;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--vp-c-brand-1);
}

.flow-canvas {
  position: relative;
  width: 320px;
  height: 170px;
  margin: 0 auto;
}

.flow-lines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/*
 * A decreasing stroke-dashoffset walks the dash pattern in the direction
 * the line was drawn (hub -> client), so this reads as data flowing
 * outward from the server. The offset per iteration (20) is a multiple of
 * the dasharray's repeat length (5 + 5 = 10), so each loop lands back on
 * an identical dash position and the animation seams invisibly. The line
 * is always flowing (a connection is always live) at a slow, dim,
 * ambient pace; the broadcasting/client-pulse phase just speeds it up
 * and brightens it into the active event color.
 */
.flow-line-svg {
  stroke: var(--vp-c-divider);
  stroke-width: 1.5;
  stroke-dasharray: 5 5;
  animation: flow-dash 2.4s linear infinite;
  transition: stroke 0.2s ease;
}

.flow-line-svg--flowing {
  stroke: var(--vp-c-brand-1);
  animation-duration: 0.4s;
}

@keyframes flow-dash {
  from {
    stroke-dashoffset: 20;
  }
  to {
    stroke-dashoffset: 0;
  }
}

.flow-hub {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 7px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  white-space: nowrap;
  transition:
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}

.flow-hub--pulse {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--vp-c-brand-1) 20%, transparent);
}

.flow-node-role {
  margin-left: 4px;
  font-weight: 500;
  color: var(--vp-c-text-3);
}

.flow-client {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  font-size: 11px;
  font-weight: 600;
  color: var(--vp-c-text-2);
  white-space: nowrap;
  transition:
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}

.flow-client--pulse {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-text-1);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--vp-c-brand-1) 20%, transparent);
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
  .flow-canvas {
    height: auto;
  }
}
</style>
