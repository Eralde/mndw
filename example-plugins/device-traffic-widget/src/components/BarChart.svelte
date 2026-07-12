<script lang="ts">
import {onMount} from 'svelte';
import * as d3 from 'd3';
import type {HostBar, HostClient} from '../types.js';

interface Props {
  data: HostBar[];
  hosts: HostClient[];
  deviceTime: Date;
}

let {data, hosts, deviceTime}: Props = $props();

function formatSpeed(value: number): string {
  if (value === 0) { return '0 b/s'; }
  const abs = Math.abs(value);
  const units = ['b/s', 'Kb/s', 'Mb/s', 'Gb/s'];
  let unitIndex = 0;
  let v = abs;
  while (v >= 1000 && unitIndex < units.length - 1) {
    v /= 1000;
    unitIndex++;
  }
  return `${unitIndex === 0 ? v : v.toFixed(1)} ${units[unitIndex]}`;
}

function getSpeedUpperLimit(speed: number): number {
  const MIN = 5000;
  if (speed <= 0) { return MIN; }
  const pow = String(Math.floor(speed)).length - 1;
  const multiplier = Math.pow(10, pow);
  return Math.max(Math.ceil(speed / multiplier) * multiplier, MIN);
}

let containerEl: HTMLDivElement | undefined = $state();
let containerWidth = $state(400);
let containerHeight = $state(200);
let resizeObserver: ResizeObserver | undefined;

