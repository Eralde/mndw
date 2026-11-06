<script setup lang="ts">
import {withBase} from 'vitepress';

import {UI_CATALOG} from '../../ui-catalog.js';
</script>

<template>
  <div class="ui-catalog">
    <a
      v-for="entry in UI_CATALOG"
      :key="entry.slug"
      class="ui-catalog__card"
      :href="withBase('/ui/' + entry.slug)"
    >
      <div class="ui-catalog__title">{{ entry.title }}</div>
      <p class="ui-catalog__summary">{{ entry.summary }}</p>
    </a>
  </div>
</template>

<style scoped>
.ui-catalog {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin: 24px 0;
}

.ui-catalog__card {
  display: block;
  min-width: 0;
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition:
    border-color 0.2s,
    background-color 0.2s;
}

.ui-catalog__card:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
}

.ui-catalog__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
}

.ui-catalog__summary {
  margin: 10px 0 0;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
}

@media (max-width: 639px) {
  .ui-catalog {
    grid-template-columns: 1fr;
  }
}
</style>
