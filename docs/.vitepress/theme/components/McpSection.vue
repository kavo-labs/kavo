<template>
  <div class="mcp-section">
    <p class="mcp-title">Expose your API to agents with MCP</p>
    <p class="mcp-subtitle">
      The same engine behind REST and GraphQL exposes every entity as an MCP toolset, with no second registry and no
      hand-written schemas.
    </p>

    <McpChatDemo />

    <p class="mcp-note">
      Every standard operation, for every <code>@Kavo</code> entity, unconditionally: an agent gets the same filtering,
      pagination, and soft-delete semantics a REST or GraphQL client does, because it calls the same engine.
    </p>
  </div>
</template>

<script setup lang="ts">
import McpChatDemo from "./McpChatDemo.vue";
</script>

<style scoped>
.mcp-section {
  margin: 64px 0;
  text-align: center;
}

.mcp-title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}

.mcp-subtitle {
  margin: 0 0 28px;
  font-size: 14.5px;
  color: var(--vp-c-text-2);
}

.mcp-note {
  max-width: 640px;
  margin: 24px auto 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-3);
}

.mcp-note code {
  font-size: 12px;
}
</style>
