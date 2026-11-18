<script setup lang="ts">
import {computed, onMounted, onUnmounted, provide, ref} from 'vue';
import {historyStatus} from '@mndw/sdk';
import {bindLocale} from '@mndw/sdk/bind-locale';
import type {LoadState, PluginContext, ProjectedSeries, ProjectedSnapshot, RefreshLoop} from '@mndw/sdk';
import {useTranslator} from '@mndw/sdk/vue';
import CopyField from './components/CopyField.vue';
import LoadBarChart from './components/LoadBarChart.vue';
import TelemetryNote from './components/TelemetryNote.vue';
import {
  type DeviceInfoRange,
  type LiveDeviceInfo,
  deviceInfoDetail,
  fetchDeviceHistory,
  fetchDeviceInfo,
  formatUptime,
} from './services/device-info.js';
import {createUptimeBaseline, getUptimeSeconds, type UptimeBaseline} from './services/uptime.js';
import {
  formatTelemetryTime,
  sparklineSamplesFromProjection,
  sparklineTimeDomainFromProjection,
  type DurableRange,
} from './services/telemetry.js';
import {openSettingsDialog} from './services/open-settings-dialog.js';

const props = defineProps<{ctx: PluginContext}>();
provide('mndw:plugin-i18n', props.ctx.i18n);

const translator = useTranslator(props.ctx.i18n);
const t = (key: string, values?: Record<string, unknown>): string => translator.t(key, values);
const unsubscribeLocale = bindLocale(props.ctx.i18n, () => {
  if (props.ctx.kind === 'widget') {
    props.ctx.setTileTitle?.(t('title'));
  }
});

const loadState = ref<LoadState<LiveDeviceInfo>>({status: 'loading'});
const liveHistoryLoading = ref(false);
const uptimeSeconds = ref<number | null>(null);
const lastSuccessAt = ref<number | null>(null);
const projectedLastSuccessAt = ref<number | null>(null);
const refreshAttemptAt = ref(Date.now());
const refreshFailed = ref(false);
const projectedRefreshFailed = ref(false);
const requestInFlight = ref(false);
const projectedRequestInFlight = ref(false);
const projectedSnapshot = ref<ProjectedSnapshot | null>(null);
const projectedLoadedRange = ref<DurableRange | null>(null);
const gatheringOverride = ref<boolean | undefined>(undefined);

type DisplayRange = DeviceInfoRange | DurableRange;

const DISPLAY_RANGES: readonly {key: DisplayRange; label: string}[] = [
  {key: '3m', label: 'range-3m'},
  {key: '1h', label: 'range-1h'},
  {key: '3h', label: 'range-3h'},
  {key: '1d', label: 'range-1d'},
  {key: '7d', label: 'range-7d'},
  {key: '30d', label: 'range-30d'},
];

const selectedRange = ref<DisplayRange>('3m');
const selectedLiveRange = ref<DeviceInfoRange>('3m');
const sectionVisibility = ref<Record<string, boolean>>({
  cpu: true,
  ram: true,
  identity: true,
});

const SECTION_STORAGE_KEYS = {
  cpu: 'section-visibility:cpu',
  ram: 'section-visibility:ram',
  identity: 'section-visibility:identity',
} as const;
const dirtySections = new Set<string>();

let baseline: UptimeBaseline | null = null;
let ticker: ReturnType<PluginContext['timers']['createTicker']> | null = null;
let tickerSubscription: {unsubscribe(): void} | null = null;
let refreshLoop: RefreshLoop | null = null;
let projectedRefreshLoop: RefreshLoop | null = null;
let gatheringSubscription: {unsubscribe(): void} | null = null;
let pendingProjectedRange: DurableRange | null = null;
let projectedLoopGeneration = 0;
let liveHistoryGeneration = 0;
let mounted = false;

interface LiveInfoRefresh {
  range: DeviceInfoRange;
  info: LiveDeviceInfo;
}

const firmware = computed(() => props.ctx.device.info.firmwareVersion);
const info = computed<LiveDeviceInfo | null>(() => {
  return loadState.value.status === 'success' ? loadState.value.data : null;
});

