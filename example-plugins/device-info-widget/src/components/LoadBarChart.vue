<script setup lang="ts">
import * as d3 from 'd3';
import {onMounted, onUnmounted, ref, watch} from 'vue';

import {prepareChartHistory} from './load-bar-chart-data.js';

const props = defineProps<{label: string; value: number; history: number[]}>();

const containerRef = ref<HTMLDivElement | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);
const tooltipRef = ref<HTMLDivElement | null>(null);

const CHART_HEIGHT = 88;
const MARGIN = {top: 6, right: 4, bottom: 18, left: 28};

let resizeObserver: ResizeObserver | null = null;

const hideTooltip = (): void => {
  if (tooltipRef.value !== null) {
    tooltipRef.value.style.display = 'none';
  }
};

const showTooltip = (event: MouseEvent, value: number): void => {
  if (tooltipRef.value === null || containerRef.value === null) {
    return;
  }

  const bounds = containerRef.value.getBoundingClientRect();
  tooltipRef.value.textContent = `${value}%`;
  tooltipRef.value.style.display = 'block';
  tooltipRef.value.style.left = `${event.clientX - bounds.left + 6}px`;
  tooltipRef.value.style.top = `${event.clientY - bounds.top - 28}px`;
};

const drawChart = (): void => {
  if (svgRef.value === null || containerRef.value === null) {
    return;
  }

  const history = prepareChartHistory(props.history);
  const width = Math.max(180, containerRef.value.clientWidth);
  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const svg = d3.select<SVGSVGElement, undefined>(svgRef.value);

  svg
      .attr('viewBox', `0 0 ${width} ${CHART_HEIGHT}`)
      .attr('aria-label', `${props.label} history`)
      .selectAll('*')
      .remove();

  hideTooltip();

  if (history.length === 0) {
    return;
  }

  const chart = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);
  const x = d3.scaleBand<string>()
      .domain(history.map((_, index) => String(index)))
      .range([0, innerWidth])
      .padding(0.15);
  const y = d3.scaleLinear().domain([0, 100]).range([innerHeight, 0]);

  chart.append('g')
      .attr('class', 'load-bar-chart__grid')
      .call(d3.axisLeft(y).ticks(2).tickSize(-innerWidth).tickFormat((tick) => `${tick}%`));

  chart.selectAll<SVGRectElement, number>('rect')
      .data(history)
      .join('rect')
      .attr('class', 'load-bar-chart__bar')
      .attr('x', (_, index) => x(String(index)) ?? 0)
      .attr('y', (value) => y(value))
      .attr('width', x.bandwidth())
      .attr('height', (value) => innerHeight - y(value))
      .on('pointerenter', (event: MouseEvent, value: number) => showTooltip(event, value))
      .on('pointermove', (event: MouseEvent, value: number) => showTooltip(event, value))
      .on('pointerleave', hideTooltip);

  chart.append('g')
      .attr('class', 'load-bar-chart__axis')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x).tickValues([]).tickSize(0));
};

watch([() => props.history, () => props.value], drawChart, {deep: true, flush: 'post'});

onMounted(() => {
  drawChart();
  resizeObserver = new ResizeObserver(drawChart);

  if (containerRef.value !== null) {
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <section ref="containerRef" class="load-bar-chart">
    <div class="load-bar-chart__header">
      <span class="load-bar-chart__label">{{ label }}</span>
      <span class="load-bar-chart__value">{{ value }}%</span>
    </div>
    <div class="load-bar-chart__body">
      <svg v-if="history.length > 0" ref="svgRef" class="load-bar-chart__svg"/>
      <span v-else class="load-bar-chart__empty">No historical data</span>
      <div ref="tooltipRef" class="load-bar-chart__tooltip"/>
    </div>
  </section>
</template>

<style scoped>
.load-bar-chart {
  position: relative;
  min-width: 0;
}

.load-bar-chart__header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 2px;
}

.load-bar-chart__label {
  color: var(--mndw-text-subtle);
  font-weight: 600;
}

.load-bar-chart__value {
  color: var(--mndw-text);
  font-variant-numeric: tabular-nums;
}

.load-bar-chart__body {
  position: relative;
  min-height: 88px;
}

.load-bar-chart__svg {
  display: block;
  width: 100%;
  height: 88px;
  overflow: visible;
}

.load-bar-chart__empty {
  display: block;
  padding: 32px 0;
  color: var(--mndw-text-subtle);
  font-size: 12px;
}

.load-bar-chart__tooltip {
  position: absolute;
  display: none;
  padding: 2px 5px;
  border: 1px solid var(--mndw-border);
  border-radius: 3px;
  background: var(--mndw-surface);
  color: var(--mndw-text);
  font-size: 11px;
  pointer-events: none;
  white-space: nowrap;
}

:deep(.load-bar-chart__grid line) {
  stroke: var(--mndw-border);
  stroke-dasharray: 2 2;
  opacity: 0.7;
}

:deep(.load-bar-chart__grid path),
:deep(.load-bar-chart__axis path),
:deep(.load-bar-chart__axis line) {
  stroke: var(--mndw-border);
}

:deep(.load-bar-chart__grid text),
:deep(.load-bar-chart__axis text) {
  fill: var(--mndw-text-subtle);
  font-size: 9px;
}

:deep(.load-bar-chart__bar) {
  fill: var(--mndw-accent);
}
</style>
