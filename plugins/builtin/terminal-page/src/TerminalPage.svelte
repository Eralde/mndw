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

type PageState =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'disconnected';
const TERMINAL_CONNECT_TIMEOUT_MS = 3000;

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
let connectionTimeoutId: ReturnType<typeof setTimeout> | undefined;
let disconnectExpected = false;
const terminalErrorCopy: Record<string, string> = {
  TTYD_NOT_INSTALLED: 'error.ttyd-not-installed',
  TTYD_START_FAILED: 'error.ttyd-start-failed',
  TTYD_UNAVAILABLE: 'error.ttyd-unavailable',
  TERMINAL_CONNECT_TIMEOUT: 'error.connect-timeout',
};

function terminalErrorSummary(): string {
  if (errorCode === 'TERMINAL_CONNECT_TIMEOUT') {
    return t(terminalErrorCopy.TERMINAL_CONNECT_TIMEOUT, {
      seconds: TERMINAL_CONNECT_TIMEOUT_MS / 1000,
    });
  }

  return t(terminalErrorCopy[errorCode ?? ''] ?? 'error.start-failed');
}

function clearConnectionTimeout(): void {
  if (connectionTimeoutId === undefined) {
    return;
  }

  clearTimeout(connectionTimeoutId);
  connectionTimeoutId = undefined;
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
  clearConnectionTimeout();
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
  let connectionTimedOut = false;

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

    state = 'connecting';
    connectionTimeoutId = setTimeout(() => {
      connectionTimeoutId = undefined;
      connectionTimedOut = true;
      errorCode = 'TERMINAL_CONNECT_TIMEOUT';
      errorMessage = '';
      state = 'error';
      run.abort();
      disposeTerminal();
    }, TERMINAL_CONNECT_TIMEOUT_MS);

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
        signal: runSignal,
        onDisconnect: (event) => {
          if (disconnectExpected || runSignal.aborted) {
            return;
          }

          const wasConnecting = state === 'connecting';

          clearConnectionTimeout();
          disconnectReason = isBackendMaintenanceClose(event)
            ? 'update-ended'
            : 'connection-lost';
          errorMessage = disconnectReason === 'update-ended'
            ? t('status.update-ended')
            : t('status.connection-lost');
          state = 'disconnected';

          if (wasConnecting) {
            run.abort();
          }
        },
      },
    );

    await terminalInstance.ready;
    clearConnectionTimeout();

    if (runSignal.aborted) {
      return;
    }

    state = 'connected';
    await tick();

    if (runSignal.aborted) {
      return;
    }

    terminalInstance.activate();
    requestAnimationFrame(() => {
      terminalInstance?.fitAddon.fit();
    });
  } catch (error) {
    if (connectionTimedOut) {
      return;
    }

    if (runSignal.aborted) {
      return;
    }

    state = 'error';
    errorCode = null;
    errorMessage = error instanceof Error ? error.message : t('error.unknown');
    console.error('[terminal-page] Failed to start terminal:', error);
  } finally {
    unlink();

    if (
      activeRun === run && state !== 'connected' && state !== 'disconnected'
    ) {
      activeRun = null;
    }
  }
}

function stopTerminal(): void {
  disconnectExpected = true;
  activeRun?.abort();
  activeRun = null;
  clearConnectionTimeout();
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
    clearConnectionTimeout();
    disposeTerminal();
  };
});
</script>

<div class="ttyd-terminal">
  <div class="console-choice">
    <mndw-button
      variant="primary"
      aria-pressed={consoleChoice === 'router'}
      onclick={() => selectConsole('router')}
    >
      {t('action.router-cli')}
    </mndw-button>
    <mndw-button
      variant="primary"
      aria-pressed={consoleChoice === 'entware'}
      onclick={() => selectConsole('entware')}
    >
      {t('action.entware-shell')}
    </mndw-button>
  </div>
  {#if state === 'idle'}
    <div class="screen"></div>
  {:else if state === 'starting'}
    <div class="screen">
      <div
        class="spinner"
        aria-hidden="true"
      >
      </div>
      <span>{t('status.starting')}</span>
    </div>
  {:else if state === 'connecting' || state === 'connected'}
    <div class="terminal-wrap">
      <div class="terminal-header">
        <span class="status">{#if state === 'connected'}{
              t('status.connected')
            }{/if}</span>
        {#if state === 'connected'}
          <mndw-button
            variant="secondary"
            onclick={stopTerminal}
          >
            {t('action.disconnect')}
          </mndw-button>
        {/if}
      </div>
      <div
        class="terminal-content"
        class:connecting={state === 'connecting'}
      >
        <div
          class="terminal-output"
          bind:this={terminalElement}
          inert={state === 'connecting'}
        >
        </div>
        {#if state === 'connecting'}
          <div
            class="connection-pending"
            role="status"
          >
            <div
              class="spinner"
              aria-hidden="true"
            >
            </div>
            <span>{t('status.connecting')}</span>
          </div>
        {/if}
      </div>
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
          {#if errorMessage}
            <span class="terminal-error-detail">{errorMessage}</span>
          {/if}
        {/if}
      </div>
      <mndw-button
        variant="primary"
        onclick={retryTerminal}
      >
        {t('action.retry')}
      </mndw-button>
    </div>
  {:else}
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
  flex: 1 1 0%;
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
  flex: 0 0 auto;
  padding: 0.5rem 0.625rem;
  background: #1f242d;
  border-bottom: 1px solid #2a3039;
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
  position: relative;
  flex: 1 1 0%;
  height: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  overflow-anchor: none;
  contain: layout paint;
  box-sizing: border-box;
}

.terminal-output {
  position: absolute;
  inset: 0;
}

.terminal-content.connecting :global(.xterm) {
  visibility: hidden;
}

.connection-pending {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
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
