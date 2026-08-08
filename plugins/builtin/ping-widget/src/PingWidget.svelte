<script lang="ts">
import {onMount} from 'svelte';
import type {BackendClient} from '@mndw/sdk';
import {createRefreshLoop} from '@mndw/sdk/refresh';
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

type RenameStatus =
  | 'idle'
  | 'editing'
  | 'saving'
  | 'error';

interface RenameState {
  original: string;
  draft: string;
  status: RenameStatus;
  error: string;
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
const renameStates = $state<Record<string, RenameState>>({});
const statsLoop = createRefreshLoop({
  load: loadStats,
  intervalMs: 2_000,
  onSuccess: () => {},
  onError: (error) => {
    setMessage(
      error instanceof Error ? error.message : 'Stats polling failed',
      true,
    );
  },
});

function createRenameState(name: string): RenameState {
  return {original: name, draft: name, status: 'idle', error: ''};
}

function getRenameState(ip: string, fallbackName = ''): RenameState {
  const existing = renameStates[ip];
  if (existing) {
    return existing;
  }

  const state = createRenameState(fallbackName);
  renameStates[ip] = state;
  return state;
}

function syncRenameDrafts(nextHosts: Host[]): void {
  for (const host of nextHosts) {
    const state = getRenameState(host.ip, host.name ?? '');
    if (state.status === 'idle') {
      const name = host.name ?? '';
      state.original = name;
      state.draft = name;
    }
  }
}

function beginRename(ip: string, name: string): void {
  const state = getRenameState(ip, name);
  if (state.status === 'saving') {
    return;
  }

  state.original = name;
  state.draft = name;
  state.status = 'editing';
  state.error = '';
}

function cancelRename(ip: string, fallbackName: string): void {
  const state = getRenameState(ip, fallbackName);
  if (state.status === 'saving') {
    return;
  }

  state.draft = state.original || fallbackName;
  state.status = 'idle';
  state.error = '';
}

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
  syncRenameDrafts(hosts);
}

async function loadStats(): Promise<void> {
  if (!backend) {
    return;
  }
  const nextStats = await fetchStats(backend);
  for (const row of nextStats) {
    getRenameState(row.ip, row.name ?? '');
  }
  stats = nextStats;
}

async function refreshNow(showMessage = true): Promise<void> {
  if (!backend) {
    return;
  }

  loading = true;

  try {
    await Promise.all([loadHosts(), loadStats()]);

    if (showMessage) {
      setMessage('Data refreshed');
    }
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Refresh failed', true);
  } finally {
    loading = false;
  }
}

$effect(() => {
  statsLoop.setIntervalMs(Math.max(1, pollSeconds) * 1000);
});

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
    hosts = await updateHosts(backend, {
      action: 'add',
      ip,
      name: newHostName.trim(),
    });
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

async function saveHostName(ip: string, draft?: string): Promise<void> {
  if (!backend) {
    return;
  }
  const state = getRenameState(ip);
  if (state.status === 'saving') {
    return;
  }

  const name = (draft ?? state.draft).trim();
  state.draft = name;
  state.status = 'saving';
  state.error = '';

  try {
    await updateHosts(backend, {action: 'update', ip, name});
    await refreshNow(false);
    const savedName = hosts.find((host) => host.ip === ip)?.name ?? name;
    state.original = savedName;
    state.draft = savedName;
    state.status = 'idle';
  } catch (error) {
    state.status = 'error';
    state.error = error instanceof Error ? error.message : 'Update host failed';
    stats = [...stats];
  }
}

function handleRenameKeydown(event: KeyboardEvent): void {
  const input = event.target as HTMLElement;
  const ip = input.dataset.ip;
  if (!ip) {
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    void saveHostName(ip, getRenameState(ip).draft);
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelRename(ip, stats.find((row) => row.ip === ip)?.name ?? '');
  }
}

function handleRenameFocusOut(event: FocusEvent): void {
  const input = event.target as HTMLElement;
  const ip = input.dataset.ip;
  if (!ip) {
    return;
  }
  const state = getRenameState(ip);
  if (state.status === 'editing' || state.status === 'error') {
    void saveHostName(ip, state.draft);
  }
}

async function removeHost(ip: string): Promise<void> {
  if (!backend) {
    return;
  }
  loading = true;
  try {
    await updateHosts(backend, {action: 'remove', ip});
    delete renameStates[ip];
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
  statsLoop.start({immediate: false});
  return () => {
    statsLoop.stop();
  };
});
</script>

