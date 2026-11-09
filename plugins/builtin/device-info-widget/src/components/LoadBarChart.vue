<script setup lang="ts">
import {computed} from 'vue';
import type {Translator} from '@mndw/sdk';
import type {MndwChartDomain, MndwChartSample} from '@mndw/ui';
import {formatTelemetryTime} from '../services/telemetry.js';

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
  return formatTelemetryTime(props.translator, time, props.timeDomain);
};
</script>

<template>
  <div class="load-bar-chart">
    <div class="load-bar-chart__header">
      <span class="load-bar-chart__label">{{ label }}</span>
      <span class="load-bar-chart__value">{{ value }}%</span>
    </div>
    <span v-if="loading === true" class="load-bar-chart__sr-only" data-testid="history-loading" role="status">
        {{ t('loading') }}
    </span>
    <div class="load-bar-chart__chart" :aria-busy="loading === true">
      <mndw-sparkline
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
  height: 2.5rem;
  min-height: 2.5rem;
  box-sizing: border-box;
  flex: none;
}

.load-bar-chart__chart[aria-busy='true'] :deep(mndw-sparkline) {
  opacity: 0.55;
}

.load-bar-chart__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@container device-info-loads (max-width: 200px) {
  .load-bar-chart__chart {
    display: none;
  }
}
</style>
