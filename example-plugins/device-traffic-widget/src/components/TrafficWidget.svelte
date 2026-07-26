<script lang="ts">
import {onMount} from 'svelte';
import type {RciManager} from '@rci-tools/core';
import type {PluginStorage} from '@mndw/sdk';
import {type ClockDate, RciService} from '../services/rci.js';
import type {HostBar, HostClient} from '../types.js';
import BarChart from './BarChart.svelte';
import type {OpenSettingsArgs} from '../open-settings-dialog.js';

interface Props {
  rci: RciManager;
  storage: PluginStorage;
  openSettings: (args: OpenSettingsArgs) => void;
}

let {rci, storage, openSettings}: Props = $props();

const POLL_INTERVAL = 5000;
const DEVICE_TIME_INTERVAL = 30000;
const STORAGE_MAC = 'selected-mac';
const STORAGE_DETAIL = 'detail';

// Intentional: `rci` is a stable host-provided manager, captured once.
// svelte-ignore state_referenced_locally
const rciService = new RciService(rci);

let hosts = $state<HostClient[]>([]);
let selectedMac = $state('');
let chartData = $state<HostBar[]>([]);
let detail = $state(0);
let deviceTime = $state<Date | null>(null);
let error = $state('');
let isLoading = $state(true);

let pollTimer: ReturnType<typeof setInterval> | undefined;
let deviceTimeTimer: ReturnType<typeof setInterval> | undefined;

const detailLabels = [
  {value: 0, label: '3m'},
  {value: 1, label: '1h'},
  {value: 2, label: '3h'},
  {value: 3, label: '1d'},
];

async function loadHosts() {
  try {
    hosts = await rciService.getHosts();
  } catch (ex) {
    console.error('[device-traffic-widget]', ex);
  }
}

async function loadDeviceTime() {
  try {
    const d: ClockDate = await rciService.getDeviceTime();
    deviceTime = new Date(
      d.year,
      d.month - 1,
      d.day,
      d.hour,
      d.min,
      d.sec,
      d.msec,
    );
  } catch (ex) {
    console.error('[device-traffic-widget]', ex);
  }
}

async function loadChartData() {
  if (!selectedMac) {
    return;
  }

  try {
    const rciChartData = await rciService.getChartData([selectedMac], detail);

    chartData = rciChartData.bar || [];
    error = '';
  } catch (ex) {
    error = 'Failed to load data';

    console.error('[device-traffic-widget]', ex);
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);

    pollTimer = undefined;
  }

  if (deviceTimeTimer) {
    clearInterval(deviceTimeTimer);

    deviceTimeTimer = undefined;
  }
}

function startPolling() {
  stopPolling();

  if (selectedMac) {
    loadDeviceTime();
    loadChartData();

    pollTimer = setInterval(loadChartData, POLL_INTERVAL);
    deviceTimeTimer = setInterval(loadDeviceTime, DEVICE_TIME_INTERVAL);
  }
}

function handleOpenSettings() {
  openSettings({
    hosts,
    selectedMac,
    onSelect: handleSelectDevice,
  });
}

async function handleSelectDevice(mac: string) {
  selectedMac = mac;

  if (mac) {
    await storage.set(STORAGE_MAC, mac);
    startPolling();
  } else {
    await storage.delete(STORAGE_MAC);
    stopPolling();

    chartData = [];
  }
}

async function handleDetailChange(newDetail: number) {
  detail = newDetail;

  await storage.set(STORAGE_DETAIL, String(newDetail));

  if (selectedMac) {
    startPolling();
  }
}

onMount(() => {
  (async () => {
    const savedMac = await storage.get(STORAGE_MAC);
    const savedDetail = await storage.get(STORAGE_DETAIL);

    if (savedDetail) {
      detail = parseInt(savedDetail, 10) || 0;
    }

    await loadHosts();
    await loadDeviceTime();

    if (savedMac && hosts.some(h => h.mac === savedMac)) {
      selectedMac = savedMac;
      startPolling();
    }

    isLoading = false;
  })();

  return () => {
    stopPolling();
  };
});
</script>

<div class="traffic-widget">
  <div class="widget-header">
    <span class="device-label">
      {
        hosts.find(h => h.mac === selectedMac)?.name
        || 'Select device'
      }
    </span>
    <mndw-button
      class="gear-btn"
      role="button"
      tabindex="-1"
      onkeydown={() => undefined}
      variant="ghost"
      title="Select device"
      aria-label="Select device"
      onclick={handleOpenSettings}
    >
      &#9881;
    </mndw-button>
  </div>

  <div class="controls">
    <div class="btn-group">
      {#each detailLabels as d (d.value)}
        <button
          class:active={detail === d.value}
          onclick={() => handleDetailChange(d.value)}
        >
          {d.label}
        </button>
      {/each}
    </div>
  </div>

  {#if error}
    <div class="error">
      {error}
      <button
        class="retry-btn"
        onclick={() => {
          error = '';
          if (selectedMac) {
            startPolling();
          }
        }}
      >
        Retry
      </button>
    </div>
  {/if}

  {#if isLoading}
    <div class="msg">Loading...</div>
  {:else if !selectedMac}
    <div class="msg">Select a device</div>
  {:else if chartData.length === 0 || !deviceTime}
    <div class="msg">Loading data...</div>
  {:else}
    <div class="chart-wrap">
      <BarChart
        data={chartData}
        {hosts}
        deviceTime={deviceTime}
      />
    </div>
  {/if}
</div>

<style>
.traffic-widget {
  container-type: inline-size; padding: 8px;
  font-family: var(--mndw-font-sans);
  font-size: 14px; width: 100%; height: 100%; box-sizing: border-box;
  color: var(--mndw-text);
  display: flex; flex-direction: column;
}
.widget-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.device-label { font-weight: 600; font-size: 13px; color: var(--mndw-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gear-btn { flex-shrink: 0; font-size: 18px; }
.controls { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
.btn-group { display: flex; gap: 0; }
.btn-group button {
  padding: 3px 8px; border: 1px solid var(--mndw-border); background: var(--mndw-surface); color: var(--mndw-text); font-size: 11px; cursor: pointer;
}
.btn-group button:first-child { border-radius: 3px 0 0 3px; }
.btn-group button:last-child { border-radius: 0 3px 3px 0; }
.btn-group button:not(:last-child) { border-right: none; }
.btn-group button.active { background: var(--mndw-accent); color: var(--mndw-accent-contrast); border-color: var(--mndw-accent); }
.error { color: var(--mndw-danger); margin: 4px 0; padding: 4px 8px; background: var(--mndw-danger-bg); border-radius: 4px; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.retry-btn { margin-left: auto; padding: 2px 8px; border: 1px solid var(--mndw-danger); border-radius: 3px; background: var(--mndw-surface); color: var(--mndw-danger); font-size: 11px; cursor: pointer; }
.msg { text-align: center; color: var(--mndw-text-subtle); padding: 16px; font-size: 13px; }
.chart-wrap { flex: 1; min-height: 0; width: 100%; }
</style>
