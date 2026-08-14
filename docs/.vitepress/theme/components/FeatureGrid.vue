<template>
  <div class="feature-section">
    <p class="feature-title">Everything a CRUD API needs</p>
    <p class="feature-subtitle">
      One decorator, the full surface, configurable at global, entity, operation, and per-call scope.
    </p>
    <div class="feature-grid">
      <div v-for="feature in features" :key="feature.index" class="feature-item">
        <span class="feature-index">{{ feature.index }}</span>
        <span class="feature-name">{{ feature.name }}</span>
        <span class="feature-desc">{{ feature.desc }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const features = [
  {
    index: "01",
    name: "Filtering",
    desc: "A full operator grammar (eq, gt, in, isNull, and more) parsed straight from the query string.",
  },
  {
    index: "02",
    name: "Sorting & pagination",
    desc: "Multi-field sort and limit/offset paging with consistent envelope fields on every list route.",
  },
  {
    index: "03",
    name: "Nested includes",
    desc: "Pull related entities into the response with field-path recursion, capped for safety.",
  },
  {
    index: "04",
    name: "Field selection",
    desc: "Ask for exactly the fields you need and leave the rest off the wire.",
  },
  {
    index: "05",
    name: "Per-operation DTOs",
    desc: "Optional create, update, patch, query, item, and list shapes, derived or hand-written.",
  },
  {
    index: "06",
    name: "And more",
    desc: "Soft delete, transactions, problem-details errors, GraphQL binding, and the rest of the surface.",
  },
];
</script>

<style scoped>
.feature-section {
  margin: 64px 0;
  text-align: center;
}

.feature-title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}

.feature-subtitle {
  margin: 0 0 28px;
  font-size: 14.5px;
  color: var(--vp-c-text-2);
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  max-width: 900px;
  margin: 0 auto;
  text-align: left;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-divider);
}

@media (max-width: 768px) {
  .feature-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 480px) {
  .feature-grid {
    grid-template-columns: 1fr;
  }
}

.feature-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 22px 20px;
  background: var(--vp-c-bg-soft);
}

.feature-index {
  font-family: var(--vp-font-family-mono);
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  color: var(--vp-c-brand-1);
  opacity: 0.5;
  margin-bottom: 4px;
}

.feature-name {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.feature-desc {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--vp-c-text-2);
}
</style>
