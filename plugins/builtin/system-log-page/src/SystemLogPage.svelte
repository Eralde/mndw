<script lang="ts">
import {onMount, tick} from 'svelte';
import type {Readable} from 'svelte/store';
import {SvelteSet} from 'svelte/reactivity';
import {firstValueFrom} from 'rxjs';
import type {OverlayService, PluginI18n, Translator} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import {openClearConfirmation} from './clear-log-confirmation';
import {ALL_LOG_LEVELS, type FilterState, filterRecords} from './log-filters';
import LogFilters from './LogFilters.svelte';
import LogRow from './LogRow.svelte';
import {createLogReconciler} from './log-reconciler';
import {type DownloadBrowser, downloadLog} from './log-download';
import {isNearBottom, readScrollMetrics} from './log-scroll';
import type {SystemLogApi} from './system-log-api';
import type {NormalizedLogRecord} from './log-types';

interface Props {
  api: SystemLogApi;
  overlay: OverlayService;
  i18n: PluginI18n;
}

let {api, overlay: _overlay, i18n}: Props = $props();
// svelte-ignore state_referenced_locally
const translator: Readable<Translator> = createTranslator(i18n);

function t(key: string, values?: Record<string, unknown>): string {
  return $translator.t(key, values);
}
let records = $state<NormalizedLogRecord[]>([]);
let errorMessage = $state('');
let loading = $state(true);
let filterState = $state<FilterState>({query: '',
  levels: new SvelteSet(ALL_LOG_LEVELS)});
let logViewport = $state<HTMLElement | undefined>(undefined);
let shouldStickToBottom = $state(true);
let reconciler: ReturnType<typeof createLogReconciler> | undefined;
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
  } catch (error) {
    errorMessage = error instanceof Error
      ? error.message
      : 'Log download failed';
  }
}

async function requestClear(): Promise<void> {
  try {
    const result = await openClearConfirmation(_overlay);

    if (result.result?.confirmed !== true) {
      return;
    }

    await firstValueFrom(api.clearLog());
    records = reconciler?.reset() ?? [];
    errorMessage = '';
  } catch (error) {
    errorMessage = error instanceof Error
      ? error.message
      : 'System log clear failed';
  }
}

onMount(() => {
  reconciler = createLogReconciler();
  const stream = api.startLogStream();
  const streamSubscription = stream.data$.subscribe({
    next: (batch) => {
      mergeBatch(reconciler, batch, 'stream');
    },
    error: (error: unknown) => {
      errorMessage = error instanceof Error
        ? error.message
        : 'System log stream failed';
    },
  });
  const snapshotSubscription = api.showLogOnce().subscribe({
    next: (batch) => {
      mergeBatch(reconciler, batch, 'snapshot');
    },
    error: (error: unknown) => {
      errorMessage = error instanceof Error
        ? error.message
        : 'System log snapshot failed';
    },
  });

  return () => {
    streamSubscription.unsubscribe();
    snapshotSubscription.unsubscribe();
    stream.process.abort();
  };
});
</script>

<div
  class="system-log-page"
  data-system-log-page
>
  <header class="system-log-page__header">
    <h1
      class="system-log-page__title"
      data-testid="l10n-probe"
      hidden
    >
      {t('l10n.probe')}
    </h1>
    <div class="system-log-page__header-row">
      <LogFilters
        state={filterState}
        filteredCount={filteredRecords.length}
        totalCount={records.length}
        {translator}
        onChange={(next) => filterState = next}
      />
      <div class="system-log-page__actions">
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
    </div>
  </header>

  {#if errorMessage}
    <p
      class="system-log-page__status system-log-page__status--error"
      role="alert"
    >
      {errorMessage}
    </p>
  {:else if loading}
    <p class="system-log-page__status">{t('status.loading')}</p>
  {/if}

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

.system-log-page__title {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
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

.system-log-page__actions {
  display: flex;
  gap: var(--mndw-space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
  flex: 0 0 auto;
}

.system-log-page__actions mndw-button::part(button) {
  min-height: 1.75rem;
  padding: var(--mndw-space-1) var(--mndw-space-2);
  font-size: var(--mndw-text-xs);
}

.system-log-page__status--error {
  color: var(--mndw-danger);
}

.system-log-page__viewport {
  display: flex;
  flex-direction: column;
  gap: var(--mndw-space-1);
  flex: 1 1 0%;
  min-height: 0;
  overflow: auto;
  padding: var(--mndw-space-3) var(--mndw-space-5) var(--mndw-space-5);
  font-family: var(--mndw-font-mono);
}

@media (max-width: 700px) {
  .system-log-page__header-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .system-log-page__actions {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
