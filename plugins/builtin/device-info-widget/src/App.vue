<script setup lang="ts">
import type {PluginContext} from '@mndw/sdk';
import {Ticker} from '@mndw/sdk/ticker';
import {computed, onMounted, onUnmounted, ref} from 'vue';

import CopyField from './components/CopyField.vue';
import LoadBarChart from './components/LoadBarChart.vue';
import {type DeviceInfo, fetchDeviceInfo, formatUptime} from './services/device-info.js';
import {createRefreshLoop, type RefreshLoop} from '@mndw/sdk/refresh';
import {createUptimeBaseline, getUptimeSeconds, type UptimeBaseline} from './services/uptime.js';

const props = defineProps<{ctx: PluginContext}>();

const loading = ref(true);
const error = ref(false);
const info = ref<DeviceInfo | null>(null);
const uptimeSeconds = ref<number | null>(null);

let baseline: UptimeBaseline | null = null;
let ticker: Ticker | null = null;
let unsubscribeTicker: (() => void) | null = null;
let refreshLoop: RefreshLoop | null = null;

const firmware = computed(() => props.ctx.hostInfo.firmwareVersion);
const uptime = computed(() =>
    uptimeSeconds.value !== null
        ? formatUptime(uptimeSeconds.value)
        : 'Unknown');

const handleInfoSuccess = (nextInfo: DeviceInfo): void => {
  const syncedAtMs = Date.now();

  info.value = nextInfo;
  error.value = false;
  loading.value = false;
  baseline = createUptimeBaseline(nextInfo.uptimeSeconds, syncedAtMs);
  uptimeSeconds.value = getUptimeSeconds(baseline, syncedAtMs);
};

const handleLoadError = (loadError: unknown, isInitial: boolean): void => {
  console.error('[device-info-widget] device info refresh failed', loadError);

  if (isInitial) {
    loading.value = false;
    error.value = true;
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
    <div v-if="loading" class="app__loading">Loading&#8230;</div>
    <div v-else-if="error || info === null" class="mndw-alert mndw-alert--danger" role="alert">
      Failed to load device info
    </div>
    <div v-else>
      <div class="app__loads">
        <LoadBarChart label="CPU" :value="info.cpuLoadPercent" :history="info.cpuHistory"/>
        <LoadBarChart label="RAM" :value="info.ramLoadPercent" :history="info.ramHistory"/>
      </div>
      <hr class="app__divider">
      <div class="app__grid">
        <span class="app__label">Device:</span>
        <span class="app__value">{{ info.model }}</span>
        <span class="app__label">Firmware:</span>
        <span class="app__value">{{ firmware }}</span>
        <span class="app__label">Uptime:</span>
        <span class="app__value">{{ uptime }}</span>
      </div>
      <hr class="app__divider">
      <div class="app__grid">
        <CopyField label="Serial" :value="info.serial"/>
        <CopyField label="Service Tag" :value="info.serviceTag"/>
        <CopyField label="MAC" :value="info.mac"/>
        <CopyField label="HW ID" :value="info.hwid"/>
        <CopyField label="CID" :value="info.cid"/>
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
  padding: 16px;
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: 13px;
}

.app__loading {
  padding: 16px;
  color: var(--mndw-text-subtle);
}

.app__grid {
  display: flex;
  flex-direction: column;
  gap: 4px 12px;
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
  margin: 12px 0;
}

.app__loads {
  container-type: inline-size;
  container-name: device-info-loads;
  display: flex;
  flex-direction: row;
  gap: 24px;
  min-width: 0;

  .load-bar-chart {
    flex-grow: 1;
  }
}
</style>
