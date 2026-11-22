<script lang="ts">
import {formatBitRate, gaugeAngle, gaugeTop} from '../model/format.js';

interface Props {
  speed: number;
  phaseLabel: string;
  phase: 'ping' | 'download' | 'upload' | null;
  locale: string;
  running: boolean;
}

let {speed, phaseLabel, phase, locale, running}: Props = $props();
const top = $derived(gaugeTop(speed));
const angle = $derived(gaugeAngle(speed, top));
const progress = $derived((angle / 180) * 100);
const formattedSpeed = $derived(formatBitRate(speed, locale));
const ticks = [0, 5, 10, 50, 100, 250, 500, 750, 1000, 2500, 10000];
const TICK_START_RADIUS = 81;
const TICK_END_RADIUS = 78;
const TICK_LABEL_RADIUS = 62;

function pointAtAngle(angle: number, radius: number): {x: number; y: number} {
  const radians = (angle * Math.PI) / 180;

  return {
    x: 100 - radius * Math.cos(radians),
    y: 105 - radius * Math.sin(radians),
  };
}

function point(value: number, radius: number): {x: number; y: number} {
  return pointAtAngle(gaugeAngle(value * 1e6, top), radius);
}
</script>

<div
  class="gauge-wrap"
  style="position: absolute; inset: 0; container-type: size"
>
  <div
    class="arc-box"
    style="position: absolute; inset-block-end: 0; inset-inline-start: 50%; translate: -50% 0; inline-size: min(100cqw, calc(100cqh * 200 / 126)); aspect-ratio: 200 / 126"
  >
    <svg
      class="gauge"
      data-testid="gauge"
      data-speed-bps={speed}
      viewBox="0 0 200 126"
      preserveAspectRatio="xMidYMax meet"
      style="display: block; block-size: 100%; inline-size: 100%"
      role="img"
      aria-hidden={!running}
      aria-label={`${phaseLabel}: ${formattedSpeed}`}
    >
      <path
        class="track"
        d="M 16 105 A 84 84 0 0 1 184 105"
        stroke-width="6"
      />
      <path
        class="fill"
        class:upload={phase === 'upload'}
        class:download={phase !== 'upload'}
        data-testid="gauge-fill"
        data-color={phase === 'upload' ? 'success' : 'accent'}
        d="M 16 105 A 84 84 0 0 1 184 105"
        stroke-width="6"
        stroke-linecap={speed > 0 ? 'round' : 'butt'}
        pathLength="100"
        stroke-dasharray={`${progress} 100`}
      />
      {#each ticks.filter((tick) => tick <= top) as tick (tick)}
        {@const tickPoint = point(tick, TICK_START_RADIUS)}
        {@const innerPoint = point(tick, TICK_END_RADIUS)}
        {@const labelPoint = point(tick, TICK_LABEL_RADIUS)}
        <line
          class="tick"
          x1={tickPoint.x}
          y1={tickPoint.y}
          x2={innerPoint.x}
          y2={innerPoint.y}
        />
        <text
          class="tick-label"
          style="font-size: var(--mndw-text-xs)"
          x={labelPoint.x}
          y={labelPoint.y}
          text-anchor="middle"
        >
          {tick >= 1000 ? `${tick / 1000}G` : tick}
        </text>
      {/each}
    </svg>
    {#if running}
      <div
        class="gauge-copy"
        style="position: absolute; inset-block-end: 18%; inset-inline: 0"
        aria-hidden="true"
      >
        <span
          class="speed"
          style="font-size: clamp(var(--mndw-text-sm), 9cqmin, var(--mndw-text-xl, var(--mndw-text-lg)))"
        >{formattedSpeed}</span>
        <span
          class="phase"
          style="font-size: var(--mndw-text-xs)"
        >{phaseLabel}</span>
      </div>
    {/if}
  </div>
</div>

<style>
.gauge {
  overflow: visible;
}

.track {
  fill: none;
  stroke: var(--mndw-border);
}

.tick {
  stroke: var(--mndw-text-muted);
  stroke-width: 1;
}

.tick-label {
  fill: var(--mndw-text-muted);
}

.fill {
  fill: none;
  transition: stroke-dasharray 300ms ease;
}

.fill.download {
  stroke: var(--mndw-accent);
}

.fill.upload {
  stroke: var(--mndw-success);
}

.gauge-copy {
  position: absolute;
  inset-block-end: 18%;
  inset-inline: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  pointer-events: none;
}

.speed,
.phase {
  display: block;
  line-height: 1.15;
  white-space: nowrap;
}

.speed {
  color: var(--mndw-text);
  font-weight: 700;
}

.phase {
  color: var(--mndw-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .fill {
    transition: none;
  }
}
</style>