const isDurableRange = computed(() => selectedRange.value === '7d' || selectedRange.value === '30d');
const durableRange = computed<DurableRange>(() => selectedRange.value === '30d' ? '30d' : '7d');
const activeProjection = computed<ProjectedSnapshot | null>(() => {
  return isDurableRange.value && projectedLoadedRange.value === durableRange.value
      ? projectedSnapshot.value
      : null;
});
const liveStale = computed(() => refreshFailed.value && lastSuccessAt.value !== null);
const projectedStale = computed(() => {
  return isDurableRange.value && projectedRefreshFailed.value && activeProjection.value !== null;
});
const stale = computed(() => liveStale.value || projectedStale.value);
const retryInFlight = computed(() => {
  return (liveStale.value && requestInFlight.value) || (projectedStale.value && projectedRequestInFlight.value);
});
const lastStaleSuccessAt = computed(() => {
  const staleTimes = [
    liveStale.value ? lastSuccessAt.value : null,
    projectedStale.value ? projectedLastSuccessAt.value : null,
  ].filter((time): time is number => time !== null);

  return staleTimes.length === 0 ? null : Math.min(...staleTimes);
});
const lastSuccessTime = computed(() => {
  const updatedAt = lastStaleSuccessAt.value;

  if (updatedAt === null) {
    return '';
  }

  const date = new Date(updatedAt);
  const now = new Date(refreshAttemptAt.value);
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const timeOptions: Intl.DateTimeFormatOptions = {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'};

  return translator.formatDate(date, isToday
    ? timeOptions
    : {...timeOptions, year: 'numeric', month: 'short', day: 'numeric'});
});
const projectedCpu = computed<ProjectedSeries | null>(() => activeProjection.value?.keys.cpu ?? null);
const projectedRam = computed<ProjectedSeries | null>(() => activeProjection.value?.keys.ram ?? null);
const gatheringEnabled = computed(() => gatheringOverride.value ?? activeProjection.value?.gathering.enabled ?? null);
// Unknown session state counts as configured, so a failed projection request falls back to the gathering stream.
const sessionConfigured = computed(() => activeProjection.value?.sessionConfigured ?? true);
const telemetryNoteVisible = computed(() => {
  return isDurableRange.value && (!sessionConfigured.value || gatheringEnabled.value === false);
});
const lastProjectedPoint = computed((): {time: number; series: ProjectedSeries} | null => {
  let latest: {time: number; series: ProjectedSeries} | null = null;

  for (const series of [projectedCpu.value, projectedRam.value]) {
    if (series === null) {
      continue;
    }

    for (const point of series.points) {
      if (!Number.isFinite(point.time) || !Number.isFinite(point.value)) {
        continue;
      }

      if (latest === null || point.time > latest.time) {
        latest = {time: point.time, series};
      }
    }
  }

  return latest;
});
const lastPointTime = computed(() => {
  const point = lastProjectedPoint.value;

  return point === null
    ? null
    : formatTelemetryTime(translator, point.time, sparklineTimeDomainFromProjection(point.series));
});
const cpuLoadTimeDomain = computed(() => {
  return projectedCpu.value === null ? undefined : sparklineTimeDomainFromProjection(projectedCpu.value);
});
const ramLoadTimeDomain = computed(() => {
  return projectedRam.value === null ? undefined : sparklineTimeDomainFromProjection(projectedRam.value);
});
const cpuLoadHistory = computed(() => {
  return !isDurableRange.value
      ? cpuHistory.value.map((value) => ({value}))
      : projectedCpu.value !== null ? sparklineSamplesFromProjection(projectedCpu.value) : [];
});
const ramLoadHistory = computed(() => {
  return !isDurableRange.value
      ? ramHistory.value.map((value) => ({value}))
      : projectedRam.value !== null ? sparklineSamplesFromProjection(projectedRam.value) : [];
});
const cpuHistory = computed(() => {
  const currentInfo = info.value;

  return currentInfo === null || isDurableRange.value
      ? []
      : currentInfo.cpuHistory;
});
const ramHistory = computed(() => {
  const currentInfo = info.value;

  return currentInfo === null || isDurableRange.value
      ? []
      : currentInfo.ramHistory;
});

const uptime = computed(() => {
  return uptimeSeconds.value !== null
      ? liveStale.value
        ? t('uptime.estimated', {uptime: formatUptime(uptimeSeconds.value)})
        : formatUptime(uptimeSeconds.value)
      : t('unknown');
});

const handleInfoSuccess = ({range, info: nextInfo}: LiveInfoRefresh): void => {
  requestInFlight.value = false;
  if (selectedLiveRange.value !== range) {
    return;
  }

  const syncedAtMs = Date.now();

  refreshAttemptAt.value = syncedAtMs;
  lastSuccessAt.value = syncedAtMs;
  refreshFailed.value = false;
  loadState.value = {status: 'success', data: nextInfo};
  baseline = createUptimeBaseline(nextInfo.uptimeSeconds, syncedAtMs);
  uptimeSeconds.value = getUptimeSeconds(baseline, syncedAtMs);
};

const handleLoadError = (loadError: unknown, isInitial: boolean): void => {
  console.error('[device-info-widget] device info refresh failed', loadError);
  refreshAttemptAt.value = Date.now();
  requestInFlight.value = false;

  if (lastSuccessAt.value !== null) {
    refreshFailed.value = true;
  } else if (isInitial) {
    loadState.value = {status: 'error', error: loadError};
  }
};

const retry = (): void => {
  if (retryInFlight.value) {
    return;
  }

  if (liveStale.value) {
    refreshLoop?.stop();
    refreshLoop?.start();
  }

  if (projectedStale.value) {
    startProjectedLoop(durableRange.value, true);
  }
};

const handleProjectedTelemetrySuccess = (snapshot: ProjectedSnapshot): void => {
  const range = pendingProjectedRange;

  if (range === null) {
    return;
  }

  projectedRequestInFlight.value = false;
  refreshAttemptAt.value = Date.now();
  projectedLastSuccessAt.value = refreshAttemptAt.value;
  projectedRefreshFailed.value = false;
  projectedSnapshot.value = snapshot;
  projectedLoadedRange.value = range;
};

const historyStatusLabel = computed((): string | null => {
  const status = historyStatus(projectedSnapshot.value?.clock);

  if (status === 'legacy' || status === 'current' || status === 'empty') {
    return null;
  }

  return t(status === 'catching-up' ? 'history-catching-up' : 'history-historical');
});

const handleProjectedTelemetryError = (loadError: unknown, _isInitial: boolean): void => {
  console.error('[device-info-widget] projected telemetry refresh failed', loadError);
  refreshAttemptAt.value = Date.now();
  projectedRequestInFlight.value = false;
  projectedRefreshFailed.value = projectedLastSuccessAt.value !== null;
};

const loadLiveHistory = (range: DeviceInfoRange): void => {
  const currentInfo = info.value;

  if (currentInfo === null) {
    return;
  }

  liveHistoryGeneration += 1;
  const requestGeneration = liveHistoryGeneration;
  liveHistoryLoading.value = true;

  void fetchDeviceHistory(props.ctx.device.rci, deviceInfoDetail(range), currentInfo.memoryTotal).then(
    (nextHistory) => {
      if (
        !mounted
        || requestGeneration !== liveHistoryGeneration
        || selectedRange.value !== range
        || loadState.value.status !== 'success'
      ) {
        return;
      }

      loadState.value = {status: 'success', data: {...loadState.value.data, ...nextHistory}};
      liveHistoryLoading.value = false;
    },
    (loadError: unknown) => {
      if (mounted && requestGeneration === liveHistoryGeneration && selectedRange.value === range) {
        console.error('[device-info-widget] live history refresh failed', loadError);
        liveHistoryLoading.value = false;
      }
    },
  );
};

const stopProjectedLoop = (): void => {
  projectedLoopGeneration += 1;
  projectedRefreshLoop?.stop();
  projectedRefreshLoop = null;
  pendingProjectedRange = null;
  projectedRequestInFlight.value = false;
};

const startProjectedLoop = (range: DurableRange, preserveLoadedRange = false): void => {
  stopProjectedLoop();
  const generation = projectedLoopGeneration;
  if (!preserveLoadedRange) {
    projectedLoadedRange.value = null;
    projectedLastSuccessAt.value = null;
    projectedRefreshFailed.value = false;
  }
  pendingProjectedRange = range;
  projectedRefreshLoop = props.ctx.timers.createRefreshLoop({
    load: (signal) => {
      projectedRequestInFlight.value = true;
      refreshAttemptAt.value = Date.now();

      return props.ctx.telemetry.fetchProjected(range, {signal});
    },
    intervalMs: 15 * 60_000,
    onSuccess: (snapshot) => {
      if (generation === projectedLoopGeneration) {
        handleProjectedTelemetrySuccess(snapshot);
      }
    },
    onError: (loadError, isInitial) => {
      if (generation === projectedLoopGeneration) {
        handleProjectedTelemetryError(loadError, isInitial);
      }
    },
  });
  projectedRefreshLoop.start();
};

const setRange = (range: DisplayRange): void => {
  selectedRange.value = range;
  if (range === '7d' || range === '30d') {
    liveHistoryGeneration += 1;
    liveHistoryLoading.value = false;
    startProjectedLoop(range);
  } else {
    selectedLiveRange.value = range;
    stopProjectedLoop();
    loadLiveHistory(range);
  }
};

const onRangeChange = (event: Event): void => {
  const requestedRange = (event as CustomEvent<{value: string}>).detail?.value;
  const range = DISPLAY_RANGES.find((option) => option.key === requestedRange)?.key;

  if (range !== undefined) {
    setRange(range);
  }
};

const setSectionVisibility = (key: string, visible: boolean): void => {
  if (!(key in SECTION_STORAGE_KEYS)) {
    return;
  }

  sectionVisibility.value[key] = visible;
  dirtySections.add(key);
  void props.ctx.storage.instance.set(SECTION_STORAGE_KEYS[key as keyof typeof SECTION_STORAGE_KEYS], String(visible)).catch((caught: unknown) => {
    console.warn('[device-info-widget] could not persist section visibility', key, caught);
  });
};

const restoreSectionVisibility = (): void => {
  for (const [key, storageKey] of Object.entries(SECTION_STORAGE_KEYS)) {
    void props.ctx.storage.instance.get(storageKey).then((raw) => {
      if (mounted && raw !== null && !dirtySections.has(key) && (raw === 'true' || raw === 'false')) {
        sectionVisibility.value = {...sectionVisibility.value, [key]: raw === 'true'};
      }
    }).catch((caught: unknown) => {
      console.warn('[device-info-widget] could not read section visibility', key, caught);
    });
  }
};

const openSettings = (): void => {
  openSettingsDialog(props.ctx, sectionVisibility.value, setSectionVisibility, translator);
};

onMounted(() => {
  mounted = true;
  gatheringSubscription = props.ctx.telemetry.gathering$.subscribe(({enabled}) => {
    gatheringOverride.value = enabled;

    if (isDurableRange.value) {
      startProjectedLoop(durableRange.value, true);
    }
  });

  ticker = props.ctx.timers.createTicker();
  tickerSubscription = ticker.tick$.subscribe(() => {
    uptimeSeconds.value = getUptimeSeconds(baseline, Date.now());
  });

  ticker.start(1000);

  refreshLoop = props.ctx.timers.createRefreshLoop({
    load: async (signal): Promise<LiveInfoRefresh> => {
      requestInFlight.value = true;
      refreshAttemptAt.value = Date.now();
      const range = selectedLiveRange.value;

      return {range, info: await fetchDeviceInfo(props.ctx.device.rci, deviceInfoDetail(range), signal)};
    },
    intervalMs: 30_000,
    onSuccess: handleInfoSuccess,
    onError: handleLoadError,
  });

  refreshLoop.start();

  restoreSectionVisibility();
});

onUnmounted(() => {
  unsubscribeLocale();
  mounted = false;
  liveHistoryGeneration += 1;
  refreshLoop = null;
  gatheringSubscription?.unsubscribe();
  gatheringSubscription = null;
  tickerSubscription?.unsubscribe();
  tickerSubscription = null;
  ticker?.destroy();
  ticker = null;
});
</script>

<template>
  <div class="app">
    <header class="app__header">
      <mndw-button variant="ghost" :aria-label="t('settings')" @click="openSettings">
        <mndw-icon name="settings"></mndw-icon>
      </mndw-button>
    </header>
    <div v-if="loadState.status === 'loading'" class="app__loading">{{ t('loading') }}</div>
    <div v-else-if="loadState.status === 'error' || info === null" class="mndw-alert mndw-alert--danger" role="alert">
      {{ t('error') }}
    </div>
    <div v-else>
      <div class="range-scroll">
        <mndw-segmented :label="t('history-range')" :value.prop="selectedRange" @mndwchange="onRangeChange">
          <mndw-segment v-for="range in DISPLAY_RANGES" :key="String(range.key)" :value="range.key">
            {{ t(range.label) }}
          </mndw-segment>
        </mndw-segmented>
      </div>
      <div v-if="stale" class="app__stale mndw-alert mndw-alert--warning" role="status">
        <span class="app__stale-message">{{ t('stale.message', {time: lastSuccessTime}) }}</span>
        <mndw-button
          class="app__stale-retry"
          variant="ghost"
          :disabled="retryInFlight"
          :aria-busy="retryInFlight ? 'true' : null"
          @click="retry"
        >{{ t('stale.retry') }}</mndw-button>
      </div>
      <TelemetryNote
        v-if="telemetryNoteVisible"
        :sessionConfigured="sessionConfigured"
        :lastPointTime="lastPointTime"
        :navigation="props.ctx.navigation"
      />
      <span v-else-if="historyStatusLabel !== null" class="app__history-status" data-testid="history-status">
        {{ historyStatusLabel }}
      </span>
      <div class="app__loads">
        <LoadBarChart v-if="sectionVisibility.cpu" :label="t('cpu')" :value="info.cpuLoadPercent"
                      :history="cpuLoadHistory"
                      :timeDomain="cpuLoadTimeDomain"
                      :loading="liveHistoryLoading"
                      :translator="translator"/>
        <LoadBarChart v-if="sectionVisibility.ram" :label="t('ram')" :value="info.ramLoadPercent"
                      :history="ramLoadHistory"
                      :timeDomain="ramLoadTimeDomain"
                      :loading="liveHistoryLoading"
                      :translator="translator"/>
      </div>
      <section v-if="sectionVisibility.identity" class="app__identity">
        <hr class="app__divider">
        <div class="app__grid">
          <span class="app__label">{{ t('device') }}:</span>
          <span class="app__value">{{ props.ctx.device.info.model }}</span>
          <span class="app__label">{{ t('firmware') }}:</span>
          <span class="app__value">{{ firmware }}</span>
          <span class="app__label">{{ t('uptime') }}:</span>
          <span class="app__value" :title="liveStale ? t('uptime.estimated-title') : undefined">{{ uptime }}</span>
          <hr class="app__divider app__divider--span">
          <CopyField :label="t('serial')" :value="info.serial" :translator="translator"/>
          <CopyField :label="t('service-tag')" :value="info.serviceTag" :translator="translator"/>
          <CopyField :label="t('mac')" :value="info.mac" :translator="translator"/>
          <CopyField :label="t('hwid')" :value="info.hwid" :translator="translator"/>
          <CopyField :label="t('cid')" :value="info.cid" :translator="translator"/>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  container-name: device-info-card;
  min-height: 100%;
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

.app__loading {
  padding: 1rem;
  color: var(--mndw-text-subtle);
}

.app__stale {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--mndw-space-2);
  min-width: 0;
  margin-bottom: 0.75rem;
  font-size: var(--mndw-text-sm);
}

