<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref} from 'vue';
import type {LoadState, PluginContext} from '@mndw/sdk';
import {useTranslator} from '@mndw/sdk/vue';
import {Ticker} from '@mndw/sdk/ticker';
import {createRefreshLoop, type RefreshLoop} from '@mndw/sdk/refresh';
import CopyField from './components/CopyField.vue';
import LoadBarChart from './components/LoadBarChart.vue';
import {type LiveDeviceInfo, fetchDeviceInfo, formatUptime} from './services/device-info.js';
import {createUptimeBaseline, getUptimeSeconds, type UptimeBaseline} from './services/uptime.js';

const props = defineProps<{ctx: PluginContext}>();

const loadState = ref<LoadState<LiveDeviceInfo>>({status: 'loading'});
const uptimeSeconds = ref<number | null>(null);
const translator = useTranslator(props.ctx.i18n);
const t = (key: string): string => translator.t(key);

let baseline: UptimeBaseline | null = null;
let ticker: Ticker | null = null;
let unsubscribeTicker: (() => void) | null = null;
let refreshLoop: RefreshLoop | null = null;

const firmware = computed(() => props.ctx.deviceInfo.firmwareVersion);
const info = computed<LiveDeviceInfo | null>(() => {
  return loadState.value.status === 'success' ? loadState.value.data : null;
});

const uptime = computed(() => {
  return uptimeSeconds.value !== null
      ? formatUptime(uptimeSeconds.value)
      : t('unknown');
});

const handleInfoSuccess = (nextInfo: LiveDeviceInfo): void => {
  const syncedAtMs = Date.now();

  loadState.value = {status: 'success', data: nextInfo};
  baseline = createUptimeBaseline(nextInfo.uptimeSeconds, syncedAtMs);
  uptimeSeconds.value = getUptimeSeconds(baseline, syncedAtMs);
};

const handleLoadError = (loadError: unknown, isInitial: boolean): void => {
  console.error('[device-info-widget] device info refresh failed', loadError);

  if (isInitial) {
    loadState.value = {status: 'error', error: loadError};
  }
};

onMounted(() => {
  ticker = new Ticker();

  unsubscribeTicker = ticker.onTick(() => {
    uptimeSeconds.value = getUptimeSeconds(baseline, Date.now());
  });

  ticker.start(1000);

  refreshLoop = createRefreshLoop({
    load: () => fetchDeviceInfo(props.ctx.rciManager),
    intervalMs: 30_000,
    onSuccess: handleInfoSuccess,
    onError: handleLoadError,
  });

  refreshLoop.start();
});

onUnmounted(() => {
  refreshLoop?.stop();
  refreshLoop = null;
  unsubscribeTicker?.();
  unsubscribeTicker = null;
  ticker?.destroy();
  ticker = null;
});
</script>

<template>
  <div class="app">
    <span data-testid="l10n-probe" hidden>{{ translator.t('l10n.probe') }}</span>
    <div v-if="loadState.status === 'loading'" class="app__loading">{{ t('loading') }}</div>
    <div v-else-if="loadState.status === 'error' || info === null" class="mndw-alert mndw-alert--danger" role="alert">
      {{ t('error') }}
    </div>
    <div v-else>
      <div class="app__loads">
        <LoadBarChart :label="t('cpu')" :value="info.cpuLoadPercent" :history="info.cpuHistory"
                      :translator="translator"/>
        <LoadBarChart :label="t('ram')" :value="info.ramLoadPercent" :history="info.ramHistory"
                      :translator="translator"/>
      </div>
      <hr class="app__divider">
      <div class="app__grid">
        <span class="app__label">{{ t('device') }}:</span>
        <span class="app__value">{{ props.ctx.deviceInfo.model }}</span>
        <span class="app__label">{{ t('firmware') }}:</span>
        <span class="app__value">{{ firmware }}</span>
        <span class="app__label">{{ t('uptime') }}:</span>
        <span class="app__value">{{ uptime }}</span>
      </div>
      <hr class="app__divider">
      <div class="app__grid">
        <CopyField :label="t('serial')" :value="info.serial" :translator="translator"/>
        <CopyField :label="t('service-tag')" :value="info.serviceTag" :translator="translator"/>
        <CopyField :label="t('mac')" :value="info.mac" :translator="translator"/>
        <CopyField :label="t('hwid')" :value="info.hwid" :translator="translator"/>
        <CopyField :label="t('cid')" :value="info.cid" :translator="translator"/>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  box-sizing: border-box;
  padding: 1rem;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: 0.8125rem;
}

.app__loading {
  padding: 1rem;
  color: var(--mndw-text-subtle);
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
</style>
