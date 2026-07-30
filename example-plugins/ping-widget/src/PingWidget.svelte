<script lang="ts">
import {onMount} from 'svelte';
import type {BackendClient} from '@mndw/sdk';
import {
  type DaemonAction,
  type Host,
  type HostStats,
  controlDaemon,
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
type DaemonUiAction = 'idle' | DaemonAction | 'restart';

let daemonAction = $state<DaemonUiAction>('idle');
const daemonBusy = $derived(daemonAction !== 'idle');

const renameStates = $state<Record<string, RenameState>>({});
let statsIntervalId: ReturnType<typeof setInterval> | undefined;

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

async function runDaemonAction(
  action: Exclude<DaemonUiAction, 'idle'>,
): Promise<void> {
  if (!backend || daemonBusy) {
    return;
  }

  daemonAction = action;

  try {
    if (action === 'restart') {
      await controlDaemon(backend, 'stop');
      await controlDaemon(backend, 'start');
    } else {
      await controlDaemon(backend, action);
    }

    setMessage(
      action === 'restart'
        ? 'Daemon restarted'
        : `Daemon ${action === 'start' ? 'started' : 'stopped'}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Request failed';
    setMessage(`Daemon ${action} failed: ${detail}`, true);
  } finally {
    daemonAction = 'idle';
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
  }
}

const htmlEscapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => htmlEscapes[character] ?? character,
  );
}

function renderHostCell(row: HostStats, state: RenameState): string {
  const label = row.name?.trim() ?? '';
  const display = label
    ? `<span class="host-label">${
      escapeHtml(label)
    }</span><span class="host-address">${escapeHtml(row.ip)}</span>`
    : `<span class="host-label">${escapeHtml(row.ip)}</span>`;

  if (
    state.status === 'editing' || state.status === 'saving'
    || state.status === 'error'
  ) {
    const inputDisabled = state.status === 'saving' ? ' disabled' : '';
    const feedback = state.status === 'saving'
      ? '<span class="rename-status" role="status">Saving…</span>'
      : state.status === 'error'
      // Inline feedback beside an input inside a table cell, so this is a badge rather than a
      // block alert — the class layer's inline severity form.
      ? `<span class="mndw-badge mndw-badge--danger rename-feedback" role="alert">${
        escapeHtml(state.error)
      }</span>`
      : '';

    return `<div class="host-editor">
      <input type="text" aria-label="Label for ${escapeHtml(row.ip)}" value="${
      escapeHtml(state.draft)
    }"${inputDisabled} data-host-input="${escapeHtml(row.ip)}">
      ${feedback}
    </div>`;
  }

  return `<button type="button" class="host-display" aria-label="Rename host ${
    escapeHtml(row.ip)
  }" data-host-action="rename" data-host-ip="${
    escapeHtml(row.ip)
  }">${display}</button>`;
}

function renderActionsCell(row: HostStats, state: RenameState): string {
  const disabled = state.status === 'saving' ? ' disabled' : '';

  return `<button type="button" class="btn danger compact" aria-label="Delete host ${
    escapeHtml(row.ip)
  }" data-host-action="remove" data-host-ip="${
    escapeHtml(row.ip)
  }"${disabled}>Delete</button>`;
}

function renderStatsBody(
  rows: HostStats[],
  states: Record<string, RenameState>,
): string {
  if (rows.length === 0) {
    return '<tr><td colspan="10" class="empty">No stats yet.</td></tr>';
  }

  return rows.map((row) => {
    const state = states[row.ip] ?? createRenameState(row.name ?? '');
    const lossClass = row.lossPercent > 20
      ? 'bad'
      : row.lossPercent > 0
      ? 'warn'
      : 'ok';

    return `<tr class="stats-row">
      <td class="host-cell">${renderHostCell(row, state)}</td>
      <td class="stat-value">${escapeHtml(formatMs(row.lastMs))}</td>
      <td class="stat-value">${escapeHtml(formatMs(row.avgMs))}</td>
      <td class="stat-value stat-optional">${
      escapeHtml(formatMs(row.medianMs))
    }</td>
      <td class="stat-value stat-optional">${
      escapeHtml(formatMs(row.minMs))
    }</td>
      <td class="stat-value stat-optional">${
      escapeHtml(formatMs(row.maxMs))
    }</td>
      <td class="stat-value ${lossClass}">${
      escapeHtml(`${row.lossPercent.toFixed(1)}%`)
    }</td>
      <td class="stat-value stat-optional">${
      escapeHtml(String(row.sampleCount))
    }</td>
      <td class="stat-value stat-optional">${
      escapeHtml(formatUpdatedAt(row.updatedAt))
    }</td>
      <td class="actions-cell">${renderActionsCell(row, state)}</td>
    </tr>`;
  }).join('');
}

function tableTarget(event: Event): HTMLElement | null {
  return event.target instanceof HTMLElement ? event.target : null;
}

function tableIp(target: HTMLElement): string | undefined {
  return target.closest<HTMLElement>('[data-host-ip]')?.dataset.hostIp;
}

function handleTableClick(event: MouseEvent): void {
  const target = tableTarget(event);
  const action = target?.closest<HTMLElement>('[data-host-action]')?.dataset
    .hostAction;
  const ip = target ? tableIp(target) : undefined;
  if (!action || !ip) {
    return;
  }

  if (action === 'rename') {
    const row = stats.find((item) => item.ip === ip);
    beginRename(ip, row?.name ?? '');
  }
  if (action === 'remove') {
    void removeHost(ip);
  }
}

function handleTableKeydown(event: KeyboardEvent): void {
  const target = tableTarget(event);
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  const ip = target.dataset.hostInput;
  if (!ip) {
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    void saveHostName(ip, target.value);
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelRename(ip, stats.find((row) => row.ip === ip)?.name ?? '');
  }
}

function handleTableFocusOut(event: FocusEvent): void {
  const target = tableTarget(event);
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  const ip = target.dataset.hostInput;
  if (!ip) {
    return;
  }

  const state = getRenameState(ip);
  if (state.status === 'editing' || state.status === 'error') {
    void saveHostName(ip, target.value);
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
        class="btn primary"
        aria-label="Start daemon"
        disabled={loading || daemonBusy || !hasBackend}
        onclick={() => void runDaemonAction('start')}
      >
        Start
      </button>
      <button
        type="button"
        class="btn secondary"
        aria-label="Stop daemon"
        disabled={loading || daemonBusy || !hasBackend}
        onclick={() => void runDaemonAction('stop')}
      >
        Stop
      </button>
      <button
        type="button"
        class="btn secondary"
        aria-label="Restart daemon"
        disabled={loading || daemonBusy || !hasBackend}
        onclick={() => void runDaemonAction('restart')}
      >
        Restart
      </button>
      <button
        type="button"
        class="btn secondary"
        disabled={loading || !hasBackend}
        onclick={() => void refreshNow()}
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
      onclick={handleTableClick}
      onkeydown={handleTableKeydown}
      onfocusout={handleTableFocusOut}
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
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderStatsBody escapes every interpolated value -->
        {@html renderStatsBody(stats, renameStates)}
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

.controls label {
  display: flex;
  align-items: center;
  gap: var(--mndw-space-1);
  min-width: 0;
  color: var(--mndw-text-subtle);
  font-size: var(--mndw-text-xs);
}

.ping-widget :global(input) {
  min-width: 0;
  max-width: 100%;
  min-height: var(--mndw-control-h);
  box-sizing: border-box;
  padding: var(--mndw-space-1) var(--mndw-space-2);
  border: 1px solid var(--mndw-border);
  border-radius: var(--mndw-radius-md);
  background: var(--mndw-surface);
  color: var(--mndw-text);
  font: inherit;
}

.ping-widget :global(input:focus-visible),
.ping-widget :global(button:focus-visible) {
  outline: 2px solid var(--mndw-accent-hover);
  outline-offset: 1px;
}

.ping-widget :global(.btn) {
  min-height: var(--mndw-control-h);
  box-sizing: border-box;
  padding: var(--mndw-space-1) var(--mndw-space-2);
  border: 0;
  border-radius: var(--mndw-radius-md);
  cursor: pointer;
  font: inherit;
  font-size: var(--mndw-text-xs);
  transition: transform 120ms ease;
}

.ping-widget :global(.btn:disabled) {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

.ping-widget :global(.btn:not(:disabled):hover) {
  transform: translateY(-1px);
}

.ping-widget :global(.btn.primary) {
  background: var(--mndw-accent);
  color: var(--mndw-accent-contrast);
}

.ping-widget :global(.btn.primary:not(:disabled):hover) {
  background: var(--mndw-accent-hover);
}

.ping-widget :global(.btn.secondary) {
  background: var(--mndw-surface-raised);
  color: var(--mndw-text);
}

.ping-widget :global(.btn.danger) {
  background: var(--mndw-danger);
  color: var(--mndw-accent-contrast);
}

.ping-widget :global(.btn.compact) {
  min-height: var(--mndw-control-h);
  padding-inline: var(--mndw-space-2);
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

:global(.ping-widget .host-display) {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--mndw-text);
  cursor: pointer;
  font: inherit;
  text-align: left;
}

:global(.ping-widget .host-display:hover .host-label) {
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

:global(.ping-widget .host-editor input) {
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