.app__stale-message {
  flex: 1 1 12rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.app__stale-retry {
  flex: 0 0 auto;
  font-size: var(--mndw-text-xs);
}

.app__stale-retry::part(button) {
  min-height: var(--mndw-control-h-sm);
  padding: 0 var(--mndw-space-2);
}

.app__grid {
  display: flex;
  flex-direction: column;
  gap: 0.25rem 0.75rem;
  align-items: baseline;
}

.app__label {
  color: var(--mndw-text-subtle);
  font-weight: 600;
  white-space: nowrap;
}

.app__value {
  color: var(--mndw-text);
  overflow-wrap: anywhere;
}

.app__divider {
  border: none;
  border-top: 1px solid var(--mndw-border);
  margin: 0.75rem 0;
}

.app__divider--span {
  align-self: stretch;
  margin: 0.5rem 0;
}

.app__loads {
  container-type: inline-size;
  container-name: device-info-loads;
  display: flex;
  flex-direction: row;
  gap: 1.5rem;
  min-width: 0;

  .load-bar-chart {
    flex-grow: 1;
  }
}

.range-scroll {
  flex: none;
  min-width: 0;
  overflow-x: auto;
  margin-bottom: 0.75rem;
}

@container device-info-card (min-width: 22rem) {
  .app__grid {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    column-gap: 1.25rem;
    align-items: baseline;
  }

  .app__divider--span {
    grid-column: 1 / -1;
  }
}

</style>