<div class="ping-widget">
  <div class="header">
    <h3>Ping Utility</h3>
    <div class="header-actions">
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <mndw-button
        variant="secondary"
        disabled={loading || !hasBackend}
        onclick={() => void refreshNow()}
      >
        Refresh now
      </mndw-button>
    </div>
  </div>

  <div class="controls">
    <mndw-field label="Host IP">
      <mndw-input
        type="text"
        placeholder="Host IP"
        value={newHostIp}
        onmndwinput={(event: CustomEvent<{value: string}>) =>
        newHostIp = event.detail.value}
      ></mndw-input>
    </mndw-field>
    <mndw-field label="Label (optional)">
      <mndw-input
        type="text"
        placeholder="Label (optional)"
        value={newHostName}
        onmndwinput={(event: CustomEvent<{value: string}>) =>
        newHostName = event.detail.value}
      ></mndw-input>
    </mndw-field>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <mndw-button
      variant="primary"
      disabled={loading || !hasBackend}
      onclick={addHost}
    >
      Add
    </mndw-button>
    <mndw-field label="Poll">
      <mndw-input
        type="number"
        min="1"
        max="30"
        step="1"
        value={String(pollSeconds)}
        onmndwinput={(event: CustomEvent<{value: string}>) =>
        pollSeconds = Number(event.detail.value)}
      ><span slot="suffix">s</span></mndw-input>
    </mndw-field>
  </div>

  {#if message}
    <div
      class={`mndw-alert mndw-alert--${isError ? 'danger' : 'info'} message`}
      role={isError ? 'alert' : undefined}
    >
      {message}
    </div>
  {/if}

  <div class="table-wrap">
    <table
      role="grid"
      aria-label="Ping statistics"
    >
      <colgroup>
        <col class="col-host" />
        <col class="col-last" />
        <col class="col-avg" />
        <col class="col-optional col-median" />
        <col class="col-optional col-min" />
        <col class="col-optional col-max" />
        <col class="col-loss" />
        <col class="col-optional col-samples" />
        <col class="col-optional col-updated" />
        <col class="col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th>Host</th>
          <th>Last</th>
          <th>Avg</th>
          <th class="stat-optional">Median</th>
          <th class="stat-optional">Min</th>
          <th class="stat-optional">Max</th>
          <th>Loss</th>
          <th class="stat-optional">Samples</th>
          <th class="stat-optional">Updated</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#if stats.length === 0}
          <tr>
            <td
              colspan="10"
              class="empty"
            >
              No stats yet.
            </td>
          </tr>
        {:else}
          {#each stats as row (row.ip)}
            {@const ip = row.ip}
            {@const state = renameStates[ip]
            ?? createRenameState(row.name ?? '')}
            {@const editing = state.status === 'editing'
            || state.status === 'saving' || state.status === 'error'}
            {@const label = row.name?.trim() ?? ''}
            {@const lossClass = row.lossPercent > 20
            ? 'bad'
            : row.lossPercent > 0
            ? 'warn'
            : 'ok'}
            <tr class="stats-row">
              <td class="host-cell">
                {#if editing}
                  <div class="host-editor">
                    <mndw-input
                      type="text"
                      role="textbox"
                      tabindex="0"
                      aria-label={`Label for ${ip}`}
                      value={state.draft}
                      disabled={state.status === 'saving'}
                      onmndwinput={(event: CustomEvent<{value: string}>) =>
                      getRenameState(ip).draft = event.detail.value}
                      onkeydown={handleRenameKeydown}
                      onfocusout={handleRenameFocusOut}
                      data-ip={ip}
                    ></mndw-input>
                    {#if state.status === 'saving'}
                      <span
                        class="rename-status"
                        role="status"
                      >Saving…</span>
                    {/if}
                    {#if state.status === 'error'}
                      <span
                        class="mndw-badge mndw-badge--danger rename-feedback"
                        role="alert"
                      >{state.error}</span>
                    {/if}
                  </div>
                {:else}
                  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                  <mndw-button
                    variant="ghost"
                    class="host-display"
                    aria-label={`Rename host ${ip}`}
                    onclick={() => beginRename(ip, row.name ?? '')}
                  >
                    {#if label}
                      <span class="host-label">{label}</span><span
                        class="host-address"
                      >{ip}</span>
                    {:else}
                      <span class="host-label">{ip}</span>
                    {/if}
                  </mndw-button>
                {/if}
              </td>
              <td class="stat-value">{formatMs(row.lastMs)}</td>
              <td class="stat-value">{formatMs(row.avgMs)}</td>
              <td class="stat-value stat-optional">{formatMs(row.medianMs)}</td>
              <td class="stat-value stat-optional">{formatMs(row.minMs)}</td>
              <td class="stat-value stat-optional">{formatMs(row.maxMs)}</td>
              <td class="stat-value {lossClass}">
                {row.lossPercent.toFixed(1)}%
              </td>
              <td class="stat-value stat-optional">{row.sampleCount}</td>
              <td class="stat-value stat-optional">
                {formatUpdatedAt(row.updatedAt)}
              </td>
              <td class="actions-cell">
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <mndw-button
                  variant="danger"
                  class="compact"
                  aria-label={`Delete host ${ip}`}
                  disabled={state.status === 'saving'}
                  onclick={() => void removeHost(ip)}
                >Delete</mndw-button>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
</div>

<style>
.ping-widget {
  container-type: inline-size;
  container-name: ping-widget;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr);
  gap: var(--mndw-space-2);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
  padding: var(--mndw-space-3);
  background: var(--mndw-bg);
  color: var(--mndw-text);
  font-family: var(--mndw-font-sans);
  font-size: var(--mndw-text-sm);
  line-height: var(--mndw-leading);
}

.header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--mndw-space-2);
}

h3 {
  min-width: 0;
  margin: 0;
  font-size: var(--mndw-text-lg);
  font-weight: var(--mndw-weight-semibold);
}

.header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: var(--mndw-space-1);
}

.controls {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) auto auto;
  gap: var(--mndw-space-1);
  min-width: 0;
  align-items: center;
}

.controls :global(mndw-field) {
  min-width: 0;
}

.controls :global(mndw-input) {
  display: block;
  width: 100%;
}

.ping-widget :global(mndw-button) {
  flex: 0 0 auto;
  min-height: var(--mndw-control-h);
}

.ping-widget :global(mndw-button)::part(button) {
  font: inherit;
  font-size: var(--mndw-text-xs);
}

.ping-widget :global(mndw-button.compact)::part(button) {
  min-height: 28px;
  padding: 2px 8px;
  font-size: var(--mndw-text-xs);
}

/* Layout only. `.mndw-alert` and its severity modifier own the box and the colours. */
.message {
  max-width: 100%;
  box-sizing: border-box;
  font-size: var(--mndw-text-xs);
  overflow-wrap: anywhere;
}

.table-wrap {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  box-sizing: border-box;
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-lg);
  background: var(--mndw-surface);
  box-shadow: var(--mndw-shadow-1);
}

