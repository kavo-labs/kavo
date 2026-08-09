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
