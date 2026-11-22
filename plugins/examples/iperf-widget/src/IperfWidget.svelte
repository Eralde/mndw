<script lang="ts">
import {onMount} from 'svelte';
import type {Translator, WidgetPluginContext} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import FullLayout from './components/FullLayout.svelte';
import LineLayout from './components/LineLayout.svelte';
import MediumLayout from './components/MediumLayout.svelte';
import {formatBitRate} from './model/format.js';
import {type HistoryEntry, pushHistory} from './model/history.js';
import {
  applyServerMessage,
  initialRunState,
  startRun,
  toRunView,
} from './model/run-state.js';
import {
  CUSTOM_SERVER_ID,
  DEFAULT_SETTINGS,
  SERVERS,
  type Settings,
  resolveTarget,
  validateSettings,
} from './model/settings.js';
import {openHistoryDialog} from './services/open-history-dialog.js';
import {openSettingsDialog} from './services/open-settings-dialog.js';
import {type ServerMessage, TestClient} from './services/test-client.js';

const FULL_MIN_HEIGHT = 340;
const MEDIUM_MIN_HEIGHT = 230;
const LINE_RESULTS_BELOW_MIN_HEIGHT = 100;

let {context}: {context: WidgetPluginContext} = $props();
// svelte-ignore state_referenced_locally
const translator = createTranslator(context.i18n);
// svelte-ignore state_referenced_locally
const client = new TestClient(context.backend);
let widgetRoot: HTMLElement;
let contentHeight = $state(FULL_MIN_HEIGHT);
const tier: 'full' | 'medium' | 'line' = $derived(
  contentHeight >= FULL_MIN_HEIGHT
    ? 'full'
    : contentHeight >= MEDIUM_MIN_HEIGHT
    ? 'medium'
    : 'line',
);
let settings = $state<Settings>({...DEFAULT_SETTINGS});
let history = $state<HistoryEntry[]>([]);
let run = $state(initialRunState());
let liveText = $state('');
let lastAnnouncement = Number.NEGATIVE_INFINITY;
const label = (key: string, values?: Record<string, unknown>): string =>
  $translator.t(key, values);
// Keep tile metadata synchronized with locale changes.
$effect(() => {
  context.setTileTitle($translator.t('title'));
});
const selectedServer = $derived(
  SERVERS.find((candidate) => candidate.id === settings.serverId),
);
const serverLabel = $derived(
  settings.serverId === CUSTOM_SERVER_ID
    ? `${settings.customHost}:${settings.customPort}`
    : selectedServer
    ? `${selectedServer.host}:${run.activePort ?? selectedServer.portFrom}`
    : settings.serverId,
);
const stop = (): void => client.stop();
const runView = $derived.by(() =>
  toRunView(run, {
    locale: $translator.locale,
    emptyValue: '—',
    uploadOffsetSeconds: settings.duration,
    label,
    formatPing,
  })
);
const layoutProps = $derived({
  run: runView,
  labels: runView.labels,
  locale: $translator.locale,
  pingPhaseLabel: label('phase.ping'),
  formatPing,
  onStart: start,
  onStop: stop,
});
function announce(): void {
  const now = Date.now();
  if (now - lastAnnouncement < 1000) {
    return;
  }

  lastAnnouncement = now;
  liveText = `${runView.phaseLabel}: ${
    formatBitRate(run.speed, $translator.locale)
  }`;
}

function formatPing(value: number): string {
  return `${$translator.formatNumber(value, {maximumFractionDigits: 1})} ms`;
}

function handleServerMessage(message: ServerMessage): void {
  const now = Date.now();

  run = applyServerMessage(run, message, now);
  if (message.type === 'done') {
    if (run.downloadBps !== null && run.uploadBps !== null) {
      const entry: HistoryEntry = {
        at: now,
        server: `${serverLabel}`,
        pingMs: run.pingMs,
        jitterMs: run.jitterMs,
        downloadBps: run.downloadBps,
        uploadBps: run.uploadBps,
      };
      history = pushHistory(history, entry);
      void context.storage.instance.set('history', JSON.stringify(history));
    }
    return;
  }

  if (message.type !== 'pingSample' && message.type !== 'stopped') {
    announce();
  }
}

function handleConnectionError(): void {
  if (run.status !== 'running') {
    return;
  }

  run = {...run, status: 'error', statusMessage: 'error.connection-lost'};
  announce();
}

