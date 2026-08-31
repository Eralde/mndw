<script setup lang="ts">
import {computed} from 'vue';
import type {Translator} from '@mndw/sdk';
import type {MndwChartSample} from '@mndw/ui';

const props = defineProps<{
  label: string;
  value: number;
  history: number[];
  translator: Translator;
}>();

const t = (key: string): string => props.translator.t(key);
const points = computed<MndwChartSample[]>(() => {
  return props.history.map((value) => ({value}));
});
</script>

<template>
  <div class="load-bar-chart">
    <div class="load-bar-chart__header">
      <span class="load-bar-chart__label">{{ label }}</span>
      <span class="load-bar-chart__value">{{ value }}%</span>
    </div>
    <mndw-sparkline
      class="load-bar-chart__chart"
      :points.prop="points"
      :value-label="label"
      :aria-label="label"
      :empty-label="t('no-data')"
    >
    </mndw-sparkline>
  </div>
</template>

<style scoped>
.load-bar-chart {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.load-bar-chart__header {
  display: flex;
  align-items: baseline;
  justify-content: flex-start;
  gap: 0.5rem;
}

.load-bar-chart__label {
  color: var(--mndw-text-subtle);
  font-weight: 600;
}

.load-bar-chart__value {
  color: var(--mndw-text);
  font-variant-numeric: tabular-nums;
}

.load-bar-chart__chart {
  display: block;
  width: 100%;
}

@container device-info-loads (max-width: 200px) {
  .load-bar-chart__chart {
    display: none;
  }
}
</style>
