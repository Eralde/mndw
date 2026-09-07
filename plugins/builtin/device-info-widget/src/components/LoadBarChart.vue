<script setup lang="ts">
import {computed} from 'vue';
import type {Translator} from '@mndw/sdk';
import type {MndwChartDomain, MndwChartSample} from '@mndw/ui';

const props = defineProps<{
  label: string;
  value: number;
  history: readonly MndwChartSample[];
  timeDomain?: MndwChartDomain;
  loading?: boolean;
  translator: Translator;
}>();

const t = (key: string): string => props.translator.t(key);

const points = computed<MndwChartSample[]>(() => {
  return [...props.history];
});

const timeFormatter = (time: number): string => {
  const span = props.timeDomain === undefined ? 0 : props.timeDomain.end - props.timeDomain.start;
  const options: Intl.DateTimeFormatOptions = span >= 24 * 60 * 60 * 1000
    ? {month: 'short', day: 'numeric'}
    : {hour: '2-digit', minute: '2-digit', second: '2-digit'};

  return props.translator.formatDate(new Date(time), options);
};
</script>

<template>
  <div class="load-bar-chart">
    <div class="load-bar-chart__header">
      <span class="load-bar-chart__label">{{ label }}</span>
      <span class="load-bar-chart__value">{{ value }}%</span>
    </div>
    <div class="load-bar-chart__chart" :aria-busy="loading === true">
      <span v-if="loading === true" class="load-bar-chart__loading" data-testid="history-loading" role="status">
        {{ t('loading') }}
      </span>
      <mndw-sparkline
        v-else
        :points.prop="points"
        :timeDomain.prop="timeDomain"
        :timeFormatter.prop="timeFormatter"
        :value-label="label"
        :aria-label="label"
        :empty-label="t('no-data')"
      >
      </mndw-sparkline>
    </div>
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
  min-height: 1.5rem;
}

.load-bar-chart__loading {
  display: block;
  color: var(--mndw-text-subtle);
}

@container device-info-loads (max-width: 200px) {
  .load-bar-chart__chart {
    display: none;
  }
}
</style>
