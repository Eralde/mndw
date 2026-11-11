<script lang="ts">
import {onMount, tick} from 'svelte';
import type {BackendClient, PluginI18n} from '@mndw/sdk';
import {isBackendMaintenanceClose} from '@mndw/sdk';
import {createTranslator} from '@mndw/sdk/svelte';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {type TerminalInstance, connectToCli, spawnCli} from './cli.service.js';

interface Props {
  backend?: BackendClient;
  i18n: PluginI18n;
  signal?: AbortSignal;
}

let {
  backend,
  i18n,
  signal: externalSignal,
}: Props = $props();
// svelte-ignore state_referenced_locally
const translator = createTranslator(i18n);

function t(key: string, values?: Record<string, unknown>): string {
  return $translator.t(key, values);
}

type PageState = 'idle' | 'starting' | 'connected' | 'error' | 'disconnected';

let state = $state<PageState>('idle');
let errorMessage = $state('');
let errorCode = $state<string | null>(null);
let disconnectReason = $state<'connection-lost' | 'update-ended'>(
  'connection-lost',
);
let consoleChoice = $state<import('./cli.service.js').ConsoleChoice>('router');
let terminalElement = $state<HTMLDivElement | undefined>(undefined);
let terminalInstance: TerminalInstance | null = null;
let activeRun: AbortController | null = null;
let spawnDelayId: ReturnType<typeof setTimeout> | undefined;
let disconnectExpected = false;
const terminalErrorCopy: Record<string, string> = {
  TTYD_NOT_INSTALLED: 'error.ttyd-not-installed',
  TTYD_START_FAILED: 'error.ttyd-start-failed',
  TTYD_UNAVAILABLE: 'error.ttyd-unavailable',
};

function terminalErrorSummary(): string {
  return t(terminalErrorCopy[errorCode ?? ''] ?? 'error.start-failed');
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const onAbort = () => {
      clearSpawnDelay();
      resolve();
    };

    spawnDelayId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      spawnDelayId = undefined;
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, {once: true});
  });
}

function clearSpawnDelay(): void {
  if (!spawnDelayId) {
    return;
  }

  clearTimeout(spawnDelayId);
  spawnDelayId = undefined;
}

function linkAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) {
    return () => {};
  }

  if (source.aborted) {
    target.abort();

    return () => {};
  }

  const onAbort = () => {
    target.abort();
  };

  source.addEventListener('abort', onAbort, {once: true});

  return () => {
    source.removeEventListener('abort', onAbort);
  };
}

function disposeTerminal(): void {
  terminalInstance?.dispose();
  terminalInstance = null;
}

async function startTerminal(): Promise<void> {
  activeRun?.abort();
  clearSpawnDelay();
  disconnectExpected = true;
  disposeTerminal();
  disconnectExpected = false;

  const run = new AbortController();
  const runSignal = run.signal;
  const unlink = linkAbort(externalSignal, run);

  activeRun = run;
  state = 'starting';
  errorMessage = '';
  errorCode = null;

  try {
    if (runSignal.aborted) {
      return;
    }

    if (!backend) {
      throw new Error(t('error.backend-missing'));
    }

    const spawnResult = await spawnCli(backend, consoleChoice, {
      signal: runSignal,
    });

    if (runSignal.aborted) {
      return;
    }

    if (!spawnResult.success) {
      if (spawnResult.cancelled) {
        return;
      }

      errorCode = spawnResult.errorCode ?? null;
      errorMessage = spawnResult.error || t('error.start-failed');
      state = 'error';

      return;
    }

    await delay(1000, runSignal);

    if (runSignal.aborted) {
      return;
    }

    state = 'connected';
    await tick();

    if (runSignal.aborted) {
      return;
    }

    if (!terminalElement) {
      throw new Error('Terminal container is not available');
    }

    terminalInstance = connectToCli(
      backend,
      terminalElement,
      Terminal,
      FitAddon,
      {
        console: consoleChoice,
        onDisconnect: (event) => {
          if (disconnectExpected || runSignal.aborted) {
            return;
          }

          disconnectReason = isBackendMaintenanceClose(event)
            ? 'update-ended'
            : 'connection-lost';
          errorMessage = disconnectReason === 'update-ended'
            ? t('status.update-ended')
            : t('status.connection-lost');
          state = 'disconnected';
        },
      },
    );
    requestAnimationFrame(() => {
      terminalInstance?.fitAddon.fit();
    });
  } catch (error) {
    if (runSignal.aborted) {
      return;
    }

    state = 'error';
    errorCode = null;
    errorMessage = error instanceof Error ? error.message : t('error.unknown');
    console.error('[terminal-page] Failed to start terminal:', error);
  } finally {
    unlink();

    if (activeRun === run) {
      activeRun = null;
    }
  }
}

