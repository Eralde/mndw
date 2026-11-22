<script lang="ts">
import {onMount, tick} from 'svelte';
import type {Readable} from 'svelte/store';
import {SvelteSet} from 'svelte/reactivity';
import {firstValueFrom} from 'rxjs';
import type {
  OverlayService,
  PluginI18n,
  PluginTimers,
  Translator,
} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import {ALL_LOG_LEVELS, type FilterState, filterRecords} from './log-filters';
import LogFilters from './LogFilters.svelte';
import LogRow from './LogRow.svelte';
import {createLogReconciler} from './log-reconciler';
import {
  type LogConnectionState,
  createLogConnectionController,
} from './log-connection';
import {type DownloadBrowser, downloadLog} from './log-download';
import {isNearBottom, readScrollMetrics} from './log-scroll';
import type {SystemLogApi} from './system-log-api';
import type {NormalizedLogRecord} from './log-types';

interface Props {
  api: SystemLogApi;
  overlay: OverlayService;
  i18n: PluginI18n;
  timers: PluginTimers;
}

let {api, overlay: _overlay, i18n, timers}: Props = $props();
// svelte-ignore state_referenced_locally
const translator: Readable<Translator> = createTranslator(i18n);

function t(key: string, values?: Record<string, unknown>): string {
  return $translator.t(key, values);
}
let records = $state<NormalizedLogRecord[]>([]);
let connectionState = $state<'connected' | 'reconnecting' | 'error'>(
  'connected',
);
let reconnectSeconds = $state(0);
let streamError = $state('');
let snapshotError = $state('');
let clearError = $state('');
let downloadError = $state('');
let loading = $state(true);
let filterState = $state<FilterState>({query: '',
  levels: new SvelteSet(ALL_LOG_LEVELS)});
let logViewport = $state<HTMLElement | undefined>(undefined);
let shouldStickToBottom = $state(true);
let reconciler: ReturnType<typeof createLogReconciler> | undefined;
let connection: ReturnType<typeof createLogConnectionController> | undefined;
const filteredRecords = $derived(filterRecords(records, filterState));

function updateStickiness(): void {
  if (logViewport) {
    shouldStickToBottom = isNearBottom(readScrollMetrics(logViewport));
  }
}

function mergeBatch(
  reconciler: ReturnType<typeof createLogReconciler>,
  batch: NormalizedLogRecord[],
  source: 'snapshot' | 'stream',
): void {
  const wasNearBottom = logViewport
    ? isNearBottom(readScrollMetrics(logViewport))
    : true;
  shouldStickToBottom = wasNearBottom;
  records = reconciler.merge(batch, source);
  loading = false;

  if (shouldStickToBottom) {
    void tick().then(() => {
      if (logViewport) {
        logViewport.scrollTo({top: logViewport.scrollHeight});
      }
    });
  }
}

function browserDownload(): DownloadBrowser {
  return {
    createObjectURL: (blob: Blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url: string) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement('a'),
  };
}

function downloadAll(): void {
  try {
    downloadLog(records, browserDownload());
    downloadError = '';
  } catch (error) {
    downloadError = error instanceof Error
      ? error.message
      : 'Log download failed';
  }
}

function reconnectNow(): void {
  connection?.reconnectNow();
}

function connectionAnnouncementText(): string {
  if (connectionState === 'connected') {
    return t('status.connection.connected');
  }

  if (connectionState === 'reconnecting') {
    return t('status.connection.reconnecting');
  }

  return t('status.connection.error');
}

function updateConnectionState(next: LogConnectionState): void {
  connectionState = next.status;
  reconnectSeconds = next.reconnectSeconds;
  streamError = next.streamError;
  snapshotError = next.snapshotError;

  if (snapshotError) {
    loading = false;
  }
}

async function requestClear(): Promise<void> {
  try {
    const confirmed = await _overlay.confirm({
      title: t('confirm.clear-log.title'),
      message: t('confirm.clear-log.question'),
      confirmLabel: t('action.clear'),
      danger: true,
    });

    if (!confirmed) {
      return;
    }

    await firstValueFrom(api.clearLog());
    records = reconciler?.reset() ?? [];
    clearError = '';
  } catch (error) {
    clearError = error instanceof Error
      ? error.message
      : 'System log clear failed';
  }
}

onMount(() => {
  reconciler = createLogReconciler();
  connection = createLogConnectionController({
    api,
    timers,
    onBatch: (batch, source) => {
      if (reconciler) {
        mergeBatch(reconciler, batch, source);
      }
    },
    onState: updateConnectionState,
  });
  connection.start();

  return () => {
    connection?.dispose();
    connection = undefined;
  };
});
</script>

<div
  class="system-log-page"
  data-system-log-page