table {
  width: 100%;
  max-width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: var(--mndw-text-xs);
}

.col-host {
  width: 22%;
}

.col-last,
.col-avg,
.col-median {
  width: 9%;
}

.col-min,
.col-max {
  width: 7%;
}

.col-loss,
.col-samples {
  width: 8%;
}

.col-updated {
  width: 11%;
}

.col-actions {
  width: 10%;
}

thead {
  position: sticky;
  z-index: 1;
  top: 0;
  background: var(--mndw-surface-raised);
}

:global(.ping-widget th),
:global(.ping-widget td) {
  padding: var(--mndw-space-1) var(--mndw-space-2);
  border-bottom: 1px solid var(--mndw-border);
  text-align: left;
  vertical-align: top;
  white-space: normal;
  overflow-wrap: anywhere;
}

:global(.ping-widget th) {
  color: var(--mndw-text);
  font-weight: var(--mndw-weight-semibold);
}

:global(.ping-widget .stats-row:last-child td) {
  border-bottom: 0;
}

:global(.ping-widget .stat-value) {
  white-space: nowrap;
}

:global(.ping-widget .host-cell) {
  min-width: 0;
}

:global(.ping-widget mndw-button.host-display) {
  display: block;
  width: 100%;
  min-width: 0;
  text-align: left;
}

:global(.ping-widget mndw-button.host-display)::part(button) {
  width: 100%;
  justify-content: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--mndw-text);
  font: inherit;
  text-align: left;
}

:global(.ping-widget mndw-button.host-display:hover .host-label) {
  color: var(--mndw-accent-hover);
}

:global(.ping-widget .host-label) {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: var(--mndw-weight-semibold);
}

:global(.ping-widget .host-address) {
  min-width: 0;
  color: var(--mndw-text-subtle);
  font-family: var(--mndw-font-mono);
  font-size: var(--mndw-text-xs);
  overflow-wrap: anywhere;
}

:global(.ping-widget .host-editor) {
  display: grid;
  gap: var(--mndw-space-1);
  min-width: 0;
}

:global(.ping-widget .host-editor mndw-input) {
  width: 100%;
}

:global(.ping-widget .actions-cell) {
  white-space: nowrap;
}

:global(.ping-widget .rename-status) {
  color: var(--mndw-text-subtle);
  font-size: var(--mndw-text-xs);
}

:global(.ping-widget .rename-feedback) {
  overflow-wrap: anywhere;
}

:global(.ping-widget td.ok) {
  color: var(--mndw-success);
}

:global(.ping-widget td.warn) {
  color: var(--mndw-warning);
}

:global(.ping-widget td.bad) {
  color: var(--mndw-danger);
}

:global(.ping-widget .empty) {
  color: var(--mndw-text-subtle);
  font-size: var(--mndw-text-xs);
  font-style: italic;
}

@container ping-widget (max-width: 599px) {
  .col-host {
    width: 42%;
  }

  .col-last {
    width: 15%;
  }

  .col-avg {
    width: 15%;
  }

  .col-loss {
    width: 14%;
  }

  .col-actions {
    width: 14%;
  }

  .ping-widget :global(.col-optional),
  .ping-widget :global(.stat-optional) {
    display: none;
  }
}

@media (max-width: 720px) {
  .controls {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
