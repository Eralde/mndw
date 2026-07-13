<script lang="ts">
import {onMount} from 'svelte';
import type {BackendClient} from '@mndw/sdk';
import {
  type Host,
  type HostStats,
  fetchHosts,
  fetchStats,
  updateHosts,
} from './services/ping';

interface Props {
  backend?: BackendClient;
}

let {backend}: Props = $props();

const hasBackend = $derived(Boolean(backend));

let hosts = $state<Host[]>([]);
let stats = $state<HostStats[]>([]);
let loading = $state(false);
let message = $state('');
let isError = $state(false);
let newHostIp = $state('');
let newHostName = $state('');
let pollSeconds = $state(2);

const editingNames = $state<Record<string, string>>({});
let statsIntervalId: ReturnType<typeof setInterval> | undefined;

function setMessage(text: string, error = false): void {
  message = text;
  isError = error;
}

function formatMs(value: number): string {
  return !Number.isFinite(value) || value <= 0 ? '-' : `${value.toFixed(2)} ms`;
}

function formatUpdatedAt(value: string): string {
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '-' : parsed.toLocaleTimeString();
}

async function loadHosts(): Promise<void> {
  if (!backend) {
    return;
  }
  hosts = await fetchHosts(backend);
  for (const host of hosts) {
    editingNames[host.ip] = editingNames[host.ip] ?? host.name ?? '';
  }
}

async function loadStats(): Promise<void> {
  if (!backend) {
    return;
  }
  stats = await fetchStats(backend);
}

async function refreshNow(): Promise<void> {
  if (!backend) {
    return;
  }
  loading = true;
  try {
    await Promise.all([loadHosts(), loadStats()]);
    setMessage('Data refreshed');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Refresh failed', true);
  } finally {
    loading = false;
  }
}

function restartStatsPolling(): void {
  if (statsIntervalId) {
    clearInterval(statsIntervalId);
  }
  statsIntervalId = setInterval(() => {
    void loadStats().catch((error) => {
      setMessage(
        error instanceof Error ? error.message : 'Stats polling failed',
        true,
      );
    });
  }, Math.max(1, pollSeconds) * 1000);
}

async function addHost(): Promise<void> {
  if (!backend) {
    return;
  }
  const ip = newHostIp.trim();
  if (!ip) {
    setMessage('Host IP is required', true);
    return;
  }
  loading = true;
  try {
    hosts = await updateHosts(backend, {action: 'add', ip,
      name: newHostName.trim()});
    newHostIp = '';
    newHostName = '';
    await refreshNow();
    setMessage('Host added');
  } catch (error) {
    setMessage(
      error instanceof Error ? error.message : 'Add host failed',
      true,
    );
  } finally {
    loading = false;
  }
}

async function saveHostName(ip: string): Promise<void> {
  if (!backend) {
    return;
  }
  loading = true;
  try {
    await updateHosts(backend, {action: 'update', ip,
      name: (editingNames[ip] ?? '').trim()});
    await refreshNow();
    setMessage('Host updated');
  } catch (error) {
    setMessage(
      error instanceof Error ? error.message : 'Update host failed',
      true,
    );
  } finally {
    loading = false;
  }
}

async function removeHost(ip: string): Promise<void> {
  if (!backend) {
    return;
  }
  loading = true;
  try {
    await updateHosts(backend, {action: 'remove', ip});
    delete editingNames[ip];
    await refreshNow();
    setMessage('Host removed');
  } catch (error) {
    setMessage(
      error instanceof Error ? error.message : 'Remove host failed',
      true,
    );
  } finally {
    loading = false;
  }
}

onMount(() => {
  if (!backend) {
    setMessage('Backend is unavailable for this plugin instance', true);
    return;
  }
  setMessage('Monitoring…');
  void refreshNow();
  restartStatsPolling();
  return () => {
    if (statsIntervalId) {
      clearInterval(statsIntervalId);
    }
  };
});
</script>

