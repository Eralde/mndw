<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref} from 'vue';
import type {PluginContext, ProjectedSeries, ProjectedSnapshot, ProjectRange} from '@mndw/sdk';
import {historyStatus} from '@mndw/sdk';
import {useTranslator} from '@mndw/sdk/vue';
import {createRefreshLoop, type RefreshLoop} from '@mndw/sdk/refresh';

const props = defineProps<{ctx: PluginContext}>();
const translator = useTranslator(props.ctx.i18n);
const t = (key: string): string => translator.t(key);

const RANGES: readonly {key: ProjectRange; label: string}[] = [
  {key: '1h', label: 'range-1h'},
  {key: '3h', label: 'range-3h'},
  {key: '1d', label: 'range-1d'},
  {key: '7d', label: 'range-7d'},
  {key: '30d', label: 'range-30d'},
];

const selectedRange = ref<ProjectRange>('1d');
const snapshot = ref<ProjectedSnapshot | null>(null);
const loadedRange = ref<ProjectRange | null>(null);
const loading = ref(true);
const error = ref(false);

let refreshLoop: RefreshLoop | null = null;
let abortController: AbortController | null = null;

const activeSnapshot = computed(() => loadedRange.value === selectedRange.value ? snapshot.value : null);
const temp = computed<ProjectedSeries | null>(() => activeSnapshot.value?.keys.temp ?? null);
const gatheringEnabled = computed(() => activeSnapshot.value?.gathering.enabled ?? true);
const hasData = computed(() => (temp.value?.segments.length ?? 0) > 0);
const sessionRequired = computed(() => {
  return (selectedRange.value === '7d' || selectedRange.value === '30d') && activeSnapshot.value != null && !activeSnapshot.value.sessionConfigured;
});

const timeDomain = computed(() => {
  const points = temp.value?.points;

  if (!points || points.length === 0) {
    return undefined;
  }

  const start = points[0]?.time;
  const end = points[points.length - 1]?.time;

  if (
    start === undefined || end === undefined
    || !Number.isFinite(start) || !Number.isFinite(end) || start >= end
  ) {
    return undefined;
  }

  return {start, end};
});

const valueFormatter = (value: number): string => `${value.toFixed(1)}°C`;

const DATED_RANGES: ReadonlySet<ProjectRange> = new Set(['1d', '7d', '30d']);

const pad = (value: number): string => String(value).padStart(2, '0');

// Day-scale ranges span midnight, so the tooltip and axis need the date as well as the time.
const timeFormatter = computed(() => {
  const dated = DATED_RANGES.has(selectedRange.value);

  return (epochMs: number): string => {
    const date = new Date(epochMs);
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

    return dated ? `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${time}` : `${time}:${pad(date.getSeconds())}`;
  };
});

const stopLoop = (): void => {
  refreshLoop?.stop();
  refreshLoop = null;
  abortController?.abort();
  abortController = null;
};

const startLoop = (range: ProjectRange): void => {
  stopLoop();
  loadedRange.value = null;
  loading.value = true;
  error.value = false;
  abortController = new AbortController();
  refreshLoop = createRefreshLoop({
    load: () => props.ctx.telemetry.fetchProjected(range, {signal: abortController?.signal}),
    intervalMs: 15 * 60_000,
    onSuccess: (result: ProjectedSnapshot) => {
      snapshot.value = result;
      loadedRange.value = range;
      loading.value = false;
      error.value = false;
    },
    onError: (err: unknown) => {
      console.error('[cpu-temp-widget] fetch failed', err);
      loading.value = false;
      error.value = true;
    },
  });
  refreshLoop.start();
};

// Shown beside the title so a chart of non-current history stays visible.
const historyStatusLabel = computed((): string | null => {
  const status = historyStatus(activeSnapshot.value?.clock);

  if (status === 'legacy' || status === 'current' || status === 'empty') {
    return null;
  }

  return t(status === 'catching-up' ? 'history-catching-up' : 'history-historical');
});

const setRange = (range: ProjectRange): void => {
  selectedRange.value = range;
  startLoop(range);
};

onMounted(() => {
  startLoop(selectedRange.value);
});

onUnmounted(() => {
  stopLoop();
});
</script>

<template>
  <div class="app">
    <header class="app__header">
      <span>{{ t('title') }}</span>
      <span v-if="historyStatusLabel !== null" class="app__history-status" data-testid="history-status">
        {{ historyStatusLabel }}
      </span>
      <span data-testid="l10n-probe" hidden>{{ translator.t('l10n.probe') }}</span>
    </header>
    <div class="range-controls" role="group">
      <button v-for="range in RANGES" :key="range.key" type="button"
              :class="{selected: selectedRange === range.key}"
              @click="setRange(range.key)">
        {{ t(range.label) }}
      </button>
    </div>
    <div v-if="sessionRequired" class="app__message">{{ t('session-required') }}</div>
    <div v-else-if="loading" class="app__message">{{ t('loading') }}</div>
    <div v-else-if="!gatheringEnabled" class="app__message">{{ t('disabled') }}</div>
    <div v-else-if="error && !activeSnapshot" class="mndw-alert mndw-alert--danger" role="alert">{{ t('error') }}</div>
    <div v-else-if="temp && !temp.supported" class="app__message">{{ t('unsupported') }}</div>
    <template v-else-if="temp">
      <div class="chart-wrapper">
        <span v-if="!hasData" class="app__message">{{ t('empty') }}</span>
        <mndw-line-chart
          :series.prop="[{id: 'mean', label: t('title'), data: temp.points, segments: temp.segments, color: 'accent'}]"
          :bands.prop="temp.bands"
          :domain.prop="timeDomain"
          :valueDomain.prop="temp.valueDomain"
          :value-label="t('title')"
          :valueFormatter.prop="valueFormatter"
          :timeFormatter.prop="timeFormatter"
          :empty-label="t('empty')"
          :aria-label="t('title')"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding: 1rem;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: 0.8125rem;
}

.app__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
  color: var(--mndw-text-subtle);
  font-weight: 600;
}

.app__history-status {
  font-weight: 400;
}

.app__message {
  color: var(--mndw-text-subtle);
}

.range-controls {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.range-controls button {
  border: 1px solid var(--mndw-border);
  border-radius: 0.25rem;
  padding: 0.25rem 0.5rem;
  color: var(--mndw-text-subtle);
  background: transparent;
  cursor: pointer;
}

.range-controls button.selected {
  color: var(--mndw-text);
  background: var(--mndw-surface-raised);
}

.chart-wrapper {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

mndw-line-chart {
  display: block;
  width: 100%;
}
</style>