function stopTerminal(): void {
  disconnectExpected = true;
  activeRun?.abort();
  activeRun = null;
  clearSpawnDelay();
  disposeTerminal();
  state = 'idle';
  disconnectExpected = false;
}

function retryTerminal(): void {
  void startTerminal();
}

function selectConsole(choice: import('./cli.service.js').ConsoleChoice): void {
  consoleChoice = choice;
  void startTerminal();
}

onMount(() => {
  return () => {
    disconnectExpected = true;
    activeRun?.abort();
    activeRun = null;
    clearSpawnDelay();
    disposeTerminal();
  };
});
</script>

<div class="ttyd-terminal">
  <span
    class="sr-only"
    data-testid="l10n-probe"
    hidden
  >{t('l10n.probe')}</span>
  {#if state === 'idle'}
    <div class="screen">
      <div class="console-choice">
        <mndw-button
          variant="primary"
          onclick={() => selectConsole('router')}
        >
          {t('action.router-cli')}
        </mndw-button>
        <mndw-button
          variant="primary"
          onclick={() => selectConsole('entware')}
        >
          {t('action.entware-shell')}
        </mndw-button>
      </div>
    </div>
  {:else if state === 'starting'}
    <div class="screen">
      <div
        class="spinner"
        aria-hidden="true"
      >
      </div>
      <span>{t('status.starting')}</span>
    </div>
  {:else if state === 'error'}
    <div class="screen">
      <div
        class="mndw-alert mndw-alert--danger"
        role="alert"
      >
        {#if errorCode === 'TTYD_NOT_INSTALLED'}
          <span class="terminal-error-detail">{
            t('error.ttyd-not-installed')
          }</span>
          <code>opkg install ttyd</code>
        {:else}
          <strong>{terminalErrorSummary()}</strong>
          <span class="terminal-error-detail">{errorMessage}</span>
        {/if}
      </div>
      <mndw-button
        variant="primary"
        onclick={retryTerminal}
      >
        {t('action.retry')}
      </mndw-button>
    </div>
  {:else if state === 'disconnected'}
    <div class="screen">
      <div
        class="mndw-alert mndw-alert--danger"
        role="alert"
      >
        {
          disconnectReason === 'update-ended'
          ? t('status.update-ended')
          : t('status.connection-lost')
        }
      </div>
      <mndw-button
        variant="primary"
        onclick={retryTerminal}
      >
        {t('action.reconnect')}
      </mndw-button>
    </div>
  {:else}
    <div class="terminal-wrap">
      <div class="terminal-header">
        <span class="status">{t('status.connected')}</span>
        <mndw-button
          variant="secondary"
          onclick={stopTerminal}
        >
          {t('action.disconnect')}
        </mndw-button>
      </div>
      <div
        class="terminal-content"
        bind:this={terminalElement}
      >
      </div>
    </div>
  {/if}
</div>

<style>
.ttyd-terminal {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  contain: layout paint;
  color: #ebedf0;
  background: #13161c;
  font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
}

.screen {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 1rem;
  text-align: center;
}

.ttyd-terminal .mndw-alert--danger {
  display: grid;
  gap: var(--mndw-space-1);
}

.terminal-error-detail {
  overflow-wrap: anywhere;
}

.console-choice {
  display: flex;
  gap: 0.75rem;
}

.ttyd-terminal :global(mndw-button) {
  font-family: inherit;
  font-size: 0.75rem;
}

.terminal-wrap {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  contain: layout paint;
}

.terminal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.625rem;
  background: #1f242d;
  border-bottom: 1px solid #2a3039;
}

.status {
  font-size: 0.6875rem;
  color: #7ee787;
}

.terminal-content {
  flex: 1 1 0%;
  height: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  overflow-anchor: none;
  contain: layout paint;
  box-sizing: border-box;
}

.terminal-content :global(.xterm) {
  width: 100%;
  height: 100%;
}

.terminal-content :global(.xterm),
.terminal-content :global(.xterm-screen),
.terminal-content :global(.xterm-viewport) {
  height: 100%;
}

.terminal-content :global(.xterm-viewport) {
  overflow-anchor: none;
}

.spinner {
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 624.9375rem;
  border: 2px solid #2a3039;
  border-top-color: #2f81f7;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