<div class="ping-widget">
  <div class="header">
    <h3>Ping Utility</h3>
    <div class="header-actions">
      <button
        type="button"
        class="btn secondary"
        disabled={loading || !hasBackend}
        onclick={refreshNow}
      >
        Refresh now
      </button>
    </div>
  </div>

  <div class="controls">
    <input
      type="text"
      bind:value={newHostIp}
      placeholder="Host IP"
    />
    <input
      type="text"
      bind:value={newHostName}
      placeholder="Label (optional)"
    />
    <button
      type="button"
      class="btn primary"
      disabled={loading || !hasBackend}
      onclick={addHost}
    >
      Add
    </button>
    <label>
      Poll
      <input
        type="number"
        min="1"
        max="30"
        bind:value={pollSeconds}
      />
      s
    </label>
  </div>

  {#if message}
    <div class={`message ${isError ? 'error' : 'info'}`}>{message}</div>
  {/if}

  <div class="host-list">
    {#if hosts.length === 0}
      <div class="empty">No hosts configured yet.</div>
    {:else}
      {#each hosts as host (host.ip)}
        <div class="host-row">
          <span class="ip">{host.ip}</span>
          <input
            type="text"
            bind:value={editingNames[host.ip]}
            placeholder="Label"
          />
          <button
            type="button"
            class="btn secondary"
            disabled={loading || !hasBackend}
            onclick={() => saveHostName(host.ip)}
          >
            Save
          </button>
          <button
            type="button"
            class="btn danger"
            disabled={loading || !hasBackend}
            onclick={() => removeHost(host.ip)}
          >
            Remove
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Host</th>
          <th>Last</th>
          <th>Avg</th>
          <th>Median</th>
          <th>Min</th>
          <th>Max</th>
          <th>Loss</th>
          <th>Samples</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {#if stats.length === 0}
          <tr>
            <td
              colspan="9"
              class="empty"
            >
              No stats yet.
            </td>
          </tr>
        {:else}
          {#each stats as row (row.ip)}
            <tr>
              <td>{row.name || row.ip}</td>
              <td>{formatMs(row.lastMs)}</td>
              <td>{formatMs(row.avgMs)}</td>
              <td>{formatMs(row.medianMs)}</td>
              <td>{formatMs(row.minMs)}</td>
              <td>{formatMs(row.maxMs)}</td>
              <td
                class={row.lossPercent > 25
                ? 'bad'
                : row.lossPercent > 0
                ? 'warn'
                : 'ok'}
              >
                {row.lossPercent.toFixed(1)}%
              </td>
              <td>{row.sampleCount}</td>
              <td>{formatUpdatedAt(row.updatedAt)}</td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>

<style>
:root {
  --bg: linear-gradient(180deg, #fcfbf7 0%, #f6f3eb 100%);
  --panel: #ffffff;
  --line: #d7cfbf;
  --text: #2c2a24;
  --muted: #6f6a5f;
  --primary: #20677a;
  --danger: #9f3d36;
}

.ping-widget {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto auto auto 1fr;
  gap: 8px;
  padding: 10px;
  background: var(--bg);
  color: var(--text);
  font-family: 'Avenir Next', 'Trebuchet MS', sans-serif;
  box-sizing: border-box;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

h3 {
  margin: 0;
  font-size: 16px;
  letter-spacing: 0.2px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.badge {
  font-size: 11px;
  border-radius: 999px;
  padding: 3px 8px;
  background: #ece6d8;
  color: var(--muted);
}

.badge.ok {
  background: #dbf0d7;
  color: #2e6942;
}

.controls {
  display: grid;
  grid-template-columns: 1.2fr 1fr auto auto;
  gap: 6px;
  align-items: center;
}

.controls label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
}

input {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  background: var(--panel);
}

.btn {
  border: 0;
  border-radius: 6px;
  font-size: 12px;
  padding: 6px 10px;
  cursor: pointer;
  transition: transform 120ms ease;
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

.btn:not(:disabled):hover {
  transform: translateY(-1px);
}

.btn.primary {
  background: var(--primary);
  color: #fff;
}

.btn.secondary {
  background: #ddd4c3;
  color: #3d392f;
}

.btn.danger {
  background: var(--danger);
  color: #fff;
}

.message {
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
}

.message.info {
  background: #e6f1f4;
  color: #275362;
}

.message.error {
  background: #f8e5e3;
  color: #7a2c27;
}

.host-list {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px;
  max-height: 105px;
  overflow: auto;
}

.host-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto auto;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}

.host-row:last-child {
  margin-bottom: 0;
}

.host-row .ip {
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 12px;
}

.table-wrap {
  min-height: 0;
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
}

table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}

thead {
  position: sticky;
  top: 0;
  background: #f0e8d9;
}

th,
td {
  padding: 5px 6px;
  border-bottom: 1px solid #efe7d8;
  text-align: left;
  white-space: nowrap;
}

td.ok {
  color: #2f6d45;
}

td.warn {
  color: #8c6411;
}

td.bad {
  color: #8e2f2a;
}

.empty {
  color: var(--muted);
  font-style: italic;
  font-size: 12px;
}

@media (max-width: 720px) {
  .controls {
    grid-template-columns: 1fr;
  }

  .host-row {
    grid-template-columns: 1fr;
  }
}
</style>
