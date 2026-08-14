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