>
  <header class="system-log-page__header">
    <div class="system-log-page__header-row">
      <LogFilters
        state={filterState}
        filteredCount={filteredRecords.length}
        totalCount={records.length}
        {translator}
        onChange={(next) => filterState = next}
      />
      <div class="system-log-page__actions">
        <div class="system-log-page__actions-row">
          <mndw-button
            data-download-log
            variant="secondary"
            onclick={downloadAll}
          >
            {t('action.download')}
          </mndw-button>
          <mndw-button
            data-clear-log
            variant="danger"
            onclick={requestClear}
          >
            {t('action.clear')}
          </mndw-button>
        </div>
        {#if downloadError}
          <p
            class="system-log-page__action-error"
            role="alert"
          >
            {downloadError}
          </p>
        {/if}
        {#if clearError}
          <p
            class="system-log-page__action-error"
            data-clear-error
            role="alert"
          >
            {t('error.clear', {message: clearError})}
          </p>
        {/if}
      </div>
    </div>
    <div
      class="system-log-page__connection"
      data-connection-status
      data-connection-state={connectionState}
    >
      <span
        data-connection-announcement
        role="status"
      >
        {connectionAnnouncementText()}
      </span>
      {#if streamError}
        <span
          class="system-log-page__connection-error"
          data-connection-error
        >
          {
            t('status.connection.error-detail', {
              message: streamError,
            })
          }
        </span>
      {/if}
      {#if reconnectSeconds > 0}
        <span data-reconnect-countdown>
          {
            t('status.connection.retry-countdown', {
              seconds: reconnectSeconds,
            })
          }
        </span>
      {/if}
      {#if connectionState !== 'connected'}
        <mndw-button
          data-reconnect
          variant="secondary"
          onclick={reconnectNow}
        >
          {t('action.reconnect')}
        </mndw-button>
      {/if}
    </div>
  </header>

  {#if snapshotError}
    <p
      class="system-log-page__status system-log-page__status--error"
      data-snapshot-error
      role="alert"
    >
      {t('error.snapshot', {message: snapshotError})}
    </p>
  {:else if loading}
    <p class="system-log-page__status">{t('status.loading')}</p>
  {/if}

  <!-- Native viewport is intentional fallback until mndw-scroll-area parity covers binding, stickiness, and focus. -->
  <div
    class="system-log-page__viewport"
    data-log-viewport
    role="region"
    aria-label={t('aria.entries')}
    bind:this={logViewport}
    onscroll={updateStickiness}
  >
    {#if filteredRecords.length === 0 && !loading}
      <p class="system-log-page__empty">
        {t('status.empty')}
      </p>
    {:else}
      {#each filteredRecords as record (record.id)}
        <LogRow
          {record}
          query={filterState.query}
        />
      {/each}
    {/if}
  </div>
</div>

<style>
.system-log-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  color: var(--mndw-text);
  background: var(--mndw-bg);
  font-family: var(--mndw-font-sans);
}

.system-log-page__header {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: var(--mndw-space-2) var(--mndw-space-4);
  border-bottom: 1px solid var(--mndw-border);
  background: var(--mndw-bg);
}

p {
  margin: 0;
}

.system-log-page__header-row {
  display: flex;
  align-items: flex-start;
  gap: var(--mndw-space-3);
}

.system-log-page__header-row :global(.log-filters) {
  flex: 1 1 auto;
}

.system-log-page__status,
.system-log-page__empty {
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-sm);
}

.system-log-page__connection {
  display: flex;
  align-items: center;
  gap: var(--mndw-space-2);
  flex-wrap: wrap;
  padding-top: var(--mndw-space-2);
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-xs);
}

.system-log-page__connection-error {
  min-width: 0;
  overflow-wrap: anywhere;
}

.system-log-page__connection[data-connection-state='error'] {
  color: var(--mndw-danger);
}

.system-log-page__actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--mndw-space-1);
  flex: 0 0 auto;
}

.system-log-page__actions-row {
  display: flex;
  gap: var(--mndw-space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}

.system-log-page__actions-row mndw-button::part(button),
.system-log-page__connection mndw-button::part(button) {
  min-height: 1.75rem;
  padding: var(--mndw-space-1) var(--mndw-space-2);
  font-size: var(--mndw-text-xs);
}

.system-log-page__status--error,
.system-log-page__action-error {
  color: var(--mndw-danger);
}

.system-log-page__action-error {
  max-width: 22rem;
  font-size: var(--mndw-text-xs);
  text-align: right;
}

.system-log-page__viewport {
  display: flex;
  flex-direction: column;
  gap: var(--mndw-space-1);
  flex: 1 1 0%;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--mndw-scrollbar-thumb) var(--mndw-scrollbar-track);
  padding: var(--mndw-space-3) var(--mndw-space-5) var(--mndw-space-5);
  font-family: var(--mndw-font-mono);
}

.system-log-page__viewport::-webkit-scrollbar {
  width: var(--mndw-scrollbar-size);
  height: var(--mndw-scrollbar-size);
}

.system-log-page__viewport::-webkit-scrollbar-track {
  background: var(--mndw-scrollbar-track);
}

.system-log-page__viewport::-webkit-scrollbar-thumb {
  border: var(--mndw-focus-w) solid var(--mndw-scrollbar-track);
  border-radius: var(--mndw-scrollbar-radius);
  background: var(--mndw-scrollbar-thumb);
}

.system-log-page__viewport::-webkit-scrollbar-thumb:hover {
  background: var(--mndw-scrollbar-thumb-hover);
}

.system-log-page__viewport::-webkit-scrollbar-corner {
  background: var(--mndw-scrollbar-track);
}

@media (max-width: 700px) {
  .system-log-page__header-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .system-log-page__actions {
    width: 100%;
    justify-content: flex-start;
    align-items: flex-start;
  }

  .system-log-page__actions-row {
    justify-content: flex-start;
  }

  .system-log-page__action-error {
    text-align: left;
  }
}
</style>
