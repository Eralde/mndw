<script lang="ts">
import {onMount} from 'svelte';
import type {RciManager} from '@rci-tools/core';
import {formatSpeed} from '@mndw/ui';
import type {PluginStorage} from '@mndw/sdk';
import {createRefreshLoop} from '@mndw/sdk/refresh';
import {type ClockDate, RciService} from '../services/rci.js';
import type {HostBar, HostClient} from '../types.js';
import {toDeviceTrafficChartData} from '../utils/chart-data.js';
import type {OpenSettingsArgs} from '../open-settings-dialog.js';

interface Props {
  rci: RciManager;
  storage: PluginStorage;
  openSettings: (args: OpenSettingsArgs) => void;
  setTileTitle?: (title: string) => void;
}

let {rci, storage, openSettings, setTileTitle}: Props = $props();

const POLL_INTERVAL = 5000;
const DEVICE_TIME_INTERVAL = 30000;
const STORAGE_MAC = 'selected-mac';
const STORAGE_DETAIL = 'detail';

// Intentional: `rci` is a stable host-provided manager, captured once.
// svelte-ignore state_referenced_locally
const rciService = new RciService(rci);

let hosts = $state<HostClient[]>([]);
let selectedMac = $state('');
let rawChartData = $state<HostBar[]>([]);
let detail = $state(0);
let deviceTime = $state<Date | null>(null);
let error = $state('');
let isLoading = $state(true);

const chartLoop = createRefreshLoop({
  load: loadChartData,
  intervalMs: POLL_INTERVAL,
  onSuccess: () => {},
  onError: () => {},
});
const timeLoop = createRefreshLoop({
  load: loadDeviceTime,
  intervalMs: DEVICE_TIME_INTERVAL,
  onSuccess: () => {},
  onError: () => {},
});

let chartData = $derived(toDeviceTrafficChartData(rawChartData, deviceTime));

$effect(() => {
  const name = hosts.find((h) => h.mac === selectedMac)?.name || selectedMac;

  if (setTileTitle) {
    setTileTitle(name);
  }
});

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

    rawChartData = rciChartData.bar || [];
    error = '';
  } catch (ex) {
    error = 'Failed to load data';

    console.error('[device-traffic-widget]', ex);
  }
}

function stopPolling() {
  chartLoop.stop();
  timeLoop.stop();
}

function startPolling() {
  stopPolling();

  if (!selectedMac) {
    return;
  }

  chartLoop.start();
  timeLoop.start();
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

    rawChartData = [];
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
  {#if error}
    <div
      class="mndw-alert mndw-alert--danger notice"
      role="alert"
    >
      {error}
      <mndw-button
        variant="danger"
        class="retry-btn"
        onclick={() => {
          error = '';
          if (selectedMac) {
            startPolling();
          }
        }}
      >
        Retry
      </mndw-button>
    </div>
  {/if}

  {#if isLoading}
    <div class="msg">Loading...</div>
  {:else if !selectedMac}
    <div class="empty-state">
      <h3 class="empty-state__heading">Device Traffic Monitor</h3>
      <p class="empty-state__subtitle">Select a device to monitor traffic</p>
      <mndw-select
        label="Device"
        placeholder="Select device…"
        value={selectedMac}
        onmndwchange={(e: CustomEvent<{value: string}>) =>
        handleSelectDevice(e.detail.value)}
      >
        {#each hosts as host (host.mac)}
          <mndw-option value={host.mac}>
            {host.name}{#if !host.active} (offline){/if}
          </mndw-option>
        {/each}
      </mndw-select>
      {#if hosts.length === 0}
        <p class="mndw-alert mndw-alert--danger">No devices found</p>
      {/if}
    </div>
  {:else}
    <div class="chart-view">
      <div class="widget-header">
        {#if !setTileTitle}
          <span class="device-label">
            {
              hosts.find(h => h.mac === selectedMac)?.name
              || selectedMac
            }
          </span>
        {/if}
        <div class="header-actions">
          <mndw-segmented
            class="btn-group"
            label="Detail"
            value={String(detail)}
            onmndwchange={(event: CustomEvent<{value: string}>) =>
            handleDetailChange(Number(event.detail.value))}
          >
            {#each detailLabels as d (d.value)}
              <mndw-segment value={String(d.value)}>
                {d.label}
              </mndw-segment>
            {/each}
          </mndw-segmented>
          <mndw-button
            class="gear-btn"
            variant="ghost"
            title="Widget Settings"
            aria-label="Widget settings"
            onclick={handleOpenSettings}
          >
            &#9881;
          </mndw-button>
        </div>
      </div>
      {#if !deviceTime}
        <div class="msg">Loading data...</div>
      {:else}
        <div class="chart-wrap">
          <mndw-bar-chart
            points={chartData.points}
            empty-label="No data"
            aria-label="Device traffic history"
          ></mndw-bar-chart>
          <div
            class="traffic-summary"
            aria-label="Average traffic"
          >
            ↓ {formatSpeed(chartData.averageRx)} ↑ {
              formatSpeed(chartData.averageTx)
            }
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
.traffic-widget {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 0;
  color: var(--mndw-text);
  font-size: 14px;
  font-family: var(--mndw-font-sans);
}

/* Layout only. `.mndw-alert--danger` owns the box and the severity colours. */
.notice {
  display: flex;
  gap: 6px;
  align-items: center;
  align-self: stretch;
  margin: 8px 12px;
  font-size: 12px;
}

.retry-btn {
  flex-shrink: 0;
  margin-left: auto;
}

.retry-btn::part(button) {
  min-height: auto;
  padding: 2px 8px;
  font-size: 11px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  gap: 8px;
  justify-content: center;
  align-items: center;
  width: 100%;
  max-width: 320px;
  margin: auto;
  padding: 16px;
  text-align: center;
}

.empty-state__heading {
  margin: 0;
  color: var(--mndw-text);
  font-weight: 600;
  font-size: 16px;
}

.empty-state__subtitle {
  margin: 0 0 4px;
  color: var(--mndw-text-subtle);
  font-size: 13px;
  line-height: 1.4;
}

.chart-view {
  display: flex;
  flex: 1;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  min-height: 0;
  padding: 8px;
}

.widget-header {
  display: flex;
  flex-shrink: 0;
  justify-content: space-between;
  align-items: center;
  padding: 0 4px 6px;
}

.device-label {
  flex-shrink: 1;
  overflow: hidden;
  min-width: 0;
  color: var(--mndw-text);
  font-weight: 600;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  align-items: center;
}

.btn-group::part(group) {
  gap: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

.btn-group mndw-segment::part(segment) {
  padding: 3px 8px;
  border: 1px solid var(--mndw-border);
  border-radius: 0;
  background: var(--mndw-surface);
  font-size: 11px;
}

.btn-group mndw-segment:first-child::part(segment) {
  border-radius: 3px 0 0 3px;
}

.btn-group mndw-segment:last-child::part(segment) {
  border-radius: 0 3px 3px 0;
}

.btn-group mndw-segment:not(:last-child)::part(segment) {
  border-right: 0;
}

.gear-btn {
  flex-shrink: 0;
  font-size: 18px;
}

.msg {
  padding: 16px;
  color: var(--mndw-text-subtle);
  font-size: 13px;
  text-align: center;
}

.chart-wrap {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  min-height: 0;
}

.chart-wrap mndw-bar-chart {
  flex: 1;
  min-height: 0;
}

.traffic-summary {
  flex: 0 0 auto;
  padding: 4px 0 0;
  color: var(--mndw-text-subtle);
  font-size: 11px;
  text-align: left;
}
</style>
