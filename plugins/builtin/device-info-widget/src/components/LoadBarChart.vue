<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref} from 'vue';
import type {Translator} from '@mndw/sdk';

import {barIndexAt, computeChartBars, prepareChartHistory} from './load-bar-chart-data.js';

const props = withDefaults(defineProps<{
  label: string;
  value: number;
  history: number[];
  translator: Translator;
}>(), {
});

const CHART_HEIGHT = 28;
const BAR_GAP = 1;

const chartRef = ref<HTMLDivElement | null>(null);
const chartWidth = ref(0);
const hoverIndex = ref<number | null>(null);

let resizeObserver: ResizeObserver | null = null;

const history = computed(() => prepareChartHistory(props.history));

const bars = computed(() =>
    computeChartBars(history.value, chartWidth.value, CHART_HEIGHT, BAR_GAP));

const tooltip = computed(() => {
  if (hoverIndex.value === null) {
    return null;
  }

  const bar = bars.value[hoverIndex.value];

  if (bar === undefined) {
    return null;
  }

  return {value: bar.value, left: bar.left + bar.width / 2};
});

const handlePointerMove = (event: PointerEvent): void => {
  if (chartRef.value === null) {
    return;
  }

  const bounds = chartRef.value.getBoundingClientRect();

  hoverIndex.value = barIndexAt(event.clientX - bounds.left, bounds.width, history.value.length);
};

const handlePointerLeave = (): void => {
  hoverIndex.value = null;
};

const updateWidth = (): void => {
  if (chartRef.value !== null) {
    chartWidth.value = chartRef.value.clientWidth;
  }
};

onMounted(() => {
  updateWidth();
  resizeObserver = new ResizeObserver(updateWidth);

  if (chartRef.value !== null) {
    resizeObserver.observe(chartRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <div class="load-bar-chart">
    <div class="load-bar-chart__header">
      <span class="load-bar-chart__label">{{ label }}</span>
      <span class="load-bar-chart__value">{{ value }}%</span>
    </div>
    <div
      ref="chartRef"
      class="load-bar-chart__chart"
      @pointermove="handlePointerMove"
      @pointerleave="handlePointerLeave"
    >
      <svg
        v-if="bars.length > 0"
        class="load-bar-chart__svg"
        :viewBox="`0 0 ${chartWidth} ${CHART_HEIGHT}`"
        preserveAspectRatio="none"
        :aria-label="`${label} ${props.translator.t('history')}`"
      >
        <rect
          v-for="(bar, index) in bars"
          :key="index"
          class="load-bar-chart__bar"
          :class="{'load-bar-chart__bar--active': index === hoverIndex}"
          :x="bar.left"
          :y="bar.top"
          :width="bar.width"
          :height="bar.height"
        />
        <line
          class="load-bar-chart__ceiling"
          x1="0"
          :x2="chartWidth"
          y1="0.5"
          y2="0.5"
        />
        <line
          class="load-bar-chart__baseline"
          x1="0"
          :x2="chartWidth"
          :y1="CHART_HEIGHT - 0.5"
          :y2="CHART_HEIGHT - 0.5"
        />
      </svg>
      <span v-else class="load-bar-chart__empty">{{ props.translator.t('no-data') }}</span>
      <div v-if="tooltip !== null" class="load-bar-chart__tooltip" :style="{left: `${tooltip.left}px`}">
        {{ tooltip.value }}%
      </div>
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
  position: relative;
  width: 100%;
  height: 1.75rem;
}

.load-bar-chart__svg {
  display: block;
  width: 100%;
  height: 100%;
}

.load-bar-chart__empty {
  display: block;
  color: var(--mndw-text-subtle);
  font-size: 0.6875rem;
  line-height: 1.75rem;
}

.load-bar-chart__bar {
  fill: var(--mndw-accent);
}

.load-bar-chart__bar--active {
  fill: var(--mndw-text);
}

.load-bar-chart__ceiling,
.load-bar-chart__baseline {
  stroke: var(--mndw-border);
  stroke-width: 1;
  stroke-dasharray: 2 2;
  vector-effect: non-scaling-stroke;
}

.load-bar-chart__tooltip {
  position: absolute;
  bottom: calc(100% + 0.125rem);
  transform: translateX(-50%);
  padding: 0.0625rem 0.3125rem;
  border: 1px solid var(--mndw-border);
  border-radius: 0.1875rem;
  background: var(--mndw-surface);
  color: var(--mndw-text);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}

@container device-info-loads (max-width: 200px) {
  .load-bar-chart__chart {
    display: none;
  }
}
</style>
