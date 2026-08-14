<template>
  <div class="layer-section">
    <p class="layer-title">Not a replacement for your ORM</p>
    <p class="layer-subtitle">Kavo doesn't own your data model. It sits on top of the entity you already defined.</p>
    <div class="equation-frame">
      <div class="equation">
        <div class="eq-card">
          <span class="eq-label">Your ORM</span>
          <span class="eq-desc">Entity, migrations, and relations, unchanged.</span>
        </div>
        <span class="eq-op">+</span>
        <div class="eq-card eq-card--kavo">
          <span class="eq-label eq-label--kavo">Kavo</span>
          <span class="eq-desc">Reads the entity's metadata, generates the CRUD surface.</span>
        </div>
        <span class="eq-op eq-op--equals">=</span>
        <div class="eq-card">
          <span class="eq-label">REST + GraphQL API</span>
          <span class="eq-desc">Filtering, sorting, pagination, includes, DTOs, errors.</span>
        </div>
      </div>
    </div>
    <p class="layer-note">
      Swap ORMs later and the API surface doesn't move. <code>RepositoryAdapter</code> is the only seam that changes.
    </p>
  </div>
</template>

<style scoped>
.layer-section {
  margin: 72px 0;
  text-align: center;
}

.layer-title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}

.layer-subtitle {
  margin: 0 0 36px;
  font-size: 14.5px;
  color: var(--vp-c-text-2);
}

.equation-frame {
  max-width: 940px;
  margin: 0 auto;
  padding: 28px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 20px;
  background: linear-gradient(180deg, var(--vp-c-bg-soft) 0%, var(--vp-c-bg) 100%);
  box-shadow: 0 8px 24px -18px rgba(0, 0, 0, 0.3);
}

.equation {
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 16px;
  max-width: 900px;
  margin: 0 auto;
}

@media (max-width: 860px) {
  .equation {
    flex-direction: column;
    align-items: stretch;
    max-width: 380px;
  }
}

.eq-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 18px 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
  text-align: left;
}

.eq-card--kavo {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}

.eq-label {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.eq-label--kavo {
  font-family: var(--vp-font-family-base);
  font-size: 15px;
  font-weight: 700;
  background: var(--vp-home-hero-name-background);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.eq-desc {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.eq-op {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--vp-c-text-3);
}

@media (max-width: 860px) {
  .eq-op {
    padding: 2px 0;
  }
}

.layer-note {
  margin: 32px 0 0;
  font-size: 13px;
  color: var(--vp-c-text-3);
}

.layer-note code {
  font-size: 12px;
}
</style>