function drawChart() {
  if (!containerEl) { return; }
  const container = d3.select(containerEl);
  container.selectAll('svg, .no-data-msg').remove();

  const bar = data[0];
  if (!bar || !deviceTime) {
    container.append('p').attr('class', 'no-data-msg').text('No data')
      .style('text-align', 'center').style('color', 'var(--mndw-text-subtle)')
      .style(
        'padding',
        '20px',
      );
    return;
  }

  const attr = bar.bars.find(b => b.attribute === 'sumspeed');
  if (!attr || attr.data.length === 0) {
    container.append('p').attr('class', 'no-data-msg').text('No data')
      .style('text-align', 'center').style('color', 'var(--mndw-text-subtle)')
      .style(
        'padding',
        '20px',
      );
    return;
  }

  const points = [...attr.data].sort((a, b) => a.t - b.t);
  const isSmall = containerWidth < 300;
  const margin = isSmall
    ? {top: 15, right: 10, bottom: 25, left: 50}
    : {top: 20, right: 15, bottom: 30, left: 60};
  const innerWidth = Math.max(containerWidth - margin.left - margin.right, 50);
  const innerHeight = Math.max(
    containerHeight - margin.top - margin.bottom,
    50,
  );

  const svg = container.append('svg')
    .attr('width', containerWidth)
    .attr('height', containerHeight);

  const g = svg.append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  const maxVal = Math.max(...points.map(p => p.v), 1);
  const yUpperLimit = getSpeedUpperLimit(maxVal);
  const deviceTimeMs = deviceTime.getTime();
  const mostRecentT = points[points.length - 1].t;

  const xScale = d3.scaleBand()
    .domain(points.map((_, i) => String(i)))
    .range([0, innerWidth])
    .padding(0.15);

  const yScale = d3.scaleLinear()
    .domain([0, yUpperLimit])
    .range([innerHeight, 0]);

  const color = 'var(--mndw-accent)';

  // Grid
  g.append('g').attr('class', 'grid')
    .call(
      d3.axisLeft(yScale).ticks(3).tickSize(-innerWidth).tickFormat(() => ''),
    );
  g.select('.grid').select('.domain').remove();

  // Y axis
  const axisFontSize = isSmall ? 9 : 10;
  g.append('g')
    .call(d3.axisLeft(yScale).ticks(3).tickFormat(formatSpeed as any))
    .selectAll('text').attr('font-size', axisFontSize).style(
      'fill',
      'var(--mndw-text-subtle)',
    );
  g.selectAll('.domain').remove();

  // Bars
  for (let i = 0; i < points.length; i++) {
    const barX = xScale(String(i)) || 0;
    const barWidth = xScale.bandwidth();
    const value = points[i].v;
    g.append('rect')
      .attr('x', barX)
      .attr('y', yScale(value))
      .attr('width', barWidth)
      .attr('height', yScale(0) - yScale(value))
      .style('fill', color);
  }

  // X axis time labels
  const tickCount = Math.min(points.length, 5);
  const tickStep = Math.max(Math.ceil(points.length / tickCount), 1);
  const tickIndices: number[] = [];
  for (
    let i = 0;
    i < points.length && tickIndices.length < tickCount;
    i += tickStep
  ) {
    tickIndices.push(i);
  }
  if (
    tickIndices[tickIndices.length - 1] !== points.length - 1
    && points.length > 1
  ) {
    tickIndices[tickIndices.length - 1] = points.length - 1;
  }

  const xAxisGroup = g.append('g').attr(
    'transform',
    `translate(0,${innerHeight})`,
  );
  xAxisGroup.selectAll('text')
    .data(tickIndices).enter()
    .append('text')
    .attr('x', (d: number) => (xScale(String(d)) || 0) + xScale.bandwidth() / 2)
    .attr('dy', '1.2em')
    .style('text-anchor', 'middle')
    .attr('font-size', axisFontSize - 1)
    .style('fill', 'var(--mndw-text-subtle)')
    .text((d: number) => {
      const actualTime = new Date(
        deviceTimeMs - (mostRecentT - points[d].t) * 1000,
      );
      return d3.timeFormat('%H:%M:%S')(actualTime);
    });

  // Tooltip
  const tooltip = d3.select(containerEl).select('.chart-tooltip');
  const overlay = g.append('rect')
    .attr('width', innerWidth).attr('height', innerHeight)
    .attr('fill', 'transparent').style('cursor', 'crosshair');

  overlay.on('mousemove', (event: MouseEvent) => {
    const [mx] = d3.pointer(event, g.node()!);
    const idx = Math.min(
      Math.max(Math.floor((mx / innerWidth) * points.length), 0),
      points.length - 1,
    );
    const pt = points[idx];
    if (!pt) { return; }
    const actualTime = new Date(deviceTimeMs - (mostRecentT - pt.t) * 1000);
    tooltip.style('display', '').html(
      `<div>${d3.timeFormat('%H:%M:%S')(actualTime)}</div><div><strong>${
        formatSpeed(pt.v)
      }</strong></div>`,
    );
    const tnode = tooltip.node() as HTMLElement | null;
    if (tnode) {
      const tw = tnode.offsetWidth || 100;
      const th = tnode.offsetHeight || 50;
      let left = mx + margin.left + 8;
      let top = event.offsetY - th / 2;
      if (left + tw > containerWidth) { left = mx + margin.left - tw - 8; }
      if (top < 0) { top = 0; }
      if (top + th > containerHeight) { top = containerHeight - th; }
      tooltip.style('left', `${left}px`).style('top', `${top}px`);
    }
  });
  overlay.on('mouseleave', () => {
    tooltip.style('display', 'none');
  });

  // Average summary
  const txspeedAttr = bar.bars.find(b => b.attribute === 'txspeed');
  const rxspeedAttr = bar.bars.find(b => b.attribute === 'rxspeed');
  const avgTx = txspeedAttr?.data.length
    ? txspeedAttr.data.reduce((s, d) => s + d.v, 0) / txspeedAttr.data.length
    : 0;
  const avgRx = rxspeedAttr?.data.length
    ? rxspeedAttr.data.reduce((s, d) => s + d.v, 0) / rxspeedAttr.data.length
    : 0;
  svg.append('text')
    .attr('x', margin.left)
    .attr('y', containerHeight - 4)
    .attr('font-size', '10px')
    .style('fill', 'var(--mndw-text-subtle)')
    .text(`↓ ${formatSpeed(avgRx)}  ↑ ${formatSpeed(avgTx)}`);
}

$effect(() => {
  data;
  deviceTime;
  hosts;
  drawChart();
});
$effect(() => {
  containerWidth;
  containerHeight;
  drawChart();
});

onMount(() => {
  if (containerEl) {
    const rect = containerEl.getBoundingClientRect();
    containerWidth = rect.width;
    containerHeight = rect.height;
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        containerWidth = entry.contentRect.width;
        containerHeight = entry.contentRect.height;
      }
    });
    resizeObserver.observe(containerEl);
  }
  return () => {
    if (resizeObserver) { resizeObserver.disconnect(); }
  };
});
</script>

<div
  bind:this={containerEl}
  class="chart-container"
  style="width:100%;height:100%;position:relative"
>
  <div
    class="chart-tooltip"
    style="position:absolute;background:var(--mndw-surface-raised);color:var(--mndw-text);border:1px solid var(--mndw-border);padding:4px 8px;border-radius:4px;font-size:11px;pointer-events:none;display:none;z-index:100;white-space:nowrap"
  >
  </div>
</div>

<style>
.chart-container :global(.grid line) {
  stroke: var(--mndw-border);
  stroke-dasharray: 4, 4;
}
.chart-container :global(.grid .domain) {
  display: none;
}
</style>