function start(): void {
  if (run.status === 'running') {
    return;
  }

  const errors = validateSettings(settings);
  if (Object.keys(errors).length > 0) {
    run = {...run, status: 'error', statusMessage: 'error.invalid-input'};
    return;
  }

  run = startRun(run, Date.now());
  lastAnnouncement = Number.NEGATIVE_INFINITY;
  try {
    client.start(resolveTarget(settings, SERVERS), settings);
  } catch {
    handleConnectionError();
  }
}

function openSettings(): void {
  const translatorSnapshot: Translator = $translator;
  openSettingsDialog(
    context,
    settings,
    translatorSnapshot,
    async (next: Settings): Promise<void> => {
      await context.storage.instance.set('settings', JSON.stringify(next));
      settings = next;
    },
  );
}

async function loadStoredData(): Promise<void> {
  try {
    const [storedSettings, storedHistory] = await Promise.all([
      context.storage.instance.get('settings'),
      context.storage.instance.get('history'),
    ]);
    if (context.signal.aborted) {
      return;
    }

    if (storedSettings) {
      const parsed = JSON.parse(storedSettings) as Partial<Settings>;
      const candidate = {...DEFAULT_SETTINGS, ...parsed};
      if (Object.keys(validateSettings(candidate)).length === 0) {
        settings = candidate;
      }
    }

    if (storedHistory) {
      const parsed = JSON.parse(storedHistory) as unknown;
      if (Array.isArray(parsed)) {
        history = parsed.slice(0, 10) as HistoryEntry[];
      }
    }
  } catch {
    // Invalid browser storage falls back to the built-in defaults.
  }
}

onMount(() => {
  const resizeObserver = new ResizeObserver((entries) => {
    contentHeight = entries[0]?.contentRect.height ?? contentHeight;
  });
  resizeObserver.observe(widgetRoot);

  const unsubscribe = client.subscribe(
    handleServerMessage,
    handleConnectionError,
  );
  void loadStoredData();

  return () => {
    resizeObserver.disconnect();
    unsubscribe();
    client.close();
  };
});
</script>

<section
  bind:this={widgetRoot}
  class="widget"
  class:tier-full={tier === 'full'}
  class:tier-medium={tier === 'medium'}
  class:tier-line={tier === 'line'}
  aria-label={label('title')}
>
  <header class="toolbar">
    <span
      class="server"
      title={serverLabel}
    >{serverLabel}</span>
    <div
      class="toolbar-actions"
      hidden={tier === 'line' && contentHeight < LINE_RESULTS_BELOW_MIN_HEIGHT}
      style:display={tier === 'line' && contentHeight < LINE_RESULTS_BELOW_MIN_HEIGHT
      ? 'none'
      : undefined}
    >
      <mndw-button
        type="button"
        size="sm"
        variant="ghost"
        data-testid="history"
        aria-label={label('action.history')}
        onclick={() => openHistoryDialog(context, history, $translator)}
      >{label('action.history')}</mndw-button>
      <mndw-button
        type="button"
        size="sm"
        variant="ghost"
        data-testid="settings"
        aria-label={label('action.settings')}
        onclick={openSettings}
      ><mndw-icon name="settings"></mndw-icon></mndw-button>
    </div>
  </header>

  {#if tier === 'full'}
    <FullLayout {...layoutProps} />
  {:else if tier === 'medium'}
    <MediumLayout {...layoutProps} />
  {:else}
    <LineLayout
      run={runView}
      labels={runView.labels}
      resultsInline={contentHeight < LINE_RESULTS_BELOW_MIN_HEIGHT}
      onStart={start}
      onStop={stop}
    />
  {/if}
  <p
    class="visually-hidden"
    aria-live="polite"
  >
    {liveText}
  </p>
</section>

<style>
.widget {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  block-size: 100%;
  min-inline-size: 0;
  min-block-size: 0;
  color: var(--mndw-text);
}

.toolbar,
.toolbar-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.toolbar-actions {
  justify-content: end;
}

.toolbar {
  flex: 0 0 auto;
  min-inline-size: 0;
}

.server {
  min-inline-size: 0;
  overflow: hidden;
  color: var(--mndw-text-muted);
  font-size: var(--mndw-text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tier-line {
  gap: 0.25rem;
}

.visually-hidden {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
