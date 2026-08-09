<template>
  <RealtimeFlowDemo />
  <p class="realtime-categories-caption">Where teams put it to work</p>
  <div class="realtime-categories">
    <div v-for="category in categories" :key="category.title" class="realtime-category">
      <span class="realtime-category-title">{{ category.title }}</span>
      <div class="realtime-features">
        <span v-for="feature in category.features" :key="feature" class="realtime-feature">{{ feature }}</span>
      </div>
    </div>
  </div>
</template>

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

<style scoped>
.realtime-categories-caption {
  margin: 28px 0 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--vp-c-text-2);
  text-align: center;
}

.realtime-categories {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  max-width: 820px;
  margin: 32px auto 0;
  text-align: left;
}

@media (max-width: 719px) {
  .realtime-categories {
    grid-template-columns: 1fr;
  }
}

.realtime-category {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}

.realtime-category-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--vp-c-text-1);
}

.realtime-features {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.realtime-feature {
  padding: 4px 9px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg);
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--vp-c-text-2);
}
</style>
